import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { changeTurnstile, readTurnstileConfig, turnstileStatus } from '../shared/turnstile';
import { bindingQuery } from '../shared/update-state';
import admin, { type Env as AdminEnv } from '../workers/admin/src/index';
import tracker, { type Env as TrackerEnv } from '../workers/tracker/src/index';

const key = `0x${'a'.repeat(22)}`;
const token = 'TEST-ONLY-TURNSTILE-SETUP-TOKEN';
const secret = 'TEST-ONLY-WIDGET-SECRET';
const account = 'a'.repeat(32);
const hostname = 'track.example.com';
const setup = { account, hostname, token, enabled: true, siteKey: key };

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT,updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE deployment_metadata(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE update_lock(id INTEGER PRIMARY KEY,job_id TEXT);
    CREATE TABLE admins(email TEXT PRIMARY KEY,role TEXT,capability TEXT);
    CREATE TABLE admins_newsletters(email TEXT,newsletter_id TEXT);
    CREATE TABLE newsletters(id TEXT,name TEXT,slug TEXT,from_address TEXT,allow_public_signup INTEGER,enabled INTEGER);
    INSERT INTO admins VALUES('root@example.com','super_admin','edit'),('admin@example.com','admin','edit');
    INSERT INTO newsletters VALUES('newsletter','Test newsletter','test',NULL,1,1);
  `);
  const prepare = (sql: string, params: unknown[] = []) => ({
    bind(...values: unknown[]) { return prepare(sql, values); },
    async all() { return { results: sqlite.prepare(sql).all(...params as never[]) }; },
    async first() { return sqlite.prepare(sql).get(...params as never[]) ?? null; },
    async run() { return { meta: sqlite.prepare(sql).run(...params as never[]) }; },
  });
  const db = { prepare } as unknown as D1Database;
  const query = bindingQuery(db);
  const requests: Array<{ path: string; method: string; authorization: string | null }> = [];
  let bindings = [
    { name: 'DB', type: 'd1' }, { name: 'ARCHIVE', type: 'r2_bucket' },
    { name: 'LINK_SIGNING_KEY', type: 'secret_text' }, { name: 'ATTACHMENT_SIGNING_KEY', type: 'secret_text' },
    { name: 'SEND_EMAIL', type: 'send_email' }, { name: 'APP_VERSION', type: 'plain_text', text: '2.4.1' },
  ];
  const state = { failWidget: 0, domains: [hostname], failPatch: false, failVerify: false, failDelete: false, deleted: false };
  const network = mock.method(globalThis, 'fetch', async (url, init) => {
    const path = String(url), method = init?.method ?? 'GET';
    requests.push({ path, method, authorization: new Headers(init?.headers).get('authorization') });
    const ok = (result: unknown) => Response.json({ success: true, result });
    if (path.includes('/challenges/widgets/')) {
      if (state.failWidget || state.deleted) return Response.json({ success: false, errors: [{ message: secret }] }, { status: state.failWidget || 404 });
      if (method === 'DELETE') {
        if (state.failDelete) return Response.json({ success: false }, { status: 500 });
        assert.equal(sqlite.prepare("SELECT value FROM settings WHERE key='TURNSTILE_ENABLED'").get()?.value, 'false');
        assert.ok(!bindings.some((binding) => binding.name.startsWith('TURNSTILE_')));
        state.deleted = true;
        return Response.json({ success: true });
      }
      return ok({ sitekey: key, secret, domains: state.domains });
    }
    if (path.endsWith('/workers/scripts/cf-newsletter-tracker/settings')) {
      if (method === 'PATCH') {
        if (state.failPatch) return Response.json({ success: false, errors: [{ message: secret }] }, { status: 500 });
        const form = init?.body as FormData;
        const metadata = JSON.parse(await (form.get('settings') as Blob).text()) as { bindings: typeof bindings };
        bindings = metadata.bindings.map((binding) => binding.type === 'inherit' ? { ...bindings.find((old) => old.name === binding.name)! } : binding);
        if (state.failVerify) bindings = bindings.filter((binding) => binding.name !== 'TURNSTILE_SECRET_KEY');
      }
      return ok({ bindings });
    }
    throw new Error(`Unexpected request: ${method} ${path}`);
  });
  const set = (name: string, value: string) => sqlite.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(name, value);
  const env = { DB: db, ACCESS_ACCOUNT_ID: account, CF_READ_API_TOKEN: token } as AdminEnv;
  return { sqlite, query, db, requests, state, set, env, network, close() { network.mock.restore(); sqlite.close(); } };
}

test('Turnstile rejects missing/malformed keys before making Cloudflare requests', async () => {
  const f = fixture();
  try {
    for (const siteKey of ['', 'not-a-key', 'x'.repeat(40)]) {
      await assert.rejects(changeTurnstile(f.query, { ...setup, siteKey }), /valid Turnstile site key/);
    }
    assert.equal(f.requests.length, 0);
    assert.equal((await readTurnstileConfig(f.query)).enabled, false);
  } finally { f.close(); }
});

test('unknown keys, wrong accounts/permissions and invalid hostnames never enable protection or leak secrets', async () => {
  const f = fixture();
  try {
    for (const status of [403, 404]) {
      f.state.failWidget = status;
      await assert.rejects(changeTurnstile(f.query, setup), (error: Error) => !error.message.includes(secret));
    }
    f.state.failWidget = 0;
    f.state.domains = ['example.com.attacker.test'];
    await assert.rejects(changeTurnstile(f.query, setup), /must allow the tracking hostname/);
    assert.ok(!f.requests.some((request) => request.method === 'PATCH'));
    assert.equal((await readTurnstileConfig(f.query)).enabled, false);
  } finally { f.close(); }
});

test('only a verified matching widget and tracker configuration can enable protection', async () => {
  const f = fixture();
  try {
    f.state.failPatch = true;
    await assert.rejects(changeTurnstile(f.query, setup), /could not complete/);
    assert.equal((await readTurnstileConfig(f.query)).enabled, false);
    f.state.failPatch = false;
    f.state.failVerify = true;
    await assert.rejects(changeTurnstile(f.query, setup), /could not be verified/);
    assert.equal((await readTurnstileConfig(f.query)).enabled, false);
    f.state.failVerify = false;
    f.state.domains = ['example.com'];
    await changeTurnstile(f.query, setup);
    assert.deepEqual(await readTurnstileConfig(f.query), { enabled: true, siteKey: key });
    const status = await turnstileStatus(f.query, account, hostname, token);
    assert.equal(status.ready, true);
    const persisted = JSON.stringify(f.sqlite.prepare('SELECT * FROM settings UNION ALL SELECT key,value,NULL FROM deployment_metadata').all());
    assert.ok(!persisted.includes(token) && !persisted.includes(secret));
    assert.ok(!JSON.stringify(status).includes(secret));
  } finally { f.close(); }
});

test('disabling requires exact-key confirmation, removes tracker keys, deletes the widget, and clears the saved public key', async () => {
  const f = fixture();
  try {
    await changeTurnstile(f.query, setup);
    const input = { ...setup, enabled: false };
    await assert.rejects(changeTurnstile(f.query, input), /Confirm deletion/);
    await assert.rejects(changeTurnstile(f.query, { ...input, siteKey: `0x${'b'.repeat(22)}`, confirmDelete: true }), /Confirm deletion/);
    assert.equal(f.state.deleted, false);
    f.state.failDelete = true;
    await assert.rejects(changeTurnstile(f.query, { ...input, confirmDelete: true }), /could not complete/);
    assert.deepEqual(await readTurnstileConfig(f.query), { enabled: false, siteKey: key });
    f.state.failDelete = false;
    await changeTurnstile(f.query, { ...input, confirmDelete: true });
    assert.equal(f.state.deleted, true);
    assert.deepEqual(await readTurnstileConfig(f.query), { enabled: false, siteKey: '' });
    const live = await turnstileStatus(f.query, account, hostname, token);
    assert.equal(live.ready, false);
  } finally { f.close(); }
});

test('cleanup can resume when the widget was already deleted externally', async () => {
  const f = fixture();
  try {
    await changeTurnstile(f.query, setup);
    f.state.deleted = true;
    await changeTurnstile(f.query, { ...setup, enabled: false, confirmDelete: true });
    assert.deepEqual(await readTurnstileConfig(f.query), { enabled: false, siteKey: '' });
  } finally { f.close(); }
});

test('active updates and concurrent configuration leases block Turnstile changes', async () => {
  const f = fixture();
  try {
    f.sqlite.prepare("INSERT INTO update_lock VALUES(1,'active-job')").run();
    await assert.rejects(changeTurnstile(f.query, setup), /active application update/);
    f.sqlite.exec('DELETE FROM update_lock');
    f.sqlite.prepare('INSERT INTO deployment_metadata VALUES(?,?)').run('turnstile_configuration_lock', JSON.stringify({ id: 'another', expires: Date.now() + 100000 }));
    await assert.rejects(changeTurnstile(f.query, setup), /Another Turnstile operation/);
    assert.equal(f.requests.length, 0);
  } finally { f.close(); }
});

test('settings API cannot bypass setup, and only same-origin super-admin requests may configure widgets', async () => {
  const f = fixture();
  const request = (path: string, body: unknown, email = 'root@example.com', origin = 'https://console.example.com') => new Request(`https://console.example.com${path}`, {
    method: 'PUT', headers: { 'cf-access-authenticated-user-email': email, 'content-type': 'application/json', origin, 'x-requested-with': 'XMLHttpRequest' },
    body: JSON.stringify(body),
  });
  try {
    const ctx = {} as ExecutionContext;
    const bypass = await admin.fetch(request('/api/settings', { updates: { TURNSTILE_ENABLED: 'true' } }), f.env, ctx);
    assert.equal(bypass.status, 400);
    assert.equal((await readTurnstileConfig(f.query)).enabled, false);
    assert.equal((await admin.fetch(request('/api/settings/turnstile', setup, 'admin@example.com'), f.env, ctx)).status, 403);
    assert.equal((await admin.fetch(request('/api/settings/turnstile', setup, 'root@example.com', 'https://attacker.test'), f.env, ctx)).status, 403);
    f.set('BASE_DOMAIN', 'example.com');
    f.set('ACCESS_ACCOUNT_ID', account);
    const runtimeToken = 'TEST-ONLY-STORED-RUNTIME-CREDENTIAL';
    f.env.CF_API_TOKEN = runtimeToken;
    // Browser-supplied credentials must never override the stored secret.
    assert.equal((await admin.fetch(request('/api/settings/turnstile', { ...setup, token: 'UNTRUSTED-BROWSER-CREDENTIAL' }), f.env, ctx)).status, 200);
    const response = await admin.fetch(new Request('https://console.example.com/api/settings/turnstile', { headers: { 'cf-access-authenticated-user-email': 'root@example.com' } }), f.env, ctx);
    const data = await response.json() as { ready: boolean };
    assert.equal(data.ready, true);
    assert.ok(!JSON.stringify(data).includes(secret));
    assert.ok(f.requests.every((request) => request.authorization === `Bearer ${runtimeToken}`));
    assert.equal((await admin.fetch(request('/api/settings/turnstile', { enabled: false, siteKey: key, confirmDelete: true }), f.env, ctx)).status, 200);
    assert.equal(f.state.deleted, true);
    assert.ok(f.requests.every((request) => request.authorization === `Bearer ${runtimeToken}`));
  } finally { f.close(); }
});

test('missing runtime credentials or permissions leave Turnstile disabled without accepting browser tokens', async () => {
  const f = fixture();
  const req = () => new Request('https://console.example.com/api/settings/turnstile', {
    method: 'PUT', headers: { 'cf-access-authenticated-user-email': 'root@example.com', origin: 'https://console.example.com', 'x-requested-with': 'XMLHttpRequest' },
    body: JSON.stringify({ enabled: true, siteKey: key, token }),
  });
  try {
    f.set('BASE_DOMAIN', 'example.com');
    f.set('ACCESS_ACCOUNT_ID', account);
    delete f.env.CF_READ_API_TOKEN;
    const missing = await admin.fetch(req(), f.env, {} as ExecutionContext);
    assert.equal(missing.status, 503);
    assert.match(await missing.text(), /stored runtime API token is missing/);
    assert.equal(f.requests.length, 0);
    f.env.CF_API_TOKEN = token;
    f.state.failWidget = 403;
    const denied = await admin.fetch(req(), f.env, {} as ExecutionContext);
    assert.equal(denied.status, 403);
    assert.match(await denied.text(), /Update the stored runtime token permissions/);
    assert.equal((await readTurnstileConfig(f.query)).enabled, false);
    assert.ok(!f.requests.some((request) => request.method !== 'GET'));
  } finally { f.close(); }
});

test('signup requires matching configured keys only when bot protection is enabled', async () => {
  const f = fixture();
  try {
    const env = { DB: f.db, SEND_EMAIL: { async send() { throw new Error('No email should be sent by GET'); } } } as TrackerEnv;
    const req = () => new Request('https://track.example.com/subscribe/test');
    const ctx = {} as ExecutionContext;
    assert.equal((await tracker.fetch(req(), env, ctx)).status, 200);
    f.set('TURNSTILE_ENABLED', 'true');
    f.set('TURNSTILE_SITE_KEY', key);
    assert.equal((await tracker.fetch(req(), env, ctx)).status, 503);
    env.TURNSTILE_SECRET_KEY = secret;
    env.TURNSTILE_SITE_KEY = 'wrong-site-key';
    assert.equal((await tracker.fetch(req(), env, ctx)).status, 503);
    env.TURNSTILE_SITE_KEY = key;
    const page = await tracker.fetch(req(), env, ctx);
    assert.equal(page.status, 200);
    assert.ok((await page.text()).includes(`data-sitekey="${key}"`));
    f.set('TURNSTILE_ENABLED', 'false');
    delete env.TURNSTILE_SECRET_KEY;
    assert.equal((await tracker.fetch(req(), env, ctx)).status, 200);
  } finally { f.close(); }
});
