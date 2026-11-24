# Subscribe & Unsubscribe — Complete Reference

This document describes **everything** the app does to manage subscribing and
unsubscribing: every entry point, the exact data it writes, the workers and
code paths involved, and the safeguards in between. It is implementation-level
and cross-references the source files.

Subscriptions are always **scoped to a single newsletter**. The `subscribers`
table has a `UNIQUE (newsletter_id, email)` constraint, so the same address can
independently subscribe to different newsletters.

---

## 1. Data model

All state lives in the D1 `subscribers` table (`db/schema.sql`):

| Column | Purpose |
| --- | --- |
| `id` | Auto-increment primary key. Used in unsubscribe / verify URLs. |
| `newsletter_id` | Owning newsletter (`ON DELETE CASCADE`). |
| `email` | Address; unique per newsletter (case stored as given, matched case-insensitively on import/lookup). |
| `first_name` | Required by the app (signup, manual add, CSV import, edit). |
| `last_name` | Optional. |
| `full_name` | Virtual generated column: `first_name` + `last_name`. Never written directly. |
| `tracking_consent` / `tracking_consent_at` | `0/1` opt-in to open/click tracking (default `0`) and when it was given. |
| `verified` | `0/1`. Confirmed via double opt-in. Defaults to `0`. |
| `status` | One of `active`, `unsubscribed`, `bounced`, `complained`. Defaults to `active`. |
| `subscribed_at` | Timestamp of (re)subscription. |
| `unsubscribed_at` | Set when status becomes `unsubscribed`. |
| `bounce_count` / `last_bounce_at` | Maintained by the bounce worker. |
| `token` | **Unsubscribe token** — random UUID, proves ownership of unsubscribe links. |
| `confirm_token` | **Double opt-in token** — random UUID, non-null only while a public signup is *pending*; cleared on confirmation. |

Two distinct tokens exist on purpose:

- `token` authenticates the **unsubscribe** link (`/u/<id>?t=<token>`).
- `confirm_token` authenticates the **double opt-in confirmation** link
  (`/verify/<id>?t=<confirm_token>`) and acts as the "pending" flag.

### The deliverability gate

Only subscribers that satisfy **both** conditions receive a campaign:

```sql
status = 'active' AND confirm_token IS NULL
```

This is enforced when the ingest worker records a campaign's sends
(`shared/dispatch.ts → createPendingSends()`), and again just before each send:
a subscriber who unsubscribed, bounced or became unconfirmed while a campaign
was waiting for its daily budget is skipped. Consequences:

- A **pending** public signup (`confirm_token` set) never receives mail, even
  though its `status` is `active`.
- Manually-added and CSV-imported subscribers have `confirm_token = NULL`, so
  they receive mail immediately (backward compatible).

The newsletter list/detail API also reports `active_count` as
`COUNT(*) WHERE status='active'`; note this count currently includes pending
public signups (they are `active` but gated out of sends by `confirm_token`).

---

## 2. Ways to SUBSCRIBE

There are three entry points. Two are operator-driven (console), one is
self-service (public page).

### 2.1 Manual add (console)

- **UI:** Newsletter → **Subscribers** tab → add.
- **API:** `POST /api/newsletters/:id/subscribers` with
  `{ email, first_name, last_name?, tracking_consent? }`
  (`workers/admin/src/index.ts`). `first_name` is required.
- **SQL:**

  ```sql
  INSERT INTO subscribers (newsletter_id, email, first_name, last_name, tracking_consent, tracking_consent_at, token)
  VALUES (?, ?, ?, ?, ?, CASE WHEN ? = 1 THEN datetime('now') END, ?)
  ON CONFLICT(newsletter_id, email) DO UPDATE SET status='active',
    first_name=excluded.first_name, last_name=excluded.last_name,
    tracking_consent=excluded.tracking_consent, tracking_consent_at=excluded.tracking_consent_at
  ```

- **Result:** `verified` defaults to `0`, `status='active'`, `confirm_token`
  stays `NULL` → **receives mail immediately** (no confirmation). Re-adding an
  existing address **reactivates** it (sets `status='active'`) and replaces
  its names and tracking consent. A fresh unsubscribe `token` is generated.
- Requires edit capability on the newsletter (read-only admins are blocked at
  the mutation choke point).

### 2.2 CSV import (console)

- **UI:** Subscribers tab → import.
- **API:** `POST /api/newsletters/:id/subscribers/import` (CSV text or JSON).
- **Behaviour:**
  - Columns are matched by header name (`Email`, `First name`, `Last name`,
    `Verified`, `Date subscribed`, `Tracking consent`, `Tracking consent date`;
    `first_name`-style names also work). Without a recognised header, the
    template order is used.
  - Rows without a first name are **rejected**.
  - **Duplicates are skipped, not updated** — both against existing rows and
    within the file (case-insensitive on email).
  - **SQL:**

    ```sql
    INSERT INTO subscribers (newsletter_id, email, first_name, last_name, verified, subscribed_at, tracking_consent, tracking_consent_at, token)
    VALUES (?, ?, ?, ?, ?, COALESCE(NULLIF(?, ''), datetime('now')), ?, CASE WHEN ? = 1 THEN COALESCE(NULLIF(?, ''), datetime('now')) END, ?)
    ON CONFLICT(newsletter_id, email) DO NOTHING
    ```

  - Returns `{ added, duplicated, rejected }`, surfaced in a popup.
- **Result:** imported rows have `confirm_token = NULL` → receive mail
  immediately. `verified` is whatever the file says.

### 2.3 Public signup page (self-service, double opt-in)

This is the only path where the *subscriber* initiates, and it is the one with
the most machinery. It is **opt-in per newsletter** and **off by default**.

#### Configuration (operator, one-time + per-newsletter)

- **Per newsletter:** Newsletter → **Signup** tab
  (`web/src/pages/NewsletterDetail.tsx → SignupEditor`):
  - `allow_public_signup` toggle (off by default).
  - `slug` — the public identifier in `/subscribe/<slug>`.
    - **What a slug is:** the short, URL-friendly "address" of a newsletter's
      public signup page — a human-readable, lowercase-hyphenated version of its
      name (e.g. *"Weekly Product Digest"* → `weekly-product-digest`, giving
      `…/subscribe/weekly-product-digest`). It is used instead of the internal
      newsletter UUID so the link is clean and shareable, and it is unique
      across newsletters so `/subscribe/<slug>` resolves to exactly one. (The
      term comes from publishing/CMS jargon, e.g. WordPress.)
    - Auto-derived from the name at creation via `uniqueSlug()` /`slugify()`
      (lowercase, accent-stripped, hyphenated, deduped with `-2`, `-3`, …).
    - Editable; validated against `^[a-z0-9]+(?:-[a-z0-9]+)*$`, max 64 chars,
      unique across newsletters. Submitting an **empty** slug re-derives one
      from the current name.
  - Shows the live **subscribe URL** and an **`<iframe>` embed snippet** (the
    iframe carries the Turnstile widget when protection is enabled).
  - Persisted via `PATCH /api/newsletters/:id` (`slug`, `allow_public_signup`).
- **Global, one-time (super admin):**
  - Email Sending (DKIM) must be enabled on the domain (the tracker uses a
    `send_email` binding to deliver the confirmation).
  - New installations attempt to configure **Cloudflare Turnstile** automatically.
    In **Settings → Subscribe**, enabling **Turnstile bot protection** creates or
    reuses the app's Managed widget for the exact tracking hostname, configures
    its keys on the tracker, and verifies them before enabling protection. No
    site key input is needed. Retrying a failed setup reuses the saved widget.
    The runtime API token requires **Account: Turnstile Edit** and **Workers
    Scripts Edit**; older installations must upgrade these permissions manually.
    Disabling requires confirmation: it deletes the widget and removes its
    tracker keys. The secret key is never stored in application settings.

#### The hosted page & flow

All served by the **tracker worker** (`workers/tracker/src/index.ts`) at
`https://track.<domain>`:

**`GET /subscribe/<slug>`**

1. `loadSettings()` resolves config (site key, base URL, from address, etc.).
2. `findSignupNewsletter(slug)` looks up the newsletter and returns it only if
   it **exists, is `enabled=1`, and `allow_public_signup=1`** — otherwise a
   generic **404** (so disabled/non-existent slugs are indistinguishable).
3. If the `SEND_EMAIL` binding is missing, or Turnstile is enabled without both
   `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`, returns **503 "Signup
   unavailable"**.
4. Otherwise renders a branded, mobile-friendly form (`subscribeForm()`): email,
   first name (required), last name (optional), an unticked tracking-consent
   checkbox when `TRACKING_ENABLED` and the newsletter's `tracking_enabled` are
   both on, and—when enabled—the Cloudflare
   Turnstile widget. Light/dark
   via CSS.

**`POST /subscribe/<slug>`**

1. Re-runs the eligibility + configuration checks above.
2. Parses `email`, `first_name`, `last_name`, `tracking_consent`,
   `cf-turnstile-response`.
3. **Validates email** with a basic regex and requires a first name; invalid →
   re-render form with error (HTTP 400).
4. When Turnstile is enabled, **verifies Turnstile** (`verifyTurnstile()`):
   server-to-server POST to `https://challenges.cloudflare.com/turnstile/v0/siteverify`
   with the secret, token and client IP. Any non-success → re-render form with
   error (400).
5. **Decides whether to (re)send a confirmation** by looking up the existing
   row:
   - If the address is **already confirmed and active**
     (`status='active' AND confirm_token IS NULL`) → **do nothing** to the DB
     (don't reset them to pending), but still show the neutral success page.
   - Otherwise (new / unsubscribed / bounced / still-pending) → **upsert as
     pending**:

     ```sql
     INSERT INTO subscribers (newsletter_id, email, first_name, last_name, tracking_consent, tracking_consent_at, verified, status, token, confirm_token)
     VALUES (?, ?, ?, ?, ?, CASE WHEN ? = 1 THEN datetime('now') END, 0, 'active', ?, ?)
     ON CONFLICT(newsletter_id, email) DO UPDATE SET
       confirm_token = excluded.confirm_token,
       first_name = excluded.first_name, last_name = excluded.last_name,
       tracking_consent = excluded.tracking_consent, tracking_consent_at = excluded.tracking_consent_at
     ```

     A new `confirm_token` (and, for brand-new rows, a new unsubscribe `token`)
     is generated. Because `confirm_token` is now set, the row is gated out of
     sends until confirmed.
6. Sends the **confirmation email** (`sendConfirmationEmail()`, fired via
   `ctx.waitUntil`) using `buildEmail()` and the `SEND_EMAIL` binding. From
   address = the newsletter's `from_address` or `newsletter@<BASE_DOMAIN>`. The
   email contains a button + plain link to:

   ```
   https://track.<domain>/verify/<id>?t=<confirm_token>
   ```

7. Returns the **same neutral "Almost there — check your inbox" page**
   regardless of whether the address was new or already subscribed. This is an
   **anti-enumeration** measure: the response can't reveal who is already
   subscribed.

   For an address that is already an **active, confirmed** subscriber, steps 5
   and 6 are skipped: the record is left unchanged and, instead of a
   confirmation, the address receives a short **"You're already subscribed"**
   email with its unsubscribe link (`notifyAlreadySubscribed()`, also via
   `ctx.waitUntil`). That notice is sent at most once a day per subscriber,
   using the `tracker` / `already_subscribed_notice` log entry, so the form
   can't be used to flood a subscriber's mailbox.

   Likewise, if a confirmation was already sent to the address in the last
   hour, nothing is sent and the row (and its token) is left unchanged, so the
   earlier email's link keeps working and the form can't flood a stranger's
   inbox with confirmations. The page is the same in every case.

**`GET /verify/<id>?t=<confirm_token>`** (`handleVerify()`)

1. Loads the row's `confirm_token`.
2. No row, or token mismatch → **"Invalid link"** (400 / 403). Tokens carry
   their issue time (`<ms>.<uuid>`); a link older than **7 days** gets a
   **"Link expired"** page (410) asking to sign up again. Tokens issued before
   links expired have no time and stay valid.
3. `confirm_token IS NULL` already → **"Already confirmed"** success page (so a
   second click is harmless / idempotent).
4. On a valid match, confirms:

   ```sql
   UPDATE subscribers
   SET verified = 1, status = 'active', confirm_token = NULL,
       unsubscribed_at = NULL, subscribed_at = datetime('now')
   WHERE id = ?
   ```

   This clears the pending flag (so they now pass the deliverability gate),
   marks them verified, and **reactivates** a previously
   unsubscribed/bounced address (double opt-in doubles as resubscribe).
5. Shows the **"Subscription confirmed"** page.

#### Why double opt-in matters here

- No mail is ever sent to an address until its owner clicks the confirmation
  link — protects against typos, malicious sign-ups of third parties, and
  list-poisoning.
- The neutral responses prevent the page from being used to probe membership.
- Turnstile blocks automated/bulk bot submissions before any DB write or email.

---

## 3. Ways to UNSUBSCRIBE

Every campaign email advertises unsubscribe options; there is also a footer link
and an operator path. All of them converge on setting
`status='unsubscribed', unsubscribed_at=now`.

### 3.1 What the consumer puts in each email

For every recipient, the **consumer worker** (`workers/consumer/src/index.ts`)
builds:

- A signed unsubscribe URL via
  `unsubscribeUrl(base, subscriberId, token)` →
  `https://track.<domain>/u/<id>?t=<token>` (`shared/tracking.ts`).
- Headers:

  ```
  List-Unsubscribe: <https://track.<domain>/u/<id>?t=<token>>, <mailto:unsubscribe+<id>.<token>@<domain>>
  List-Unsubscribe-Post: List-Unsubscribe=One-Click
  ```

- A **footer** (HTML + text) that always contains the unsubscribe link (see
  §3.4).

So mail clients can offer a native unsubscribe button (RFC 8058 one-click), and
there is a human-clickable link in the body.

### 3.2 HTTPS one-click / link (handled by the tracker)

Route `/u/<id>` in `workers/tracker/src/index.ts`:

- **`GET /u/<id>?t=<token>`** — validates the token (`checkUnsubToken()`:
  compares against the stored `token`). On success returns a tiny confirmation
  page (`unsubPage()`) with a POST form; bad/absent token → 400/403.
- **`POST /u/<id>`** (one-click, or the page's form submit) — token may come
  from the query string or the form body. On valid token:

  ```sql
  UPDATE subscribers SET status='unsubscribed', unsubscribed_at=datetime('now')
  WHERE id = ?
  ```

  Then logs an `unsubscribe` event (`logEvent`, with UA/IP) and returns
  `"Unsubscribed."`.

The token requirement means an unsubscribe link only works for the intended
subscriber and can't be forged by guessing IDs.

### 3.3 Mailto fallback (handled by the bounce worker)

The `mailto:unsubscribe+<id>.<token>@<domain>` option is for clients that prefer email
unsubscribe. **No extra Email Routing rule is required** because the bounce
worker is already the **catch-all** inbound route (per the deploy runbook).

`workers/bounce/src/index.ts → email()`:

1. Lowercases the recipient and parses `unsubscribe+<id>.<token>@`
   (`parseMailtoUnsubscribe()` in `shared/tracking.ts`). `<token>` is the
   subscriber's unsubscribe token (the UUID without hyphens, lowercased).
2. Looks up the subscriber and compares the token in constant time. A missing,
   malformed or wrong token — including the legacy token-less
   `unsubscribe+<id>@` form — is ignored and logged as
   `mailto_unsubscribe_rejected`.
3. If the token matches:

   ```sql
   UPDATE subscribers SET status='unsubscribed', unsubscribed_at=datetime('now')
   WHERE id = ? AND status='active'
   ```

4. If a row changed, inserts an `unsubscribe` event and logs
   `mailto_unsubscribe`.

The token means a mailto can't be forged for another subscriber by guessing
their (sequential) ID. Emails sent before this change carry the legacy
token-less address, which no longer unsubscribes; their HTTPS one-click and
footer links keep working.

### 3.4 Footer link (guaranteed)

`shared/footer.ts` renders the per-newsletter footer (falling back to the global
`DEFAULT_FOOTER_*`). The `{{unsubscribe_url}}` token resolves to the same
`/u/<id>?t=<token>` URL. **If an author omits the token, an unsubscribe line is
appended automatically** (`renderFooterHtml` / `renderFooterText`), so an
unsubscribe link is always present. Footer HTML is sanitized to an allow-list on
save (`sanitizeFooterHtml`), and the footer is appended **after** tracking
instrumentation so its unsubscribe link is never click-rewritten.

### 3.5 Operator-driven (console)

- **Remove a subscriber:** `DELETE /api/newsletters/:id/subscribers/<sid>` does
  **not** hard-delete — it sets `status='unsubscribed', unsubscribed_at=now`
  (soft delete, preserves history).
- **Edit status:** `PATCH /api/newsletters/:id/subscribers/<sid>` can set
  `status` directly (and `name`); choosing `unsubscribed` also stamps
  `unsubscribed_at`.

### 3.6 Automatic (bounces & complaints)

Not user-initiated but they change deliverability the same way:

- **Bounces:** the bounce worker increments `bounce_count` and, past the
  hard/soft threshold, sets `status='bounced'` (excluded from sends).
- **Complaints:** a spam complaint sets `status='complained'`.

---

## 4. Re-subscribing after unsubscribe

- **Public page:** submitting again sends a fresh confirmation; clicking it runs
  the `verify` UPDATE which sets `status='active'` and clears
  `unsubscribed_at` — a clean, consented resubscribe.
- **Console:** re-adding (POST) or a `status` PATCH back to `active`
  reactivates immediately.

A `bounced`/`unsubscribed` address therefore is never permanently locked out; it
just won't receive mail until reactivated by one of the above.

---

## 5. End-to-end summary

| Action | Trigger | Worker | Net DB effect | Receives mail? |
| --- | --- | --- | --- | --- |
| Manual add | Console POST | admin | `status=active`, `confirm_token=NULL` | Immediately |
| CSV import | Console POST | admin | insert if new, `confirm_token=NULL` | Immediately |
| Public signup (step 1) | `POST /subscribe/<slug>` | tracker | `status=active`, `confirm_token=set` (pending) | **No** (gated) |
| Public confirm (step 2) | `GET /verify/<id>` | tracker | `verified=1`, `confirm_token=NULL`, reactivated | Yes |
| Unsubscribe (one-click/link) | `GET/POST /u/<id>?t=` | tracker | `status=unsubscribed` | No |
| Unsubscribe (mailto) | inbound `unsubscribe+<id>.<token>@` | bounce | `status=unsubscribed` | No |
| Remove (console) | `DELETE …/subscribers/<id>` | admin | `status=unsubscribed` (soft) | No |
| Bounce/complaint | inbound bounce / FBL | bounce | `status=bounced`/`complained` | No |

**Deliverability rule (the single source of truth):**
`status='active' AND confirm_token IS NULL` (`shared/db.ts`).

---

## 6. Source map

| Concern | File |
| --- | --- |
| Schema (`subscribers`, `slug`, `allow_public_signup`, `confirm_token`) | `db/schema.sql` (migration `db/migrations/0012_*`) |
| Recipient gate | `shared/dispatch.ts → createPendingSends`, `workers/consumer` (re-checked before sending) |
| Unsubscribe URL builder | `shared/tracking.ts → unsubscribeUrl` |
| Footer + guaranteed unsubscribe link | `shared/footer.ts` |
| Public subscribe/verify pages + Turnstile | `workers/tracker/src/index.ts` |
| HTTPS unsubscribe (`/u/<id>`) | `workers/tracker/src/index.ts` |
| Mailto unsubscribe + bounces | `workers/bounce/src/index.ts` |
| List-Unsubscribe headers + footer assembly | `workers/consumer/src/index.ts` |
| Manual add / import / status PATCH / slug | `workers/admin/src/index.ts` |
| Signup tab UI | `web/src/pages/NewsletterDetail.tsx → SignupEditor` |
| Turnstile site key setting | `web/src/pages/Settings.tsx`, `shared/settings.ts` |
