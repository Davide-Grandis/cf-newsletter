// Send dispatch: the backlog lives in D1, not in the queue.
//
// Ingest writes one `sends` row per recipient with status 'pending'. The
// dispatcher (run by the consumer) claims due rows within the remaining daily
// budget by stamping them with a batch id, and enqueues one small message per
// batch. When the budget is spent it schedules a single dispatch message for the
// next window, so a campaign can take as many days as the warm-up needs without
// anything being retried or parked in the queue. The consumer sends exactly the
// rows of its batch that are still pending, so a redelivered message never sends
// twice, and send outcomes are recorded per row.

import type { QueueMessage, Recipient } from './types';

export const DISPATCH_LEASE_MS = 60_000;
// A claimed batch whose message never completed (e.g. dead-lettered) is
// released after this long, so its rows are dispatched again.
export const STALE_CLAIM_MS = 6 * 60 * 60_000;
// Bounds one dispatcher run; a larger budget continues in a follow-up run.
export const MAX_BATCHES_PER_RUN = 200;
// Per-recipient transient errors back off by these delays; then the send fails.
export const RETRY_DELAYS_MS = [5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];
// Queues accepts delays of at most 24 hours.
const MAX_DELAY_S = 86_400;
const QUEUE_SEND_BATCH = 100;
// A scheduled dispatch that is this overdue is assumed lost and is replaced.
const LOST_TICK_MS = 10 * 60_000;

export interface DispatchDeps { DB: D1Database; QUEUE: Queue<QueueMessage> }

export interface DispatchBudget {
  /** Sends still allowed today (daily cap minus already sent), before in-flight batches. */
  capacity: number;
  /** Recipients per queued batch. */
  batchSize: number;
  /** Start of the next sending window (next UTC midnight), in ms. */
  nextWindowMs: number;
}

export interface DispatchResult {
  ran: boolean;
  batches: number;
  claimed: number;
  remaining: number;
  nextTickAt: number | null;
  reason?: 'busy' | 'paused';
}

/** SQLite UTC text ('YYYY-MM-DD HH:MM:SS'), the format used by datetime('now'). */
export function sqlTime(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

function sqlTimeMs(value: string): number {
  return Date.parse(`${value.replace(' ', 'T')}Z`);
}

export function isDispatchMessage(body: unknown): body is { kind: 'dispatch'; at?: number } {
  return !!body && typeof body === 'object' && (body as { kind?: unknown }).kind === 'dispatch';
}

export function isSendMessage(body: unknown): body is { kind: 'send'; campaignId: string; batchId: string } {
  const b = body as { kind?: unknown; campaignId?: unknown; batchId?: unknown };
  return !!b && b.kind === 'send' && typeof b.campaignId === 'string' && typeof b.batchId === 'string';
}

/** Messages queued by releases before 2.6.5 carry the recipients themselves. */
export function isLegacyMessage(body: unknown): body is { campaignId: string; batch: Recipient[] } {
  const b = body as { kind?: unknown; campaignId?: unknown; batch?: unknown };
  return !!b && b.kind === undefined && typeof b.campaignId === 'string' && Array.isArray(b.batch);
}

/** Ingest: one pending send per active, confirmed subscriber. Returns the count. */
export async function createPendingSends(db: D1Database, campaignId: string, newsletterId: string): Promise<number> {
  const res = await db
    .prepare(
      "INSERT INTO sends (campaign_id, subscriber_id, status) " +
        "SELECT ?, id, 'pending' FROM subscribers " +
        "WHERE newsletter_id = ? AND status = 'active' AND confirm_token IS NULL " +
        'ON CONFLICT(campaign_id, subscriber_id) DO NOTHING',
    )
    .bind(campaignId, newsletterId)
    .run();
  return res.meta?.changes ?? 0;
}

/**
 * A legacy message lists recipients that the previous release had queued.
 * Their sends become pending rows (already-sent rows are left alone) and are
 * then dispatched like any other.
 */
export async function adoptLegacyBatch(db: D1Database, campaignId: string, recipients: Recipient[]): Promise<number> {
  if (!recipients.length) return 0;
  const results = await db.batch(recipients.map((r) => db
    .prepare(
      "INSERT INTO sends (campaign_id, subscriber_id, status) SELECT ?, ?, 'pending' " +
        'WHERE EXISTS (SELECT 1 FROM campaigns WHERE id = ?) ON CONFLICT(campaign_id, subscriber_id) DO NOTHING',
    )
    .bind(campaignId, r.subscriberId, campaignId)));
  return results.reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
}

/** Ask for a dispatcher run soon (e.g. after ingest), outside the single scheduled tick. */
export async function requestDispatch(queue: Queue<QueueMessage>, delaySeconds = 0): Promise<void> {
  await queue.send({ kind: 'dispatch' }, delaySeconds > 0 ? { delaySeconds } : undefined);
}

/**
 * Schedule the dispatcher for `atMs`, keeping at most one scheduled message:
 * nothing is sent when a tick is already due no later than `atMs`.
 */
export async function scheduleDispatch(deps: DispatchDeps, atMs: number, now = Date.now()): Promise<number | null> {
  // Whole seconds, like the times stored in `sends`, so equal times dedupe.
  const at = Math.ceil(Math.max(atMs, now) / 1000) * 1000;
  const res = await deps.DB
    .prepare('UPDATE dispatch_state SET next_tick_at = ? WHERE id = 1 AND (next_tick_at IS NULL OR next_tick_at > ? OR next_tick_at < ?)')
    .bind(at, at, now - LOST_TICK_MS)
    .run();
  if (!res.meta?.changes) return null;
  try {
    const delaySeconds = Math.min(MAX_DELAY_S, Math.max(0, Math.ceil((at - now) / 1000)));
    await deps.QUEUE.send({ kind: 'dispatch', at }, delaySeconds > 0 ? { delaySeconds } : undefined);
  } catch (err) {
    await deps.DB.prepare('UPDATE dispatch_state SET next_tick_at = NULL WHERE id = 1 AND next_tick_at = ?').bind(at).run();
    throw err;
  }
  return at;
}

/** A scheduled tick arrived: it no longer blocks scheduling another one. */
export async function tickReceived(db: D1Database, at: number | undefined): Promise<void> {
  if (typeof at !== 'number') return;
  await db.prepare('UPDATE dispatch_state SET next_tick_at = NULL WHERE id = 1 AND next_tick_at = ?').bind(at).run();
}

/** When sending is paused after an account-level error (ms), or null. */
export async function pausedUntil(db: D1Database, now = Date.now()): Promise<number | null> {
  const row = await db.prepare('SELECT paused_until FROM dispatch_state WHERE id = 1').first<{ paused_until: number | null }>();
  return row?.paused_until && row.paused_until > now ? row.paused_until : null;
}

/** Account-level send errors pause all dispatching until `untilMs`. */
export async function pauseDispatch(db: D1Database, untilMs: number, reason: string): Promise<void> {
  await db
    .prepare('UPDATE dispatch_state SET paused_until = MAX(COALESCE(paused_until, 0), ?), pause_reason = ? WHERE id = 1')
    .bind(Math.round(untilMs), reason.slice(0, 200))
    .run();
}

/**
 * Record each in-progress campaign's delivery state (`campaigns.delivery_state`):
 * 'sending' while one of its batches is out for delivery, else 'scheduled' while
 * recipients wait for a later day's budget or a retry, or 'paused' while sending
 * is held after an account-level error. Called whenever claims change.
 */
export async function refreshDeliveryStates(db: D1Database, now = Date.now()): Promise<void> {
  await db
    .prepare(
      "UPDATE campaigns SET delivery_state = CASE " +
        "WHEN EXISTS (SELECT 1 FROM sends s WHERE s.campaign_id = campaigns.id AND s.status = 'pending' AND s.batch_id IS NOT NULL) THEN 'sending' " +
        "WHEN EXISTS (SELECT 1 FROM sends s WHERE s.campaign_id = campaigns.id AND s.status = 'pending') THEN " +
        "CASE WHEN COALESCE((SELECT paused_until FROM dispatch_state WHERE id = 1), 0) > ? THEN 'paused' ELSE 'scheduled' END " +
        "ELSE delivery_state END WHERE status = 'sending'",
    )
    .bind(now)
    .run();
}

/**
 * Claim due pending rows within the budget and enqueue one message per batch,
 * then schedule the next run: the next window when the budget is spent, the
 * earliest retry when only backed-off rows remain, or none when idle.
 */
export async function dispatch(deps: DispatchDeps, budget: DispatchBudget, now = Date.now()): Promise<DispatchResult> {
  const db = deps.DB;
  const lease = now + DISPATCH_LEASE_MS;
  const acquired = await db
    .prepare('UPDATE dispatch_state SET locked_until = ? WHERE id = 1 AND (locked_until IS NULL OR locked_until < ?)')
    .bind(lease, now)
    .run();
  if (!acquired.meta?.changes) {
    // Another run holds the lease; make sure rows it may not have seen are picked up.
    const nextTickAt = await scheduleDispatch(deps, lease, now);
    return { ran: false, batches: 0, claimed: 0, remaining: 0, nextTickAt, reason: 'busy' };
  }
  try {
    const state = await db.prepare('SELECT paused_until FROM dispatch_state WHERE id = 1').first<{ paused_until: number | null }>();
    if (state?.paused_until && state.paused_until > now) {
      const nextTickAt = await scheduleDispatch(deps, state.paused_until, now);
      await refreshDeliveryStates(db, now);
      return { ran: false, batches: 0, claimed: 0, remaining: 0, nextTickAt, reason: 'paused' };
    }

    await db
      .prepare("UPDATE sends SET batch_id = NULL, claimed_at = NULL WHERE status = 'pending' AND batch_id IS NOT NULL AND claimed_at < ?")
      .bind(sqlTime(now - STALE_CLAIM_MS))
      .run();
    const inFlight = (await db
      .prepare("SELECT COUNT(*) AS n FROM sends WHERE status = 'pending' AND batch_id IS NOT NULL")
      .first<{ n: number }>())?.n ?? 0;

    const nowSql = sqlTime(now);
    const batchSize = Math.max(1, Math.floor(budget.batchSize));
    let remaining = Math.max(0, Math.floor(budget.capacity) - inFlight);
    const messages: Array<{ kind: 'send'; campaignId: string; batchId: string }> = [];
    let claimed = 0;
    while (remaining > 0 && messages.length < MAX_BATCHES_PER_RUN) {
      // Oldest campaign first.
      const next = await db
        .prepare(
          'SELECT s.campaign_id FROM sends s JOIN campaigns c ON c.id = s.campaign_id ' +
            "WHERE s.status = 'pending' AND s.batch_id IS NULL AND (s.next_attempt_at IS NULL OR s.next_attempt_at <= ?) " +
            "AND c.status = 'sending' ORDER BY c.created_at, c.id LIMIT 1",
        )
        .bind(nowSql)
        .first<{ campaign_id: string }>();
      if (!next) break;
      const batchId = crypto.randomUUID();
      const res = await db
        .prepare(
          'UPDATE sends SET batch_id = ?, claimed_at = ? WHERE id IN (' +
            "SELECT id FROM sends WHERE campaign_id = ? AND status = 'pending' AND batch_id IS NULL " +
            'AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY id LIMIT ?)',
        )
        .bind(batchId, nowSql, next.campaign_id, nowSql, Math.min(batchSize, remaining))
        .run();
      const n = res.meta?.changes ?? 0;
      if (!n) break;
      messages.push({ kind: 'send', campaignId: next.campaign_id, batchId });
      claimed += n;
      remaining -= n;
    }

    for (let i = 0; i < messages.length; i += QUEUE_SEND_BATCH) {
      const chunk = messages.slice(i, i + QUEUE_SEND_BATCH);
      try {
        await deps.QUEUE.sendBatch(chunk.map((body) => ({ body })));
      } catch (err) {
        // Nothing from this chunk on was enqueued: release those claims.
        await db.batch(messages.slice(i).map((m) => db
          .prepare("UPDATE sends SET batch_id = NULL, claimed_at = NULL WHERE batch_id = ? AND status = 'pending'")
          .bind(m.batchId)));
        throw err;
      }
    }

    let nextTickAt: number | null = null;
    if (messages.length >= MAX_BATCHES_PER_RUN && remaining > 0) {
      nextTickAt = await scheduleDispatch(deps, now, now);
    } else {
      const due = (await db
        .prepare(
          'SELECT COUNT(*) AS n FROM sends s JOIN campaigns c ON c.id = s.campaign_id ' +
            "WHERE s.status = 'pending' AND s.batch_id IS NULL AND (s.next_attempt_at IS NULL OR s.next_attempt_at <= ?) AND c.status = 'sending'",
        )
        .bind(nowSql)
        .first<{ n: number }>())?.n ?? 0;
      if (due > 0) {
        nextTickAt = await scheduleDispatch(deps, budget.nextWindowMs, now);
      } else {
        const retry = await db
          .prepare(
            'SELECT MIN(s.next_attempt_at) AS at FROM sends s JOIN campaigns c ON c.id = s.campaign_id ' +
              "WHERE s.status = 'pending' AND s.batch_id IS NULL AND s.next_attempt_at > ? AND c.status = 'sending'",
          )
          .bind(nowSql)
          .first<{ at: string | null }>();
        if (retry?.at) nextTickAt = await scheduleDispatch(deps, sqlTimeMs(retry.at), now);
      }
    }
    await refreshDeliveryStates(db, now);
    return { ran: true, batches: messages.length, claimed, remaining, nextTickAt };
  } finally {
    await db.prepare('UPDATE dispatch_state SET locked_until = NULL WHERE id = 1 AND locked_until = ?').bind(lease).run();
  }
}

// ---------------------------------------------------------------------------
// Send outcomes (consumer)
// ---------------------------------------------------------------------------

export interface ClaimedSend {
  send_id: number;
  attempts: number;
  subscriber_id: number;
  email: string;
  first_name: string | null;
  last_name: string | null;
  token: string;
  subscriber_status: string;
  confirm_token: string | null;
}

/** The rows of a batch that are still pending (already-sent rows are skipped). */
export async function claimedSends(db: D1Database, campaignId: string, batchId: string): Promise<ClaimedSend[]> {
  const { results } = await db
    .prepare(
      'SELECT s.id AS send_id, s.attempts, sub.id AS subscriber_id, sub.email, sub.first_name, sub.last_name, sub.token, ' +
        'sub.status AS subscriber_status, sub.confirm_token FROM sends s JOIN subscribers sub ON sub.id = s.subscriber_id ' +
        "WHERE s.campaign_id = ? AND s.batch_id = ? AND s.status = 'pending' ORDER BY s.id",
    )
    .bind(campaignId, batchId)
    .all<ClaimedSend>();
  return results ?? [];
}

/**
 * Record a final outcome once: only a still-pending row changes, and only then
 * is the campaign counter incremented, so redelivery never double-counts.
 */
export async function completeSend(
  db: D1Database,
  sendId: number,
  campaignId: string,
  outcome: 'sent' | 'failed',
  detail: { messageId?: string; error?: string; tracked?: boolean } = {},
): Promise<boolean> {
  // One transaction: the counter moves only if the row is still pending, then
  // the row records the outcome, so the two never drift apart.
  const counter = outcome === 'sent' ? 'sent_count = sent_count + 1' : 'failed_count = failed_count + 1';
  const [, res] = await db.batch([
    db.prepare(`UPDATE campaigns SET ${counter} WHERE id = ? AND EXISTS (SELECT 1 FROM sends WHERE id = ? AND status = 'pending')`).bind(campaignId, sendId),
    outcome === 'sent'
      ? db
        .prepare("UPDATE sends SET status = 'sent', sent_at = datetime('now'), message_id = ?, tracked = ?, error = NULL, batch_id = NULL WHERE id = ? AND status = 'pending'")
        .bind(detail.messageId ?? null, detail.tracked ? 1 : 0, sendId)
      : db
        .prepare("UPDATE sends SET status = 'failed', error = ?, batch_id = NULL WHERE id = ? AND status = 'pending'")
        .bind((detail.error ?? 'send failed').slice(0, 500), sendId),
  ]);
  return (res?.meta?.changes ?? 0) > 0;
}

/** A subscriber who left before delivery: drop the send and shrink the campaign total. */
export async function dropSend(db: D1Database, sendId: number, campaignId: string): Promise<void> {
  await db.batch([
    db.prepare("UPDATE campaigns SET total_recipients = MAX(total_recipients - 1, 0) WHERE id = ? AND EXISTS (SELECT 1 FROM sends WHERE id = ? AND status = 'pending')").bind(campaignId, sendId),
    db.prepare("DELETE FROM sends WHERE id = ? AND status = 'pending'").bind(sendId),
  ]);
}

/** Transient error for one recipient: back off and let the dispatcher retry it. */
export async function retrySendLater(db: D1Database, sendId: number, attempts: number, atMs: number, error: string): Promise<void> {
  await db
    .prepare("UPDATE sends SET batch_id = NULL, claimed_at = NULL, attempts = ?, next_attempt_at = ?, error = ? WHERE id = ? AND status = 'pending'")
    .bind(attempts, sqlTime(atMs), error.slice(0, 500), sendId)
    .run();
}

/** Return a batch's unsent rows to the backlog (e.g. on an account-level pause). */
export async function releaseBatch(db: D1Database, batchId: string): Promise<void> {
  await db.prepare("UPDATE sends SET batch_id = NULL, claimed_at = NULL WHERE batch_id = ? AND status = 'pending'").bind(batchId).run();
}

/** Cloudflare refused the address (suppression list: hard bounce or complaint). */
export async function suppressSubscriber(db: D1Database, campaignId: string, subscriberId: number, code: string): Promise<void> {
  const res = await db
    .prepare(
      "UPDATE subscribers SET status = 'bounced', bounce_count = bounce_count + 1, hard_bounce_count = hard_bounce_count + 1, " +
        "last_bounce_type = 'hard', last_bounce_code = ?, last_bounce_at = datetime('now') WHERE id = ? AND status = 'active'",
    )
    .bind(code, subscriberId)
    .run();
  if (res.meta?.changes) {
    await db
      .prepare("INSERT INTO events (campaign_id, subscriber_id, type, url) VALUES (?, ?, 'bounce', ?)")
      .bind(campaignId, subscriberId, `hard:${code}`)
      .run();
  }
}

// ---------------------------------------------------------------------------
// Send error classification
// ---------------------------------------------------------------------------

export type SendErrorAction =
  | { kind: 'pause'; untilMs: number; code: string }
  | { kind: 'suppressed'; code: string }
  | { kind: 'permanent'; code: string }
  | { kind: 'retry'; code: string };

const ACCOUNT_PAUSE_MS = 60 * 60_000;
const SHORT_PAUSE_MS = 5 * 60_000;

/**
 * Map an Email Sending error to an action. Account-level conditions pause all
 * dispatching (and never fail recipients); a suppressed address is permanent
 * for that subscriber; other coded errors are permanent for the send; errors
 * without a code (network, unexpected) are retried with backoff.
 */
export function classifySendError(err: unknown, now: number, nextWindowMs: number): SendErrorAction {
  const code = typeof (err as { code?: unknown })?.code === 'string' ? (err as { code: string }).code : '';
  switch (code) {
    case 'E_DAILY_LIMIT_EXCEEDED':
      return { kind: 'pause', untilMs: nextWindowMs, code };
    case 'E_RATE_LIMIT_EXCEEDED':
    case 'E_INTERNAL_SERVER_ERROR':
      return { kind: 'pause', untilMs: now + SHORT_PAUSE_MS, code };
    case 'E_EMAIL_SENDING_NOT_READY':
    case 'E_SENDER_DOMAIN_NOT_AVAILABLE':
    case 'E_SENDER_DOMAIN_NOT_CONFIGURED':
    case 'E_SENDER_NOT_VERIFIED':
    case 'E_ACCOUNT_SUSPENDED':
      return { kind: 'pause', untilMs: now + ACCOUNT_PAUSE_MS, code };
    case 'E_RECIPIENT_SUPPRESSED':
      return { kind: 'suppressed', code };
    default:
      if (code.startsWith('E_') || err instanceof TypeError) return { kind: 'permanent', code: code || 'TypeError' };
      return { kind: 'retry', code: code || 'unknown' };
  }
}
