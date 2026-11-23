# Email Warmup — Detailed Reference

This document describes, end to end, how the newsletter pipeline throttles
outbound email to protect sending reputation ("IP/domain warmup"): the model,
the data, the algorithm, the exact day-by-day behaviour, configuration, and
operational notes.

Warmup is implemented by the **consumer worker** and surfaced (read-only) by the
**admin console**. It is **always on** and **cannot be disabled**.

---

## 1. Goal

When a domain starts sending, mailbox providers (Gmail, Outlook, …) trust it
more as it demonstrates a consistent, gradually increasing volume of wanted
mail. Sending too much too soon hurts deliverability. Warmup therefore **caps
how many emails the consumer sends per day and per week**, and **ramps those
caps up gradually, but only as real sending volume justifies it**.

---

## 2. The two caps

Every send is gated by two caps; **the smaller one binds**.

### Weekly cap — a stepped schedule

The weekly cap is chosen from a step schedule indexed by the warmup **level**
(a.k.a. "week"):

| Level (week) | Weekly cap (default)        |
| ------------ | --------------------------- |
| 0            | 500                         |
| 1            | 1,500                       |
| 2            | 5,000                       |
| 3            | 12,000                      |
| 4            | 25,000                      |
| 5            | 40,000                      |
| 6+           | `WARMUP_TARGET_WEEKLY` (50,000) — steady state |

The schedule is configurable (`WARMUP_SCHEDULE`); `WARMUP_TARGET_WEEKLY` is the
steady-state cap used once the schedule is exhausted. **Each schedule value is
also the demand threshold to enter that level** (see §4).

### Daily cap — read live from the Cloudflare API

The daily cap is the **account's resolved daily sending quota**, read from the
Cloudflare Email Sending API:

```
GET /accounts/{account_id}/email/sending/limits  →  result.quota = { unit, value }
```

- The consumer reads it **once per UTC day** (before processing the queue) and
  caches it in the `warmup_state` table (`daily_cap`, `daily_cap_date`).
- `unit` may be `day` or `hour`. An `hour` unit is normalized to a per-day
  figure (`value × 24`).
- If the quota is `null` (Cloudflare hasn't assigned one yet), the API call
  fails, or the token/account is not configured, the daily cap falls back to
  `WARMUP_FALLBACK_DAILY_CAP` (default 1,000).

> The daily cap is **account-wide**, not per-domain — it is whatever Cloudflare
> currently grants the account for Email Sending.

---

## 3. Demand-driven progression (no start date)

Unlike a calendar-based warmup, there is **no fixed start date**. Progression is
driven by **demand**.

**Demand** = the number of emails still to send across active campaigns:

```sql
SELECT COALESCE(SUM(MAX(total_recipients - sent_count - failed_count, 0)), 0)
FROM campaigns WHERE status IN ('queued','sending')
```

The progression rules:

1. **Start.** Warmup enters **week 0** the first time demand exceeds **499**
   (i.e. ≥ 500, the week-0 cap). Before that, nothing to warm up.
2. **Advance gradually.** Each **7-day window**, the level may advance by **at
   most one step**, and **only if demand has grown to the next level's
   threshold** (the threshold to enter week _N_ is `schedule[N]`). Otherwise the
   level stays put.
3. **Never decrease.** Once a level is reached it is retained — reputation built
   is not given back.

This means the ramp **never moves faster than real volume requires**, and there
are **no idle weeks** waiting for a calendar to advance.

### State

A single row in the `warmup_state` table (id = 1):

| Column            | Meaning                                                            |
| ----------------- | ------------------------------------------------------------------ |
| `level`           | current warmup week (0-based); `NULL` until warmup has started      |
| `week_started_at` | UTC `YYYY-MM-DD HH:MM:SS` start of the current 7-day weekly window  |
| `daily_cap`       | last daily cap read from the API (normalized per-day)              |
| `daily_cap_date`  | UTC `YYYY-MM-DD` the daily cap was read                            |
| `updated_at`      | last update                                                        |

Level/window updates use optimistic concurrency (a conditional `UPDATE` on
`week_started_at`) so two concurrent consumer invocations can never
double-advance.

---

## 4. Enforcement (dispatcher)

The budget is enforced by the dispatcher (`shared/dispatch.ts`, run by the
consumer; see [workers.md](workers.md)), not per queue message. Each run:

1. Loads `warmup_state` and the config (`WARMUP_SCHEDULE`,
   `WARMUP_TARGET_WEEKLY`, `WARMUP_FALLBACK_DAILY_CAP`).
2. **Refreshes the daily cap** if `daily_cap_date` ≠ today (one API call/day).
3. Computes **demand** and runs the **progression** (start / advance / stay),
   persisting any change atomically.
4. Counts emails already **sent** in each window (`status='sent'` in `sends`):
   - `sentToday` since UTC midnight,
   - `sentThisWeek` since `week_started_at`.
5. Computes remaining capacity:
   `remaining = min(dailyCap − sentToday, weeklyCap − sentThisWeek)`.
6. Subtracts rows already claimed but not yet sent, then claims that many
   `pending` sends (oldest campaign first) and enqueues them as batches.
7. If recipients remain, schedules **one** dispatcher run for the next UTC
   midnight. The backlog stays in D1 meanwhile, so a campaign larger than the
   daily cap simply continues the next day, and the next, for as long as the
   warmup needs. Logged as `consumer.dispatch`.

Releases before 2.6.5 paused by retrying the queued batch, which used up the
queue's retries and dead-lettered campaigns that needed more than about a day
and a half.

---

## 5. Worked examples

Assume the default schedule `[500, 1500, 5000, 12000, 25000, 40000]` → 50,000
steady, and that the account's API daily cap is large enough not to bind in the
early weeks.

### A) One 100,000-recipient campaign, continuous backlog

Demand stays far above every threshold, so the level climbs one step per week:

| Week | Weekly cap | Sent that week | Cumulative |
| ---- | ---------- | -------------- | ---------- |
| 0    | 500        | 500            | 500        |
| 1    | 1,500      | 1,500          | 2,000      |
| 2    | 5,000      | 5,000          | 7,000      |
| 3    | 12,000     | 12,000         | 19,000     |
| 4    | 25,000     | 25,000         | 44,000     |
| 5    | 40,000     | 40,000         | 84,000     |
| 6    | 50,000     | 16,000 (remaining) | 100,000 |

≈ 6 weeks + a couple of days. Within each week, the **daily cap** (from the API)
decides how the weekly allowance is spread across days; whatever is left when a
day's cap is hit is deferred to the next UTC day, and whatever is left when the
weekly cap is hit is deferred to the next week.

### B) A small 3,000-recipient campaign

- Week 0: demand 3,000 > 499 → start, send 500 (backlog 2,500).
- Week 1: demand 2,500 ≥ 1,500 → advance to week 1, send 1,500 (backlog 1,000).
- Week 2: demand 1,000 < 5,000 → **stay at week 1**, send the remaining 1,000.

Done in ~3 weeks, never climbing past the level the volume justified.

---

## 6. Configuration

Settings resolve from the D1 `settings` table → built-in defaults in
`shared/settings.ts`. Edit them on the console's **Settings → Email sending**
tab.

| Setting                     | Default                               | Meaning                                                          |
| --------------------------- | ------------------------------------- | ---------------------------------------------------------------- |
| `WARMUP_SCHEDULE`           | `[500,1500,5000,12000,25000,40000]`   | Per-level weekly caps; each value is also the entry threshold.   |
| `WARMUP_TARGET_WEEKLY`      | `50000`                               | Steady-state weekly cap once the schedule is exhausted.          |
| `WARMUP_FALLBACK_DAILY_CAP` | `1000`                                | Daily cap used only when the live API quota cannot be read.      |

### Required for the live daily cap

- **Secret** on the consumer worker: `CF_READ_API_TOKEN` with **Account → Email
  → Read** (`wrangler secret put CF_READ_API_TOKEN`).
- **Setting**: `ACCESS_ACCOUNT_ID` (already used elsewhere) provides the account
  id.

Without these the warmup still runs, using `WARMUP_FALLBACK_DAILY_CAP` as the
daily ceiling.

---

## 7. Visibility (read-only)

**Settings → Email sending → "Sending usage"** (super-admin only) shows:

- **Daily sending quota** — live from the Cloudflare API.
- **Emails sent (last 30 days)** — from the GraphQL Analytics API for the
  sending domain's zone, plus today's count.
- **Warmup week** — the current level, its weekly cap, and how much has been
  sent this week.
- **Weekly progression table** — every step, the daily cap (from the API), with
  the current week highlighted, plus the current backlog (demand).

All values are informational; they are computed from `warmup_state`, the `sends`
table and the Cloudflare API. Backed by `GET /api/email-sending-stats`.

---

## 8. Logs

The consumer writes to the `logs` table (visible on the console's Logs page):

| Event                          | When                                                             |
| ------------------------------ | ---------------------------------------------------------------- |
| `consumer.dispatch`            | Recipients were dispatched, or the daily budget was reached and the rest continue in the next window. |
| `consumer.send_paused`         | An account-level send error (rate or daily limit, sending not ready) paused sending until the logged time. |
| `consumer.quota_fetch_failed`  | The daily quota API read failed (fell back to last/known value). |

---

## 9. Source map

| Concern                            | File                                              |
| ---------------------------------- | ------------------------------------------------- |
| Pure warmup helpers / state machine | `shared/warmup.ts`                                |
| State + metrics DB helpers          | `shared/db.ts` (`computeDemand`, `loadWarmupState`, `advanceWarmupState`, `saveDailyCap`, `countSentSince`) |
| Daily quota API fetch               | `shared/quota.ts`                                 |
| Enforcement (queue handler)         | `workers/consumer/src/index.ts`                   |
| Read-only API + progression         | `workers/admin/src/index.ts` (`/api/email-sending-stats`) |
| UI panel + progression table        | `web/src/pages/Settings.tsx` (`EmailSendingUsage`, `WarmupProgression`) |
| Schema / migration                  | `db/schema.sql`, `db/migrations/0013_warmup_state.sql` |
