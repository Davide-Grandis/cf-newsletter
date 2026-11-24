import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import tracker, { type Env as TrackerEnv } from '../workers/tracker/src/index';

const schema = readFileSync(resolve(process.env.PRODUCT_ROOT ?? 'product', 'db/schema.sql'), 'utf8');

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(schema);
  sqlite.exec(`
    INSERT INTO settings (key, value) VALUES ('BASE_DOMAIN', 'example.com');
    INSERT INTO newsletters (id, name, inbound_address, slug, allow_public_signup, enabled) VALUES ('nl', 'News', 'news@example.com', 'news', 1, 1);
    INSERT INTO subscribers (newsletter_id, email, first_name, status, token, confirm_token) VALUES
      ('nl', 'member@example.org', 'Mem', 'active', 'member-token', NULL),
      ('nl', 'pending@example.org', 'Pen', 'active', 'pending-token', 'old-confirm');
  `);
  const prepare = (sql: string, params: unknown[] = []) => ({
    bind(...values: unknown[]) { return prepare(sql, values); },
    async all() { return { results: sqlite.prepare(sql).all(...params as never[]) }; },
    async first() { return sqlite.prepare(sql).get(...params as never[]) ?? null; },
    async run() { return { meta: sqlite.prepare(sql).run(...params as never[]) }; },
  });
  const db = { prepare, async batch(s: Array<{ run(): Promise<unknown> }>) { const o = []; for (const x of s) o.push(await x.run()); return o; } } as unknown as D1Database;
  const sent: Array<{ to: string; raw: string }> = [];
  const env = {
    DB: db, ARCHIVE: {} as R2Bucket, LINK_SIGNING_KEY: 'k', ATTACHMENT_SIGNING_KEY: 'k',
    SEND_EMAIL: { async send(m: { to: string; raw: string }) { sent.push({ to: m.to, raw: m.raw }); } },
  } as unknown as TrackerEnv;
  const signup = async (email: string, firstName = 'New') => {
    const work: Promise<unknown>[] = [];
    const body = new URLSearchParams({ email, first_name: firstName });
    const res = await tracker.fetch(new Request('https://track.example.com/subscribe/news', {
      method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' },
    }), env, { waitUntil(p: Promise<unknown>) { work.push(p); }, passThroughOnException() {} } as unknown as ExecutionContext);
    await Promise.all(work);
    return { status: res.status, html: await res.text() };
  };
  const row = (sql: string, ...p: unknown[]) => sqlite.prepare(sql).get(...p as never[]) as Record<string, unknown>;
  const sql = (q: string, ...p: unknown[]) => sqlite.prepare(q).run(...p as never[]);
  const verify = async (id: number, token: string) => {
    const res = await tracker.fetch(new Request(`https://track.example.com/verify/${id}?t=${encodeURIComponent(token)}`), env,
      { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext);
    return { status: res.status, html: await res.text() };
  };
  return { signup, sent, row, sql, verify };
}

const page = (html: string) => html.replace(/[\s\S]*<main class="card">|<\/main>[\s\S]*/g, '').replace(/<strong>[^<]*<\/strong>/, '<strong>EMAIL</strong>');

test('the signup page is identical whether or not the address is already subscribed', async () => {
  const f = fixture();
  const member = await f.signup('member@example.org');
  const stranger = await f.signup('new@example.org');
  assert.equal(member.status, 200);
  assert.equal(stranger.status, 200);
  assert.equal(page(member.html), page(stranger.html));
  assert.doesNotMatch(member.html, /already subscribed/i);
});

test('an existing subscriber is left untouched and told by email, at most once a day', async () => {
  const f = fixture();
  await f.signup('member@example.org', 'Intruder');
  assert.deepEqual({ ...f.row("SELECT first_name, status, token, confirm_token FROM subscribers WHERE email = 'member@example.org'") },
    { first_name: 'Mem', status: 'active', token: 'member-token', confirm_token: null }, 'The record is not changed');
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0]!.to, 'member@example.org');
  assert.match(f.sent[0]!.raw, /Subject: You're already subscribed to News/);
  assert.match(f.sent[0]!.raw, /\/u\/1\?t=3Dmember-token|\/u\/1\?t=member-token/, 'The notice carries the unsubscribe link');
  await f.signup('member@example.org');
  assert.equal(f.sent.length, 1, 'A second attempt the same day sends nothing');
});

test('new and pending signups still get a confirmation email', async () => {
  const f = fixture();
  await f.signup('new@example.org');
  await f.signup('pending@example.org');
  assert.deepEqual(f.sent.map((m) => m.to), ['new@example.org', 'pending@example.org']);
  assert.ok(f.sent.every((m) => /Subject: Confirm your subscription to News/.test(m.raw)));
  assert.notEqual(f.row("SELECT confirm_token FROM subscribers WHERE email = 'pending@example.org'").confirm_token, 'old-confirm');
});

test('a second signup within the hour sends no new confirmation and keeps the first link working', async () => {
  const f = fixture();
  await f.signup('new@example.org');
  const first = f.row("SELECT id, confirm_token FROM subscribers WHERE email = 'new@example.org'");
  const again = await f.signup('new@example.org', 'Other');
  assert.equal(again.status, 200);
  assert.match(again.html, /Almost there/);
  assert.equal(f.sent.length, 1, 'Only the first confirmation was sent');
  assert.equal(f.row("SELECT confirm_token FROM subscribers WHERE email = 'new@example.org'").confirm_token, first.confirm_token);
  const res = await f.verify(Number(first.id), String(first.confirm_token));
  assert.equal(res.status, 200);
  assert.match(res.html, /confirmed/i);
});

test('confirmation links expire after 7 days; links issued before expiry existed still work', async () => {
  const f = fixture();
  const old = `${Date.now() - 8 * 24 * 60 * 60 * 1000}.${crypto.randomUUID()}`;
  f.sql("UPDATE subscribers SET confirm_token = ? WHERE email = 'pending@example.org'", old);
  const id = Number(f.row("SELECT id FROM subscribers WHERE email = 'pending@example.org'").id);
  const expired = await f.verify(id, old);
  assert.equal(expired.status, 410);
  assert.match(expired.html, /expired/i);
  assert.equal(f.row('SELECT confirm_token FROM subscribers WHERE id = ?', id).confirm_token, old, 'Not confirmed');
  const legacy = crypto.randomUUID();
  f.sql('UPDATE subscribers SET confirm_token = ? WHERE id = ?', legacy, id);
  assert.equal((await f.verify(id, legacy)).status, 200);
  assert.equal(f.row('SELECT confirm_token FROM subscribers WHERE id = ?', id).confirm_token, null);
});
