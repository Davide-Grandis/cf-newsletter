import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import consumer, { type Env as ConsumerEnv } from '../workers/consumer/src/index';
import admin, { type Env as AdminEnv } from '../workers/admin/src/index';
import { createPendingSends, dispatch, sqlTime, STALE_CLAIM_MS } from '../shared/dispatch';
import type { QueueMessage } from '../shared/types';

const schema = readFileSync(resolve(process.env.PRODUCT_ROOT ?? 'product', 'db/schema.sql'), 'utf8');

type Queued = { body: QueueMessage; delaySeconds: number };

function fixture(opts: { dailyCap?: number; batchSize?: number } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(schema);
  const prepare = (sql: string, params: unknown[] = []) => ({
    bind(...values: unknown[]) { return prepare(sql, values); },
    async all() { return { results: sqlite.prepare(sql).all(...params as never[]) }; },
    async first() { return sqlite.prepare(sql).get(...params as never[]) ?? null; },
    async run() { return { meta: sqlite.prepare(sql).run(...params as never[]) }; },
  });
  const db = {
    prepare,
    async batch(statements: Array<{ run(): Promise<unknown> }>) { const out = []; for (const s of statements) out.push(await s.run()); return out; },
  } as unknown as D1Database;
  const cap = String(opts.dailyCap ?? 1000);
  for (const [key, value] of Object.entries({
    BASE_DOMAIN: 'example.com', WARMUP_MIN_DAILY: cap, WARMUP_MAX_DAILY: cap, DAILY_CAP_FALLBACK: cap, BATCH_SIZE: String(opts.batchSize ?? 2),
  })) sqlite.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, value);
  sqlite.exec(`
    INSERT INTO newsletters (id, name, inbound_address) VALUES ('nl', 'News', 'news@example.com');
    INSERT INTO campaigns (id, newsletter_id, subject, html, text, sent_by, status, created_at) VALUES
      ('c1', 'nl', 'First', '<p>Hi</p>', 'Hi', 'author@example.com', 'sending', '2026-01-01 00:00:00');
  `);
  const queued: Queued[] = [];
  const delivered: string[] = [];
  let failures: Record<string, () => Error> = {};
  const queue = {
    async send(body: QueueMessage, options?: { delaySeconds?: number }) { queued.push({ body, delaySeconds: options?.delaySeconds ?? 0 }); },
    async sendBatch(items: Array<{ body: QueueMessage }>) { for (const item of items) queued.push({ body: item.body, delaySeconds: 0 }); },
  } as unknown as Queue<QueueMessage>;
  const env = {
    DB: db, QUEUE: queue, ARCHIVE: {} as R2Bucket, LINK_SIGNING_KEY: 'k', ATTACHMENT_SIGNING_KEY: 'k',
    SEND_EMAIL: {
      async send(message: { to: string }) {
        const fail = failures[message.to];
        if (fail) throw fail();
        delivered.push(message.to);
      },
    },
  } as unknown as ConsumerEnv;
  const addSubscribers = (count: number, status = 'active', start = 1) => {
    for (let i = start; i < start + count; i++) {
      sqlite.prepare("INSERT INTO subscribers (newsletter_id, email, first_name, status, token) VALUES ('nl', ?, 'Sub', ?, ?)")
        .run(`s${i}@example.org`, status, crypto.randomUUID());
    }
  };
  const ingest = async (campaignId = 'c1') => {
    const total = await createPendingSends(db, campaignId, 'nl');
    sqlite.prepare('UPDATE campaigns SET total_recipients = ? WHERE id = ?').run(total, campaignId);
    queued.push({ body: { kind: 'dispatch' }, delaySeconds: 30 });
    return total;
  };
  // Deliver every message that is due (delay 0, or all when `includeDelayed`), as the queue would.
  const drain = async (includeDelayed = false) => {
    let retried = 0;
    for (let round = 0; round < 50; round++) {
      const due = queued.filter((m) => includeDelayed || m.delaySeconds === 0);
      if (!due.length) return retried;
      for (const m of due) queued.splice(queued.indexOf(m), 1);
      includeDelayed = false;
      const retries: QueueMessage[] = [];
      await consumer.queue({ messages: due.map((m) => ({ body: m.body, ack() {}, retry() { retries.push(m.body); } })) } as never, env, {} as ExecutionContext);
      retried += retries.length;
      for (const body of retries) queued.push({ body, delaySeconds: 0 });
    }
    throw new Error('queue did not settle');
  };
  // The next UTC day: today's sends count as yesterday's and the scheduled tick fires.
  const nextDay = async () => {
    sqlite.exec("UPDATE sends SET sent_at = datetime(sent_at, '-1 day') WHERE sent_at IS NOT NULL; UPDATE dispatch_state SET paused_until = NULL");
    return drain(true);
  };
  const row = (sql: string, ...params: unknown[]) => sqlite.prepare(sql).get(...params as never[]) as Record<string, unknown>;
  const rows = (sql: string, ...params: unknown[]) => sqlite.prepare(sql).all(...params as never[]) as Array<Record<string, unknown>>;
  return {
    sqlite, db, env, queue, queued, delivered, addSubscribers, ingest, drain, nextDay, row, rows,
    fail(address: string, error: () => Error) { failures[address] = error; },
    clearFailures() { failures = {}; },
  };
}

const coded = (code: string, message = code) => () => Object.assign(new Error(message), { code });

test('only active, confirmed subscribers get a pending send at ingest', async () => {
  const f = fixture();
  f.addSubscribers(5);
  f.addSubscribers(1, 'unsubscribed', 6);
  f.addSubscribers(1, 'active', 7);
  f.sqlite.prepare("UPDATE subscribers SET confirm_token = 'pending' WHERE email = 's7@example.org'").run();
  assert.equal(await f.ingest(), 5);
  assert.equal(f.row("SELECT COUNT(*) AS n FROM sends WHERE status = 'pending'").n, 5);
  assert.deepEqual(f.queued.map((m) => m.body), [{ kind: 'dispatch' }]);
});

test('a campaign larger than the daily cap continues day after day without retries and sends everyone once', async () => {
  const f = fixture({ dailyCap: 3, batchSize: 2 });
  f.addSubscribers(8);
  await f.ingest();
  assert.equal(await f.drain(true), 0);
  assert.equal(f.delivered.length, 3, 'Day 1 sends exactly the cap');
  const ticks = f.queued.filter((m) => m.body.kind === 'dispatch');
  assert.equal(ticks.length, 1, 'One scheduled dispatch waits for the next window; the backlog is not queued');
  assert.ok(ticks[0]!.delaySeconds > 0 && ticks[0]!.delaySeconds <= 86_400);
  assert.equal(f.queued.length, 1);

  let retries = 0;
  for (let day = 2; day <= 5 && f.delivered.length < 8; day++) retries += await f.nextDay();
  assert.equal(retries, 0, 'Waiting for the next day never uses a queue retry');
  assert.equal(f.delivered.length, 8);
  assert.equal(new Set(f.delivered).size, 8, 'Nobody receives the campaign twice');
  const campaign = f.row("SELECT status, sent_count, failed_count, total_recipients FROM campaigns WHERE id = 'c1'");
  assert.deepEqual({ ...campaign }, { status: 'done', sent_count: 8, failed_count: 0, total_recipients: 8 });
  await f.drain(true);
  assert.equal(f.queued.length, 0, 'Nothing is scheduled once the backlog is empty');
});

test('a redelivered or retried batch never sends twice or double-counts', async () => {
  const f = fixture({ batchSize: 3 });
  f.addSubscribers(3);
  await f.ingest();
  const dispatched: QueueMessage[] = [];
  const original = f.queue.sendBatch.bind(f.queue);
  f.queue.sendBatch = (async (items: Array<{ body: QueueMessage }>) => { dispatched.push(...items.map((i) => i.body)); return original(items as never); }) as never;
  await f.drain(true);
  assert.equal(f.delivered.length, 3);
  f.queued.push({ body: dispatched[0]!, delaySeconds: 0 });
  await f.drain();
  assert.equal(f.delivered.length, 3);
  assert.equal(f.row("SELECT sent_count FROM campaigns WHERE id = 'c1'").sent_count, 3);
});

test('rate and daily limits pause dispatching and release the batch without failing anyone', async () => {
  const f = fixture({ batchSize: 4 });
  f.addSubscribers(4);
  await f.ingest();
  f.fail('s2@example.org', coded('E_DAILY_LIMIT_EXCEEDED', 'Daily sending quota reached'));
  await f.drain(true);
  assert.deepEqual(f.delivered, ['s1@example.org']);
  assert.equal(f.row("SELECT COUNT(*) AS n FROM sends WHERE status = 'failed'").n, 0);
  assert.equal(f.row("SELECT COUNT(*) AS n FROM sends WHERE status = 'pending' AND batch_id IS NULL").n, 3, 'Unsent rows return to the backlog');
  const state = f.row('SELECT paused_until, pause_reason FROM dispatch_state');
  assert.match(String(state.pause_reason), /^E_DAILY_LIMIT_EXCEEDED/);
  assert.ok(Number(state.paused_until) > Date.now());
  f.clearFailures();
  await f.nextDay();
  assert.equal(f.delivered.length, 4);
  assert.equal(f.row("SELECT status FROM campaigns WHERE id = 'c1'").status, 'done');
});

test('suppressed addresses fail and bounce the subscriber; other coded errors fail; uncoded errors back off then fail', async () => {
  const f = fixture({ batchSize: 10 });
  f.addSubscribers(4);
  await f.ingest();
  f.fail('s1@example.org', coded('E_RECIPIENT_SUPPRESSED'));
  f.fail('s2@example.org', coded('E_VALIDATION_ERROR'));
  f.fail('s3@example.org', () => new Error('network reset'));
  await f.drain(true);
  assert.deepEqual(f.delivered, ['s4@example.org']);
  assert.deepEqual({ ...f.row("SELECT status, last_bounce_code FROM subscribers WHERE email = 's1@example.org'") }, { status: 'bounced', last_bounce_code: 'E_RECIPIENT_SUPPRESSED' });
  assert.equal(f.row("SELECT COUNT(*) AS n FROM events WHERE type = 'bounce' AND url = 'hard:E_RECIPIENT_SUPPRESSED'").n, 1);
  assert.equal(f.row("SELECT status FROM subscribers WHERE email = 's2@example.org'").status, 'active');
  const retry = f.row("SELECT s.status, s.attempts, s.next_attempt_at FROM sends s JOIN subscribers u ON u.id = s.subscriber_id WHERE u.email = 's3@example.org'");
  assert.equal(retry.status, 'pending');
  assert.equal(retry.attempts, 1);
  assert.ok(String(retry.next_attempt_at) > sqlTime(Date.now()));
  assert.equal(f.queued.filter((m) => m.body.kind === 'dispatch').length, 1, 'A dispatch is scheduled for the retry');
  for (let i = 0; i < 4; i++) {
    f.sqlite.exec("UPDATE sends SET next_attempt_at = datetime('now', '-1 minute') WHERE next_attempt_at IS NOT NULL AND status = 'pending'");
    await f.drain(true);
  }
  const final = f.row("SELECT s.status, s.attempts FROM sends s JOIN subscribers u ON u.id = s.subscriber_id WHERE u.email = 's3@example.org'");
  assert.deepEqual({ ...final }, { status: 'failed', attempts: 3 });
  assert.deepEqual({ ...f.row("SELECT status, sent_count, failed_count FROM campaigns WHERE id = 'c1'") }, { status: 'done', sent_count: 1, failed_count: 3 });
});

test('subscribers who leave before delivery are skipped and leave the campaign total', async () => {
  const f = fixture({ dailyCap: 1, batchSize: 1 });
  f.addSubscribers(2);
  await f.ingest();
  await f.drain(true);
  f.sqlite.prepare("UPDATE subscribers SET status = 'unsubscribed' WHERE email NOT IN (?)").run(f.delivered[0]!);
  await f.nextDay();
  assert.equal(f.delivered.length, 1);
  assert.deepEqual({ ...f.row("SELECT status, sent_count, total_recipients FROM campaigns WHERE id = 'c1'") }, { status: 'done', sent_count: 1, total_recipients: 1 });
});

test('batches queued by the previous release are adopted and sent once', async () => {
  const f = fixture({ batchSize: 10 });
  f.addSubscribers(3);
  const subs = f.rows('SELECT id, email, token FROM subscribers ORDER BY id');
  // The previous consumer already sent the first recipient before the update.
  f.sqlite.prepare("INSERT INTO sends (campaign_id, subscriber_id, status, sent_at) VALUES ('c1', ?, 'sent', datetime('now'))").run(subs[0]!.id as number);
  f.sqlite.exec("UPDATE campaigns SET total_recipients = 3, sent_count = 1 WHERE id = 'c1'");
  f.queued.push({ body: { campaignId: 'c1', batch: subs.map((s) => ({ subscriberId: Number(s.id), email: String(s.email), token: String(s.token) })) }, delaySeconds: 0 });
  await f.drain();
  assert.deepEqual(f.delivered.sort(), ['s2@example.org', 's3@example.org']);
  assert.deepEqual({ ...f.row("SELECT status, sent_count FROM campaigns WHERE id = 'c1'") }, { status: 'done', sent_count: 3 });
});

test('the dispatcher respects in-flight batches, keeps one scheduled tick and releases stale claims', async () => {
  const f = fixture();
  f.addSubscribers(6);
  await f.ingest();
  f.queued.length = 0;
  const budget = { capacity: 3, batchSize: 2, nextWindowMs: Date.now() + 3_600_000 };
  const first = await dispatch(f.env, budget);
  assert.deepEqual({ batches: first.batches, claimed: first.claimed }, { batches: 2, claimed: 3 });
  const second = await dispatch(f.env, budget);
  assert.equal(second.claimed, 0, 'Claimed but unsent rows count against the budget');
  assert.equal(f.queued.filter((m) => m.body.kind === 'dispatch').length, 1, 'Only one tick is scheduled');
  f.sqlite.prepare("UPDATE sends SET claimed_at = ? WHERE batch_id IS NOT NULL").run(sqlTime(Date.now() - STALE_CLAIM_MS - 60_000));
  const third = await dispatch(f.env, budget);
  assert.equal(third.claimed, 3, 'Stale claims are dispatched again');
  f.sqlite.exec('UPDATE dispatch_state SET locked_until = 9999999999999');
  assert.equal((await dispatch(f.env, budget)).reason, 'busy', 'A concurrent run does not spend the budget twice');
});

test('the campaign details report how many recipients were released for delivery and how many are paused', async () => {
  const f = fixture({ dailyCap: 3, batchSize: 2 });
  f.sqlite.exec("INSERT INTO admins (email, role, capability) VALUES ('root@example.com', 'super_admin', 'edit')");
  f.addSubscribers(8);
  await f.ingest();
  const progress = async () => {
    const res = await admin.fetch(new Request('https://console.example.com/api/campaigns/c1', {
      headers: { 'cf-access-authenticated-user-email': 'root@example.com' },
    }), { DB: f.db } as AdminEnv, {} as ExecutionContext);
    assert.equal(res.status, 200);
    const { campaign } = await res.json() as { campaign: Record<string, unknown> };
    return { released: campaign.released_count, paused: campaign.paused_count, next: campaign.next_release_at, paused_dispatch: campaign.dispatch_paused };
  };
  assert.deepEqual({ ...(await progress()), next: null }, { released: 0, paused: 8, next: null, paused_dispatch: false }, 'Before the first dispatch everything waits');
  await f.drain(true);
  const day1 = await progress();
  assert.deepEqual({ released: day1.released, paused: day1.paused }, { released: 3, paused: 5 }, 'Day 1 releases what fits in the remaining daily budget');
  const nextMidnight = new Date(); nextMidnight.setUTCHours(24, 0, 0, 0);
  assert.equal(day1.next, nextMidnight.toISOString(), 'Paused recipients are released from the next UTC midnight');
  await f.nextDay();
  assert.deepEqual({ released: (await progress()).released, paused: (await progress()).paused }, { released: 6, paused: 2 }, 'Counts update as each day is released');
  await f.nextDay();
  const done = await progress();
  assert.deepEqual({ released: done.released, paused: done.paused, next: done.next }, { released: 8, paused: 0, next: null });
});
