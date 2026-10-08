# Architecture

Serverless newsletter pipeline: an author emails `newsletter@yourdomain.com`
(optionally with attachments). Cloudflare Email Routing triggers an Ingest
Worker, which stores attachments in R2, persists the campaign in D1, and
fans out recipient batches via Cloudflare Queues. A Consumer Worker builds
the per-recipient MIME (with attachments + tracking pixel + signed click
links) and sends it through the `SEND_EMAIL` Email Sending (beta) binding.
Bounces, opens, clicks, downloads and unsubscribes are logged to D1, with
raw archives in R2.

## Architecture overview

```
Author ──▶ Email Routing ──▶ Ingest Worker (Email handler)
                                  │
                                  ├── Auth check (allowed sender, SPF/DKIM)
                                  ├── Parse MIME (postal-mime): subject, html, text, attachments
                                  ├── Validate + store attachments in R2
                                  ├── Insert campaign + attachment rows in D1
                                  └── Enqueue subscriber batches ──▶ Cloudflare Queue
                                                                          │
                                                                          ▼
                                                                    Consumer Worker
                                                                          │
                                                                ┌─────────┼──────────┐
                                                                ▼         ▼          ▼
                                                          SEND_EMAIL   D1 logs   Tracking
                                                          (MIME w/     (sends)   pixel/links
                                                           attachments)              │
                                                                                     ▼
                                                                              Tracker Worker
                                                                              (HTTP) → D1/R2
                                  ▲
                                  │
                       Bounces ───┘ (Email Routing → Bounce Worker → D1)

                       Cron ─────▶ Cleanup Worker (R2 + D1 retention)
```

## Components

| Worker      | Type           | Purpose                                                        |
| ----------- | -------------- | -------------------------------------------------------------- |
| `ingest`    | Email handler  | Parse inbound mail, store attachments to R2, enqueue batches   |
| `consumer`  | Queue consumer | Build MIME per recipient, send via `SEND_EMAIL`, log to D1     |
| `tracker`   | HTTP           | Pixel, signed click redirect, unsubscribe, attachment download |
| `bounce`    | Email+Cron     | One-click email unsubscribe; GraphQL delivery-failure sync     |
| `cleanup`   | Cron Trigger   | Retention: prune R2 + D1                                       |
| `admin`     | HTTP + SPA     | JSON API + GUI: newsletters, subscribers, authors, campaigns, bounces |

## D1 schema — `cf-newsletter-db`

The system is **multi-tenant**: a `newsletters` row is the parent of its own
authors, subscribers and campaigns (all scoped by `newsletter_id`).

- `newsletters(id, name, inbound_address UNIQUE, from_address NULL, footer_html NULL, footer_text NULL, slug UNIQUE NULL, allow_public_signup, enabled, created_at)` — `footer_*` override the global `DEFAULT_FOOTER_*` per newsletter; `slug` + `allow_public_signup` back the public subscribe page (`/subscribe/<slug>`).
- `authors(newsletter_id, email, name, created_at, PRIMARY KEY(newsletter_id, email))` — per-newsletter inbound-sender allow-list.
- `subscribers(id, newsletter_id, email, name, verified, status, subscribed_at, unsubscribed_at, bounce_count, last_bounce_at, token, confirm_token NULL, UNIQUE(newsletter_id, email))` — `token` authenticates unsubscribe links; `confirm_token` is the pending double opt-in flag (cleared on confirmation).
- `campaigns(id, newsletter_id, subject, html, text, sent_by, created_at, status, total_recipients, sent_count, failed_count, attachment_count, attachment_total_bytes, link_mode)`
- `attachments(id, campaign_id, r2_key, filename, content_type, size, sha256, content_id NULL, disposition ['attachment'|'inline'], created_at)`
- `sends(id, campaign_id, subscriber_id, status, queued_at, sent_at, error, message_id, UNIQUE(campaign_id, subscriber_id))`
- `events(id, campaign_id, subscriber_id, type ['open'|'click'|'bounce'|'complaint'|'unsubscribe'|'download'], attachment_id NULL, url, ts, ua, ip)`
- `admins(email PK, role ['super_admin'|'admin'], capability ['read_only'|'edit'], theme ['light'|'dark'], created_at, updated_at)` — console operators' role and saved UI preferences; identity itself comes from Cloudflare Access.
- `admins_newsletters(email, newsletter_id, PRIMARY KEY(email, newsletter_id))` — which newsletters each (non-super) admin may manage.
- `logs(id, ts, level, source, event, campaign_id, newsletter_id, message, detail)` — pipeline activity log surfaced on the Analytics page.
- `settings(key PK, value, updated_at)` — runtime configuration overrides edited from the Settings page.
- `warmup_state(id=1, level, week_started_at, daily_cap, daily_cap_date, updated_at)` — singleton demand-driven warmup progression + cached daily quota.
- Indexes: `subscribers(status)`, `subscribers(newsletter_id)`, `campaigns(newsletter_id)`, `sends(campaign_id, status)`, `events(campaign_id, type)`, `attachments(campaign_id)`, `logs(ts)`, `logs(campaign_id)`.
- Cascades: deleting a newsletter removes its authors/subscribers/campaigns; deleting a campaign removes its attachments/sends/events (`ON DELETE CASCADE`).

## Queue — `cf-newsletter-queue`

- Message: `{ campaignId, batch: [{subscriberId, email, name, token}] }` — recipients only; attachments referenced by `campaignId` (avoids 128 KB message limit).
- Consumer: `max_batch_size: 10`, `max_concurrency: 5`, `max_retries: 3`, DLQ → `cf-newsletter-dlq`.

## R2 storage

### `cf-newsletter-archive`

- `campaigns/<id>/raw.eml` — original inbound MIME.
- `campaigns/<id>/attachments/<sha256>` — deduped attachment bytes (metadata: filename, contentType, size, contentId).
- `events/<yyyy-mm-dd>.ndjson` — long-term raw event log.

### `cf-newsletter-admin`

Static media lives in the `cf-newsletter-admin` R2 bucket, bound as `ASSETS_R2`
and served read-only under `/media/*`. The `/media/` prefix avoids colliding
with the Vite-built SPA bundle. Because the whole worker sits behind Access,
these objects are only reachable by authenticated operators. The bucket is
bound by the hosted installer using the bucket's existing jurisdiction.
For an EU-jurisdiction bucket, upload a file with (note the **`--remote`**
flag — wrangler v4's `r2 object` commands default to the *local* simulator
and will silently not touch the production bucket without it):

```bash
wrangler r2 object put cf-newsletter-admin/header.png \
  --jurisdiction eu --remote --file ./header.png --content-type image/png
```

## Workers

### `ingest-worker` (Email Worker)

- `email(message, env, ctx)` handler.
- Verify sender exists in the D1 `authors` table (managed via the admin worker); require `Authentication-Results` SPF=pass, DKIM=pass.
- Parse with `postal-mime` → subject, html, text, `attachments[]`.
- **Attachment handling**:
  - Validate count ≤ `MAX_ATTACHMENT_COUNT`, per-file ≤ `MAX_ATTACHMENT_BYTES`, total ≤ `MAX_TOTAL_ATTACHMENT_BYTES`.
  - Enforce `ALLOWED_MIME`; reject `BLOCKED_EXTENSIONS` and dangerous magic bytes.
  - Sanitize filenames; compute `sha256`; dedupe by hash.
  - Upload to R2 `campaigns/<id>/attachments/<sha256>` with metadata.
  - If total raw size > `ATTACHMENT_LINK_THRESHOLD_BYTES`, switch to **link mode**: rewrite HTML to signed download URLs served by Tracker Worker; do not attach.
- Insert `campaigns` (status=`sending`) and `attachments` rows.
- Stream active subscribers in pages, chunk into batches of `BATCH_SIZE`, `env.QUEUE.send(...)`.
- Reply NDR via `message.setReject` if unauthorized or oversized.
- Bindings: `DB`, `QUEUE`, `ARCHIVE`, vars `BATCH_SIZE`, attachment limits.

### `consumer-worker` (Queue consumer)

- `queue(batch, env)` handler.
- On batch start: load campaign + `attachments` rows; pull bytes from R2 once into an in-memory `Map<sha256, Uint8Array>` (cached for the batch lifetime).
- For each recipient build MIME with the in-house builder (`shared/mime.ts`):
  - `multipart/mixed`
    - `multipart/related` (HTML + inline images via `cid:<content_id>`)
      - `multipart/alternative` (text + html with tracking pixel + signed click links)
    - One `attachment` part per non-inline file: base64, `Content-Disposition: attachment; filename="..."`, correct `Content-Type`.
  - Headers: `From`, `To`, `Subject`, `Message-ID`, `List-Unsubscribe`, `List-Unsubscribe-Post: List-Unsubscribe=One-Click`.
- Pre-flight size guard: reject batch early if total MIME (×1.34 base64 overhead) exceeds `MAX_RAW_BYTES`.
- `await env.SEND_EMAIL.send(new EmailMessage(from, to, raw))`.
- On success → update `sends`, increment `campaigns.sent_count`.
- On error → log to `sends`; `msg.ack()` for permanent failures, `msg.retry()` for transient; exhausted retries flow to DLQ.
- Bindings: `DB`, `ARCHIVE`, `SEND_EMAIL`, vars `FROM_ADDRESS`, `TRACKING_BASE_URL`, `BASE_DOMAIN`.

### `tracker-worker` (HTTP Worker)

- `GET /o/:campaign/:sub.gif` → log open, return 1×1 GIF.
- `GET /c/:campaign/:sub?u=<encoded>&sig=...` → verify HMAC, log click, 302.
- `GET /u/:sub?t=<token>` → unsubscribe page; `POST /u/:sub` → one-click unsubscribe (`List-Unsubscribe-Post`).
- `GET /a/:campaign/:sub/:attId?sig=...` → verify HMAC, stream attachment from R2 (link-mode), log `events(type='download', attachment_id)`.
- `GET|POST /subscribe/:slug` → hosted double opt-in signup form (Turnstile-protected); sends the confirmation email via `SEND_EMAIL`.
- `GET /verify/:sub?t=<confirm_token>` → confirm a pending public signup.
- Bindings: `DB`, `ARCHIVE`, optional `SEND_EMAIL`, secrets `LINK_SIGNING_KEY`, `ATTACHMENT_SIGNING_KEY`, optional `TURNSTILE_SECRET_KEY`.

### `bounce-worker` (Email + Cron Worker)

- `email` handler: processes `List-Unsubscribe` mailto replies (`unsubscribe+<id>@`) — marks subscriber unsubscribed and inserts an unsubscribe event.
- `scheduled` handler: queries the Cloudflare Email Sending GraphQL API for delivery failures in the last 25 hours; classifies hard/soft; updates subscriber bounce counters; marks `bounced` after threshold; inserts `events(type='bounce')`.

### `cleanup-worker` (Cron Trigger)

- Daily: delete R2 attachments and `attachments`/`campaigns` rows older than `RETENTION_DAYS` (cascade prunes `sends`/`events`).

### `admin-worker` (HTTP + SPA)

- Serves the React admin GUI and a JSON API under `/api/*`.
- **Auth via Cloudflare Access** (no bearer token): trusts the
  `Cf-Access-Authenticated-User-Email` header injected at the edge; any
  `/api/*` request without it gets 401.
- Endpoints: newsletter CRUD (with Email Routing rule sync), per-newsletter
  subscriber CRUD + CSV import/export, author allow-list CRUD, campaign list +
  stats, bounces, Email Sending usage + warmup (`/api/email-sending-stats`),
  identity (`/api/me`) and the operator's theme preference
  (`PUT /api/preferences`).

## Admin GUI

The `admin` worker exposes a JSON API under `/api/*` and serves a Vite +
React SPA from the same origin via the `[assets]` binding. Authentication
is delegated entirely to **Cloudflare Access** in front of the worker. The SPA
picks up the user's identity from the `Cf-Access-Authenticated-User-Email`
header that the edge injects. The worker rejects any `/api/*` request that is
missing that header. There is no shared bearer token.

Pages:

- **Dashboard** — subscriber/campaign/event totals, last-7-day rollup.
- **Newsletters** — create/rename/delete newsletters (each with its own inbound
  address, subscribers and authors); sortable, searchable list. Email Routing
  rules are kept in sync automatically. Each newsletter has tabs for:
  - **Subscribers** — paginated, sortable search; add manually; CSV import
    (position-based, with duplicate detection) and CSV export; tracks a
    `verified` flag and delivery `status`.
  - **Authors** — manage the allow-list of inbound senders.
  - **Admins** — assign per-newsletter admins and their read-only/edit capability.
  - **Signup** — enable the hosted public subscribe page (double opt-in via
    Turnstile), set the URL slug, and copy the embed snippet.
  - **Email footer** — per-newsletter HTML/text footer with live preview.
- **Campaigns** — list and per-campaign drill-down with stacked event chart and per-recipient `sends` table.
- **Bounces** — last 7 days, status code colour-coded.
- **Analytics** (Logs) — merged pipeline log + engagement event stream, filterable by source/level.
- **Settings** (super admin) — runtime configuration grouped by tab (Access,
  Email sending, Tracking & signup, Attachments, Retention, etc.), the
  **Super admins** tab, and a live **Sending usage** panel (daily quota, emails
  sent, warmup week and weekly progression).
- **Help** — the rendered help document (`help.md`, served from R2).

**Roles:** *super admins* have full access including Settings; *admins* are
scoped to their assigned newsletters with either *read-only* or *edit*
capability. Identity comes from Cloudflare Access; the first user to sign in to
an empty `admins` table is bootstrapped as super admin.

Each operator's **theme** (light/dark) is saved server-side in the `admins`
table and follows them across devices; new operators are seeded with their OS
colour-scheme preference on first login (`GET /api/me` returns it,
`PUT /api/preferences` updates it).

For local UI development, run `cd web && npm run dev` (Vite proxies `/api/*`
to `localhost:8787`, which requires a separate running admin API).

## Runtime configuration

Runtime settings resolve from the D1 `settings` table to built-in defaults in
`shared/settings.ts` and are editable from the console's **Settings** page. They
cover sending identity, footers, tracking, signup, attachment limits, warmup,
retention and bounce handling.

## Repository layout

```
newsletter/
├── README.md
├── package.json
├── docs/
│   ├── architecture.md
│   └── help.md
├── workers/
│   ├── ingest/      (src/index.ts)
│   ├── consumer/
│   ├── tracker/
│   ├── bounce/
│   ├── cleanup/
│   └── admin/
├── shared/
│   ├── mime.ts                   # multipart/mixed+related builder w/ attachments
│   ├── attachments.ts            # validation, hashing, R2 helpers
│   ├── tracking.ts               # HMAC link signing + pixel/link rewriting
│   ├── db.ts                     # D1 helpers
│   ├── settings.ts               # runtime config keys + defaults + resolver
│   ├── footer.ts                 # footer tokens + HTML sanitizer
│   ├── quota.ts                  # Cloudflare daily sending quota fetch
│   ├── warmup.ts                 # demand-driven warmup state machine
│   └── types.ts
└── db/
    ├── schema.sql
    └── reset.sql
```

## Key flows

**Send**: Author email → Ingest verifies/parses, stores attachments in R2, writes D1 → batches enqueued → Consumer loads attachments once, builds MIME per recipient, sends via `SEND_EMAIL` → `sends` updated.

**Open / click / download**: Tracker Worker logs to `events`; downloads stream from R2 with HMAC-signed URLs.

**Bounce**: Bounce Worker cron queries Cloudflare GraphQL API → subscriber + `events` updated.

**Public signup**: `GET /subscribe/<slug>` (Turnstile) → pending subscriber +
confirmation email → `GET /verify/<id>?t=` confirms (double opt-in) before any
mail is sent.

**Unsubscribe**: One-click `POST /u/:sub` (HMAC token) or `mailto:unsubscribe+<id>@` → `subscribers.status='unsubscribed'`.

**Retention**: Cleanup Worker (cron) prunes R2 + D1 per `RETENTION_DAYS`.

## Warmup schedule

To preserve sending reputation, the consumer worker throttles sending against
two caps (the smaller binds). Warmup is **always on** and **demand-driven** —
there is no start date.

- **Weekly cap** — a stepped schedule, the active step being the warmup
  `level`: `[500, 1500, 5000, 12000, 25000, 40000]` then `WARMUP_TARGET_WEEKLY`
  (50,000) steady state.
- **Daily cap** — the account's resolved daily quota, read live from the
  Cloudflare Email Sending API (`GET /accounts/{id}/email/sending/limits`) once
  per UTC day by the consumer and cached in `warmup_state`. Falls back to
  `WARMUP_FALLBACK_DAILY_CAP` when the API can't be read.

**Demand-driven progression** (state in the `warmup_state` table):

- Warmup enters **week 0** the first time *demand* exceeds 499, where demand =
  emails still to send across active campaigns
  (`Σ max(total_recipients − sent_count − failed_count, 0)`).
- Each 7-day window it advances **at most one level**, and **only when demand
  has grown to the next level's weekly cap** (the threshold to enter week _N_
  is `schedule[N]`). Otherwise it stays put. Levels never decrease. This avoids
  the old calendar model's idle weeks and never ramps faster than real volume.

Example (continuous 100K backlog): week0 500 → week1 1,500 → … → week5 40,000 →
week6 50,000/wk, climbing one step per week. A small 3K campaign starts at
week 0, advances to week 1 (1,500), then stays because demand never reaches the
week-2 threshold (5,000).

**Enforcement**: at the start of each `queue()` invocation the consumer reads
the warmup state, refreshes the daily cap (once per UTC day), computes demand
and the progression, then counts `sends` since the daily (UTC midnight) and
weekly (`week_started_at`) window starts. Each message sends in full, sends a
partial slice and re-enqueues the overflow with `delaySeconds`, or `msg.retry`s
when the cap is exhausted. Cloudflare Queues caps `delaySeconds` at 12 h, so
longer waits are achieved by repeated retries.

**Configuration** (settings resolved from the D1 `settings` table → built-in
defaults in `shared/settings.ts`; edit on the console's **Settings** page):

| Var                          | Default                              | Meaning                                                       |
| ---------------------------- | ------------------------------------ | ------------------------------------------------------------- |
| `WARMUP_TARGET_WEEKLY`       | `50000`                              | Steady-state weekly cap once the schedule is exhausted.       |
| `WARMUP_SCHEDULE`            | `[500,1500,5000,12000,25000,40000]`  | Per-level weekly caps; each value is also the entry threshold.|
| `WARMUP_FALLBACK_DAILY_CAP`  | `1000`                               | Daily cap used only when the live API quota can't be read.    |

When live quota access is configured, the consumer reads the daily quota;
otherwise the fallback cap applies.

**Visibility**: the console's **Settings → Email sending → Sending usage** panel
shows the live daily quota, emails sent, the current warmup week, and the full
weekly progression (read-only), backed by `GET /api/email-sending-stats`.

## Implementation notes

- Queue messages carry recipient batches only; attachments are referenced by
  `campaignId` and pulled once per batch from R2 to stay under the 128 KB queue
  message limit.
- If total raw size exceeds `ATTACHMENT_LINK_THRESHOLD_BYTES`, the ingest worker
  switches to **link mode** and rewrites the HTML to use signed download URLs
  served by the tracker worker.
