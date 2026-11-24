# Worker Deep Dives

Detailed walkthrough of every worker: what it does, why, and how it
interacts with the rest of the system.

## Ingest Worker

`workers/ingest/src/index.ts`

### Purpose

The entry point of the whole pipeline. The author writes an email to
`newsletter@yourdomain.com` and Cloudflare Email Routing hands the message
to this worker's `email()` handler. Its job is to: authenticate the sender,
parse the MIME, validate and persist any attachments, and fan the recipient
list out to the queue. Anything it accepts becomes a campaign that *will*
be sent — so this is the security boundary of the system.

### Step by step

**1. Read and parse the raw MIME** with `postal-mime` to get the `From:`
address, subject, html, text, and `attachments[]` (each with filename,
mimeType, bytes, contentId, and `disposition: 'attachment' | 'inline'`).

**2. Authenticate the author.**

```ts
const from = parsed.from?.address?.toLowerCase() ?? '';
const row = await env.DB
  .prepare('SELECT 1 AS ok FROM authors WHERE newsletter_id = ? AND email = ? LIMIT 1')
  .bind(newsletterId, from)
  .first();
if (!row) { message.setReject('Sender not authorized for this newsletter'); return; }
const auth = verifyAuthorAuthentication(raw, from); // shared/sender-auth.ts
if (!auth.ok) { message.setReject('Sender could not be authenticated …'); return; }
```

Two gates, both on the visible `From:` address (not the SMTP envelope sender):

- it must be in the newsletter's D1 `authors` allow-list (case-insensitive —
  managed from the console's *Authors* tab), **and**
- it must be authenticated with DMARC alignment, according to the
  `Authentication-Results` header Email Routing prepends. Only the first such
  header is read, and only if its authserv-id is `mx.cloudflare.net`; any
  others may have been supplied by the sender. The message is accepted when
  `dmarc=pass` for the `From` domain. If that domain publishes no DMARC
  policy, a passing DKIM signature (`header.d`) or SPF check
  (`smtp.mailfrom`) aligned with the `From` domain is accepted instead. A
  `dmarc=fail`, a message with zero or several `From:` headers, or a missing
  Cloudflare result is rejected and logged as `sender_not_authenticated`.

Email Routing on its own only requires SPF *or* DKIM to pass for *some*
domain, and enforces DMARC only as strictly as the sender's policy asks
(`p=none` is not enforced). Without the alignment check, a message
DKIM-signed for an attacker's own domain could carry an author's address and
publish to the whole list.

**3. Validate attachments** against `AttachmentLimits` from env vars:
per-file size, total size, count, allowed MIME, blocked extensions. If
anything fails, the message is rejected with a bounce-back to the author —
no campaign is created.

**4. Decide attach-mode vs. link-mode.**

```ts
const linkMode = totalAttBytes > Number(env.ATTACHMENT_LINK_THRESHOLD_BYTES);
```

If total attachment bytes exceed `ATTACHMENT_LINK_THRESHOLD_BYTES` (default
8 MB), the campaign is flagged `link_mode = 1`. The consumer will then
*not* attach the files but render signed download URLs in the HTML
instead, served by the tracker worker. This keeps the per-recipient MIME
under Email Sending size limits.

**5. Persist + archive.** Inserts `campaigns(status='sending', ...)`,
uploads the raw `.eml` to R2 at `campaigns/<id>/raw.eml`, and inserts one
`attachments` row per file. Bytes are deduped per campaign by SHA-256 (so
the same image embedded twice only stores once in R2).

**6. Record the sends.** One `INSERT … SELECT` writes a `pending` row in
`sends` for every active, confirmed subscriber (`createPendingSends()` in
`shared/dispatch.ts`), then asks the consumer for a dispatcher run with a
`{ kind: 'dispatch' }` queue message (30 s delay, so a consumer deployed in
the same update is already running). Recipients are **not** put in queue
messages: the backlog lives in D1 and the consumer's dispatcher sends it
within the daily budget (see the consumer). Attachments are never in queue
messages either; the consumer pulls their bytes from R2.

**7. Finalize** by writing `total_recipients` so the admin dashboard has a
denominator for `sent_count` and `failed_count`.

### Failure modes

- **Unauthorized sender or auth fail** → `message.setReject(...)`, sender
  gets an NDR, no DB writes happen.
- **Bad attachment** → same: rejected before any DB or R2 writes.
- **Failure after the campaign row is written** (e.g. D1 unavailable):
  the email handler throws and Email Routing retries delivery; the pending
  rows are written in a single statement, so a campaign never has a
  partial recipient list.

### Why these decisions

- **Reject early, write late**: validation runs before any R2 or D1
  writes, so a malformed email leaves no garbage state.
- **Streaming subscribers**: a list of 500k subscribers would never fit in
  Worker memory, and `OFFSET` pagination degrades quadratically — keyset
  is O(n).
- **Link-mode toggle in ingest, not consumer**: the decision is recorded
  once on the campaign row, so every queue message for that campaign
  agrees, and consumer retries are deterministic.

---

## Consumer Worker

`workers/consumer/src/index.ts`

### Purpose

The send engine. It runs the **dispatcher**, which turns the `pending`
backlog in D1 into queued batches within the daily budget, and it sends
those batches: it materializes a full per-recipient MIME message (with
personalized tracking links and any attachments) and hands it to the
`SEND_EMAIL` Email Sending binding. Every send is recorded per row, so a
redelivered message never sends twice.

### Queue messages

| Message | Meaning |
|---|---|
| `{ kind: 'dispatch', at? }` | Run the dispatcher. `at` marks the single scheduled run (`dispatch_state.next_tick_at`). |
| `{ kind: 'send', campaignId, batchId }` | Send the rows of that batch that are still `pending`. |
| `{ campaignId, batch }` | Queued by releases before 2.6.5. Its recipients become `pending` rows (already-sent ones are left alone) and are dispatched normally. |

Every invocation that handles a message runs the dispatcher once at the end.

While a campaign is in progress (`status = 'sending'`, possibly for days) its
`delivery_state` column records `sending` while one of its batches is out for
delivery, `scheduled` while the rest waits for a later day's budget or a retry,
and `paused` while sending is held after an account-level error
(`refreshDeliveryStates()`, run after every dispatcher run and every batch). Ingest
sets it to `scheduled`; completion clears it. The console shows it as the
campaign's status.

### Dispatcher (`shared/dispatch.ts → dispatch()`)

1. Takes a 60 s lease on `dispatch_state`, so concurrent consumers can't
   spend the budget twice. If another run holds it, a run is scheduled
   for when the lease expires.
2. If sending is paused (`paused_until`, see errors below), schedules a run
   for the end of the pause and stops.
3. Releases claims older than 6 hours (a batch whose message never
   completed, e.g. dead-lettered), so those rows are dispatched again.
4. Budget: `min(warmup cap, account quota) − sent today − claimed but not
   yet sent` (warmup: [warmup.md](warmup.md)).
5. Claims due `pending` rows (no `next_attempt_at`, or one in the past),
   oldest campaign first, `BATCH_SIZE` per batch, by stamping `batch_id` and
   `claimed_at`, and enqueues one `send` message per batch (at most 200
   batches per run; a larger budget continues in an immediate follow-up run).
6. Schedules the next run: the next UTC midnight when due rows remain (the
   budget is spent), else the earliest `next_attempt_at` of a backed-off row,
   else nothing. Only **one** scheduled `dispatch` message is kept: a run is
   not scheduled again if one is already due no later. A campaign can
   therefore take as many days as the warmup needs; nothing waits in the
   queue and no queue retry is used for waiting.

### Sending a batch

**1. Load the batch.** Only rows of this `batchId` that are still `pending`
are read, with their subscribers. A redelivered message finds nothing left
to send. Subscribers who unsubscribed, bounced or became unconfirmed since
ingest are not sent to: their row is deleted and the campaign's
`total_recipients` reduced.

**2. Cache campaign + attachments per invocation.** The campaign row, all
attachments and their R2 bytes are loaded **once** and reused across every
recipient and batch in the invocation. In `link_mode`,
`disposition='attachment'` files are *not* loaded — they'll be linked, not
embedded — but `inline` files (e.g. images referenced by `cid:`) are.

**3. Pre-flight size guard.** `estimateRawSize` accounts for the ~33 %
base64 overhead of attachments. An oversize message fails the batch's rows
permanently (normally caught at ingest).

**4. Per recipient: render personalized HTML.** If the campaign was authored
in plain text only (no HTML part), the HTML body is derived from the text with
`textToHtml()` (`shared/mime.ts`: escaped, blank lines become paragraphs, line
breaks become `<br>`); otherwise HTML-preferring mail clients would show an
empty message with just the footer. The stored campaign is unchanged.
`renderRecipientHtml` then:
- if `link_mode`, appends an `<ul>` of `<a>` links to signed download
  URLs (`/a/:campaign/:sub/:attId?sig=...`) — each URL is HMAC-signed
  with `ATTACHMENT_SIGNING_KEY` so subscriber A cannot fetch subscriber
  B's URL;
- runs `instrumentHtml` to rewrite every `href="..."` into a signed click
  URL and append the open pixel.

**5. Per recipient: build MIME** with `shared/mime.ts` which produces:

```
multipart/mixed
├── multipart/related
│   ├── multipart/alternative
│   │   ├── text/plain (quoted-printable)
│   │   └── text/html  (quoted-printable, instrumented)
│   └── inline images (base64, Content-ID: <cid>)
└── attachments (base64, Content-Disposition: attachment)
```

Plus headers: `Date`, `Message-ID`, `List-Unsubscribe` (with both URL and
mailto), `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058 —
required by Gmail/Yahoo bulk-sender rules), and
`List-Id: "<newsletter name>" <<newsletter id>.<BASE_DOMAIN>>` (RFC 2919). The
List-Id uses the immutable newsletter id, so renaming a newsletter or changing
its slug does not break subscribers' mail filters.

Address headers (`From`, `To`, `Reply-To`) are rendered by `formatAddress()`
in `shared/mime.ts`: display names are stripped of control characters, quoted
when they contain specials, and RFC 2047-encoded when non-ASCII. Every other
header value has CR/LF removed, and custom header names are validated, so
subscriber data can never start a new header line.

**6. Send and record the outcome.**

```ts
await env.SEND_EMAIL.send(new EmailMessage(fromAddr, r.email, raw));
await completeSend(env.DB, r.send_id, campaignId, 'sent', { messageId });
```

`completeSend` changes the row only while it is still `pending`, and only
then increments `sent_count` / `failed_count`, so outcomes are recorded once.

**7. Errors** (`classifySendError()`):

| Error | Action |
|---|---|
| `E_DAILY_LIMIT_EXCEEDED` | Pause all sending until the next UTC midnight. |
| `E_RATE_LIMIT_EXCEEDED`, `E_INTERNAL_SERVER_ERROR` | Pause all sending for 5 minutes. |
| `E_EMAIL_SENDING_NOT_READY`, `E_SENDER_DOMAIN_NOT_AVAILABLE`, `E_SENDER_DOMAIN_NOT_CONFIGURED`, `E_SENDER_NOT_VERIFIED`, `E_ACCOUNT_SUSPENDED` | Pause all sending for 1 hour. |
| `E_RECIPIENT_SUPPRESSED` | The send fails; the subscriber becomes `bounced` (hard, code `E_RECIPIENT_SUPPRESSED`) with a bounce event, so later campaigns skip them. |
| Any other `E_…` code, or a malformed request | The send fails. |
| No code (network or unexpected error) | Retried after 5 min, 30 min, then 2 h; then the send fails. |

A pause fails nobody: the batch's unsent rows (the current one included)
return to the backlog and the dispatcher resumes at the end of the pause
(`dispatch_state.paused_until`, logged as `consumer.send_paused`). A
per-recipient retry sets `attempts` and `next_attempt_at` and schedules a
dispatcher run for that time.

A failure outside the per-recipient sends (e.g. D1 unavailable) retries the
queue message. That is safe because already-sent rows are skipped; after
`max_retries: 3` the message is dead-lettered and its claimed rows are
released after 6 hours and dispatched again.

### Why these decisions

- **Caching campaign and attachments per batch**: amortizes D1 + R2 cost.
- **Backlog in D1, not in the queue**: waiting for budget never uses a
  queue retry or parks messages; progress is visible per row (the
  console's **Pending** filter on a campaign) and survives redelivery.
- **Per-row outcomes**: queue redelivery is a fact of life
  ("at-least-once"); a row changes only while `pending`, so nobody is sent
  twice and counters are never double-incremented.
- **Pre-flight size estimate**: a 40 MB MIME would just be rejected by
  Email Sending anyway; failing in our code lets us mark the campaign
  failed cleanly and surface a useful error.

---

## Tracker Worker

`workers/tracker/src/index.ts`

### Purpose

A public HTTP endpoint reachable from email clients. Every personalized
URL the consumer embeds — open pixel, click redirect, attachment download
in link-mode, unsubscribe — comes back here. It logs the event to D1 and
returns the appropriate response (image, redirect, file, or HTML page).

### Routes

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/o/:campaign/:sub.gif` | open tracking pixel |
| GET | `/c/:campaign/:sub?u=<url>&sig=...` | signed click redirect |
| GET | `/a/:campaign/:sub/:attId?sig=...` | signed attachment download (link-mode) |
| GET | `/u/:sub?t=<token>` | unsubscribe confirmation page |
| POST | `/u/:sub` | one-click unsubscribe (RFC 8058) |

### How URLs are signed

Click and download URLs carry an HMAC over the tuple
`(kind | campaignId | subscriberId | target)` using `LINK_SIGNING_KEY` or
`ATTACHMENT_SIGNING_KEY` respectively. The tracker recomputes the HMAC
and compares with constant-time-ish equality (`shared/tracking.ts:18-24`).

Why HMAC instead of just an opaque ID? Two reasons:
1. **Stateless**: no DB lookup needed to validate a URL — the worker can
   accept or reject solely from the request itself, so it scales
   linearly with traffic.
2. **Tamper-proof**: a recipient can't swap `subscriberId=42` to
   `subscriberId=43` and download someone else's attachment.

The unsubscribe endpoint uses the simpler `subscribers.token` (random per
subscriber) instead of HMAC because we need to look up the row anyway.

### Open pixel

Returns a hard-coded 43-byte transparent GIF and logs `events(type='open')`
via `ctx.waitUntil` so the response itself isn't blocked on D1. Many mail
clients pre-fetch images to "warm" the cache, which inflates open
counts — a known limitation of pixel tracking.

### Click redirect

Verifies the signature, logs `events(type='click', url=<target>)`, then
issues a 302 to the original URL. If the signature is bad, returns 403
with no logging — so probing the endpoint costs an attacker a wasted
request.

### Attachment download (link-mode only)

Verifies the HMAC, looks up the attachment by `(id, campaign_id)` (the
composite is important — prevents id enumeration across campaigns),
streams the bytes from R2 with the original `Content-Type` and
`Content-Disposition: attachment; filename=...`, and logs
`events(type='download', attachment_id=...)`.

### Unsubscribe

`GET /u/:sub?t=<token>` renders a tiny confirmation form. `POST /u/:sub`
either takes the token from the query or the form body, validates it
against `subscribers.token`, sets `status='unsubscribed'`, and logs an
event. The `POST` shape is required by RFC 8058 / Gmail's
`List-Unsubscribe-Post: List-Unsubscribe=One-Click` — Gmail sends a POST
with body `List-Unsubscribe=One-Click` directly when the user clicks the
"Unsubscribe" UI in the inbox.

---

## Bounce Worker

`workers/bounce/src/index.ts`

### Purpose

Two responsibilities: (1) process `List-Unsubscribe` mailto replies from
subscribers, and (2) periodically query the Cloudflare Email Sending
GraphQL API for delivery failures and record them as bounces.

### Email handler — mailto unsubscribes

The bounce worker is the catch-all inbound route. Inbound mail addressed
to `unsubscribe+<subscriberId>.<token>@<domain>` (advertised in
`List-Unsubscribe` headers by the consumer) is handled here:

1. Parse `unsubscribe+<id>.<token>@` from `message.to` (`parseMailtoUnsubscribe()`).
2. Verify `<token>` against the subscriber's unsubscribe token (constant time);
   otherwise log `mailto_unsubscribe_rejected` and stop. The legacy
   token-less `unsubscribe+<id>@` form is rejected.
3. `UPDATE subscribers SET status='unsubscribed'` where `id = <sub> AND status = 'active'`.
4. If a row changed, insert `events(type='unsubscribe')` and log `mailto_unsubscribe`.

All other inbound mail is silently dropped (no state mutation).

### Scheduled handler — GraphQL delivery-failure sync

The `emailSendingAdaptive` GraphQL query is **zone-wide** (it returns delivery
failures for every campaign at once), so the worker uses a single global
counter — `bounce_check_state.checks_to_go` — rather than a per-campaign
schedule. The cron fires every **30 minutes**. Each tick:

1. **Top up**: if any campaign sent within the last ~15 min, reset
   `checks_to_go` to **6** (capped — never higher). A still-sending campaign
   keeps the counter topped up; the 3-hour countdown begins once sending stops.
2. **Sync**: if `checks_to_go > 0`, or once daily at 04:00 UTC, call
   `syncDeliveryEvents` (one zone-wide sync covers all campaigns).
3. **Decrement**: if `checks_to_go > 0`, subtract 1. 6 checks × 30 min ≈ 3 h.

`syncDeliveryEvents` queries `emailSendingAdaptive` (GraphQL) for
`deliveryFailed` events in the last 25 hours, matches each to a `sends`
row by recipient email, classifies hard vs soft from the SMTP error code,
then:

- Increments `bounce_count` / `hard_bounce_count` / `soft_bounce_count`.
- Flips `status='bounced'` once `hard_bounce_count >= HARD_BOUNCE_THRESHOLD`.
- Updates the `sends` row to `status='bounced'`.
- Inserts `events(type='bounce')`.

### Why these decisions

- **GraphQL API, not inbound DSN routing**: Cloudflare Email Service does
  not honour a custom `Return-Path` header (it is platform-controlled),
  so VERP-based DSN attribution is not possible. The GraphQL API is the
  authoritative source of delivery failures.
- **Hard threshold = 1**: a permanent 5.x.x failure means the address is
  bad; one strike is enough.
- **Soft threshold = 5**: gives a few campaigns of grace before declaring
  a transient-bouncer dead.
- **Post-send burst + daily fallback**: fast bounces are caught within the
  first 3 hours after each send; the daily sync catches slow/delayed ones.

---

## Cleanup Worker

`workers/cleanup/src/index.ts`

### Purpose

Bounded retention. Without it, R2 storage and D1 row counts grow forever.
Runs on a Cron Trigger (`0 4 * * *` — daily at 04:00 UTC) and prunes
campaigns older than `RETENTION_DAYS` (default 90).

### Step by step

```ts
const { results: expired } = await env.DB
  .prepare(`SELECT id FROM campaigns WHERE created_at < datetime('now','-90 days')`)
  .all();
for (const c of expired) {
  // delete R2 attachment bytes
  for (const a of attachmentsOfCampaign) await env.ARCHIVE.delete(a.r2_key).catch(()=>{});
  await env.ARCHIVE.delete(`campaigns/${c.id}/raw.eml`).catch(()=>{});
  // ON DELETE CASCADE on the schema removes attachments + sends + events
  await env.DB.prepare('DELETE FROM campaigns WHERE id = ?').bind(c.id).run();
}
```

### Why these decisions

- **R2 first, D1 second**: if R2 deletion fails partway, the next run
  will retry (we still have the keys). If we deleted the D1 rows first
  and then crashed, R2 objects would be orphaned with no way to find them.
- **`.catch(()=>{})` on R2 deletes**: best-effort; a missing object isn't
  a reason to abort the whole run.
- **Cascade on `campaigns`**: defined in `db/schema.sql`, so a single
  `DELETE FROM campaigns` cleans `attachments`, `sends`, and `events`
  atomically.
- **`ctx.waitUntil`**: a Cron Trigger has a wall-clock budget; using
  `waitUntil` lets the scheduled handler return immediately while the
  cleanup runs to completion in the background.

### Extension points

- Roll old `events` rows into `events/<yyyy-mm-dd>.ndjson` in R2 before
  deleting (long-term analytics, cheap storage).
- Different retention windows for different tables (e.g. keep
  `subscribers.bounce_count` history forever).

---

## Admin Worker

`workers/admin/src/index.ts`

### Purpose

Operator interface. Serves the React SPA from the `[assets]` binding and
exposes a JSON API under `/api/*` for managing subscribers, authors,
campaigns and warmup quota.

### Authentication

The worker has **no built-in auth**. It must be deployed behind a
Cloudflare Access application; Access authenticates the user at the edge
and adds the `Cf-Access-Authenticated-User-Email` header on every
request that reaches the worker. The handler simply checks that the
header is present:

```ts
if (!req.headers.get('cf-access-authenticated-user-email'))
  return Response.json({ error: 'unauthorized' }, { status: 401 });
```

`/api/me` reflects the Access identity back to the SPA so the header can
display the signed-in user's name.

### Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/subscribers` | add or reactivate a subscriber (upsert) |
| GET | `/subscribers` | list latest 1000 subscribers |
| GET | `/campaigns` | list latest 100 campaigns with counters |
| GET | `/campaigns/:id` | one campaign + grouped event counts |

### Notes

- **Subscriber upsert** uses `ON CONFLICT(email) DO UPDATE SET
  status='active'` so re-subscribing a previously-unsubscribed person is
  a single round trip and idempotent.
- **Per-campaign stats** uses `GROUP BY type` on the `events` table:
  ```sql
  SELECT type, COUNT(*) as n FROM events WHERE campaign_id = ? GROUP BY type
  ```
  giving you opens / clicks / bounces / downloads / unsubscribes in one
  query. `sends`-derived counters (`sent_count`, `failed_count`,
  `total_recipients`) come from the campaigns row itself.

### Extension points

- Per-subscriber send history (`SELECT * FROM sends WHERE subscriber_id =
  ?`).
- Resend failed: set a campaign's `failed` sends back to `pending` (and lower
  `failed_count`); the dispatcher sends them within the daily budget.
- Cancel a scheduled campaign: delete its `pending` sends that aren't claimed
  and lower `total_recipients`.
