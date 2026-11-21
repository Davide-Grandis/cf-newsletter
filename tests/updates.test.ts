import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import {
  acquireJob, bindingQuery, credentialKeyPair, decryptCredential, encryptCredential,
  finishJob, jobById, UPDATE_SCHEMA, sqlStatements, updateIntentId, UPDATE_INTENT_TTL_MS,
} from '../shared/update-state';
import { compareVersions, boundedBytes, validateArtifact, assertUpdateCompatible, type ReleaseArtifact } from '../shared/update-release';
import { deploymentMetadata, saveCheckpoint } from '../shared/update-engine';
import { Updater, UpdateWorkflow } from '../workers/updater/src/index';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const names = ['ingest', 'consumer', 'tracker', 'bounce', 'cleanup', 'admin'];
const testToken = 'TEST-ONLY-UPDATE-TOKEN';

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(UPDATE_SCHEMA + `
    CREATE TABLE deployment_metadata(key TEXT PRIMARY KEY,value TEXT,updated_at TEXT DEFAULT (datetime('now')));
    INSERT INTO deployment_metadata(key,value) VALUES('product_version','2.4.0');
    CREATE TABLE schema_migrations(version TEXT PRIMARY KEY);
    CREATE TABLE sample(id INTEGER PRIMARY KEY);
  `);
  const prepare = (sql: string, params: unknown[] = []) => ({
    bind(...values: unknown[]) { return prepare(sql, values); },
    async all() { return { results: sqlite.prepare(sql).all(...params as never[]) }; },
    async first() { return sqlite.prepare(sql).get(...params as never[]) ?? null; },
    async run() { return { meta: sqlite.prepare(sql).run(...params as never[]) }; },
  });
  const db = {
    prepare,
    async batch(statements: Array<ReturnType<typeof prepare>>) {
      sqlite.exec('BEGIN');
      try { const results = []; for (const statement of statements) results.push(await statement.all()); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  const query = bindingQuery(db as unknown as D1Database);
  return { query, db, sqlite };
}

function artifact(): ReleaseArtifact {
  const workers = Object.fromEntries(names.map((name) => [name, `export default {name:'${name}'}`]));
  const schema = 'CREATE TABLE sample(id INTEGER PRIMARY KEY);';
  const migration = { id: 'add_field', file: 'add_field.sql', description: 'Add a test field', sql: 'ALTER TABLE sample ADD COLUMN label TEXT;', checkSql: "SELECT COUNT(*) AS present FROM pragma_table_info('sample') WHERE name='label'" };
  return {
    manifest: {
      format: 1, version: '2.5.0', commit: 'a'.repeat(40), timestamp: '2026-11-12T00:00:00Z',
      development: false, minimumInstallerVersion: '1.6.0',
      update: { minimumUpdaterVersion: '1.0.0', minimumAppVersion: '2.3.0', migrations: 'additive', infrastructure: false, compatibilityDate: '2026-09-10', compatibilityFlags: ['nodejs_compat'] },
      checksums: { ...Object.fromEntries(names.map((name) => [`workers/${name}.js`, hash(workers[name]!)])), 'db/schema.sql': hash(schema), 'db/updates/add_field.sql': hash(migration.sql) },
    },
    workers, assets: {}, schema, migrations: [migration],
  };
}

async function fixture(failWorker?: string) {
  const { query, db, sqlite } = database();
  const keys = await credentialKeyPair();
  await query("INSERT INTO deployment_metadata(key,value) VALUES('updater_public_key',?)", [keys.publicKey]);
  const payload = artifact();
  const body = JSON.stringify(payload);
  const digest = hash(body);
  const release = {
    id: 42, tag_name: 'v2.5.0', draft: false, prerelease: false, published_at: '2026-11-12T00:00:00Z',
    assets: [{ name: 'cf-newsletter-2.5.0.json', size: Buffer.byteLength(body), digest: `sha256:${digest}`, browser_download_url: 'https://github.com/Davide-Grandis/cf-newsletter/releases/download/v2.5.0/cf-newsletter-2.5.0.json' }],
  };
  const settings = Object.fromEntries(names.map((name) => [name, {
    bindings: [
      { type: 'd1', name: 'DB', id: 'db' }, { type: 'plain_text', name: 'APP_VERSION', text: '2.4.0' },
      { type: 'plain_text', name: 'APP_COMMIT', text: 'b'.repeat(40) },
      { type: 'r2_bucket', name: 'ARCHIVE', bucket_name: 'custom-archive', jurisdiction: 'eu' },
      ...['QUEUE', 'SEND_EMAIL', 'ASSETS', 'ASSETS_R2', 'UPDATER'].map((name) => ({ type: 'service', name, service: name })),
      { type: 'secret_text', name: 'LINK_SIGNING_KEY' }, { type: 'secret_text', name: 'ATTACHMENT_SIGNING_KEY' },
    ],
  }]));
  const versions = Object.fromEntries(names.map((name) => [name, `old-${name}`]));
  const deployments: string[] = [];
  let failure = failWorker;
  const network = mock.method(globalThis, 'fetch', async (url, init) => {
    const path = String(url);
    if (path.endsWith('/releases/42') || path.endsWith('/releases/latest')) return Response.json(release);
    if (path.includes('/releases/download/')) return new Response(body);
    const worker = /scripts\/cf-newsletter-(\w+)/.exec(path)?.[1];
    if (worker && path.endsWith('/settings')) return Response.json({ success: true, result: settings[worker] });
    if (worker && path.endsWith('/deployments')) return Response.json({ success: true, result: { deployments: [{ versions: [{ version_id: versions[worker], percentage: 100 }] }] } });
    if (path.endsWith('/assets-upload-session')) return Response.json({ success: true, result: { jwt: 'test-asset-session', buckets: [] } });
    if (worker && init?.method === 'PUT') {
      if (worker === failure) throw new Error('Simulated deployment failure.');
      const form = init.body as FormData;
      const metadata = JSON.parse(await (form.get('metadata') as Blob).text());
      assert.deepEqual(metadata.keep_bindings, ['secret_text']);
      assert.equal(metadata.bindings.find((binding: { name: string }) => binding.name === 'ARCHIVE').bucket_name, 'custom-archive');
      settings[worker]!.bindings = [...metadata.bindings, { type: 'secret_text', name: 'LINK_SIGNING_KEY' }, { type: 'secret_text', name: 'ATTACHMENT_SIGNING_KEY' }];
      versions[worker] = `new-${worker}`;
      deployments.push(worker);
      return Response.json({ success: true, result: {} });
    }
    throw new Error(`Unexpected test request: ${path}`);
  });
  const objects = new Map<string, string>();
  const instances: Array<{ id: string; params: { jobId: string } }> = [];
  const terminated: string[] = [];
  const env = {
    DB: db, ACCOUNT_ID: 'account', DATABASE_ID: 'db', UPDATE_PRIVATE_KEY: keys.privateKey,
    ARCHIVE: {
      async get(key: string) { const value = objects.get(key); return value ? { async json() { return JSON.parse(value); } } : null; },
      async put(key: string, value: string) { objects.set(key, value); },
      async delete(key: string) { objects.delete(key); },
    },
    UPDATE_WORKFLOW: {
      async create(input: { id: string; params: { jobId: string } }) { instances.push(input); },
      async get(id: string) { return { async terminate() { terminated.push(id); } }; },
    },
  };
  const api = new Updater({} as ExecutionContext, env as unknown as UpdaterBindings);
  const workflow = new UpdateWorkflow({} as ExecutionContext, env as unknown as UpdaterBindings);
  const step = {
    async do(_name: string, options: unknown, callback?: () => Promise<unknown>) {
      const action = callback ?? options as () => Promise<unknown>;
      return action();
    },
  };
  return { query, sqlite, env, api, workflow, step, release, digest, network, deployments, instances, keys, terminated, clearFailure() { failure = undefined; } };
}

test('SemVer compares numbers and prereleases rather than strings', () => {
  assert.ok(compareVersions('2.10.0', '2.9.0') > 0);
  assert.ok(compareVersions('2.5.0', '2.5.0-rc.10') > 0);
  assert.ok(compareVersions('2.5.0-rc.10', '2.5.0-rc.2') > 0);
  assert.throws(() => compareVersions('main', '2.5.0'));
});

test('artifact checksums, updater minimum, migration mode and downgrade guards fail closed', async () => {
  const value = artifact();
  await validateArtifact(value, '2.5.0', '1.6.0');
  value.workers.admin = 'tampered';
  await assert.rejects(validateArtifact(value, '2.5.0', '1.6.0'), /checksum mismatch/);
  assert.throws(() => assertUpdateCompatible(artifact(), '3.0.0'), /downgrade/);
  const newer = artifact(); newer.manifest.update!.minimumUpdaterVersion = '2.0.0';
  assert.throws(() => assertUpdateCompatible(newer, '2.4.0'), /updater engine/);
});

test('bounded downloads stop a chunked response without trusting Content-Length', async () => {
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(20)); controller.enqueue(new Uint8Array(20)); controller.close(); } });
  await assert.rejects(boundedBytes(new Response(body), 25), /size limit/);
});

test('temporary credentials are encrypted, bound to one job, and unusable after expiry', async () => {
  const keys = await credentialKeyPair();
  const cipher = await encryptCredential(testToken, keys.publicKey, 'one');
  assert.ok(!cipher.includes(testToken));
  const job = { id: 'one', credential: cipher, expires_at: Date.now() + 10_000 };
  assert.equal(await decryptCredential(job as never, keys.privateKey), testToken);
  await assert.rejects(decryptCredential({ ...job, id: 'two' } as never, keys.privateKey));
  await assert.rejects(decryptCredential({ ...job, expires_at: 0 } as never, keys.privateKey), /expired/);
});

test('console and hosted jobs share a lock; failures erase credentials but retain recovery ownership', async () => {
  const { query } = database();
  const common = { actor: 'admin@example.com', release: {} as never, digest: 'a', installedVersion: '2.4.0', credential: 'encrypted' };
  await acquireJob(query, { ...common, id: 'one', source: 'console' });
  await assert.rejects(acquireJob(query, { ...common, id: 'two', source: 'hosted' }), /Another update/);
  assert.equal((await jobById(query, 'two')).credential, null);
  await finishJob(query, 'one', 'failed');
  assert.equal((await jobById(query, 'one')).credential, null);
  assert.equal((await query('SELECT job_id FROM update_lock'))[0]!.job_id, 'one');
});

test('multi-statement migrations preserve quoted semicolons and run atomically', async () => {
  const { query } = database();
  assert.equal(sqlStatements("INSERT INTO sample(id) VALUES(1); SELECT ';'; -- comment;\nSELECT 2;").length, 3);
  await assert.rejects(query('INSERT INTO sample(id) VALUES(1); INSERT INTO missing_table VALUES(1);'));
  assert.equal((await query('SELECT * FROM sample')).length, 0);
});

test('deployment metadata preserves custom vars and internal updater binding but never serializes secret values', () => {
  const metadata = deploymentMetadata({
    bindings: [
      { name: 'CUSTOM', type: 'plain_text', text: 'keep-me' },
      { name: 'UPDATER', type: 'service', service: 'cf-newsletter-updater', entrypoint: 'Updater' },
      { name: 'CF_UPDATE_TOKEN', type: 'secret_text', text: 'must-not-be-copied' },
    ],
  }, artifact(), '2026-11-12T00:00:00Z');
  assert.ok(!JSON.stringify(metadata).includes('must-not-be-copied'));
  assert.ok(JSON.stringify(metadata).includes('keep-me'));
  assert.ok(JSON.stringify(metadata).includes('Updater'));
});

// Mirrors what the hosted installer stores after Cloudflare OAuth: the console never supplies a credential.
async function hostedJob(f: Awaited<ReturnType<typeof fixture>>, id = crypto.randomUUID()) {
  await acquireJob(f.query, {
    id, source: 'console', actor: 'admin@example.com', release: f.release as never, digest: f.digest,
    installedVersion: '2.4.0', credential: await encryptCredential(testToken, f.keys.publicKey, id),
  });
  await saveCheckpoint(f.query, id, { recoveryConfirmed: true });
  return id;
}

test('a durable update deploys all six Workers, admin last, and removes credential and lock only after verification', async () => {
  const f = await fixture();
  try {
    const jobId = await hostedJob(f);
    await f.workflow.run({ payload: { jobId } } as never, f.step as never);
    assert.deepEqual(f.deployments, names);
    const job = await jobById(f.query, jobId);
    assert.equal(job.state, 'complete');
    assert.equal(job.credential, null);
    assert.equal((await f.query('SELECT * FROM update_lock')).length, 0);
    assert.equal((await f.query("SELECT value FROM deployment_metadata WHERE key='product_version'"))[0]!.value, '2.5.0');
    assert.ok(!JSON.stringify(await f.query('SELECT * FROM update_events')).includes(testToken));
  } finally { f.network.mock.restore(); f.sqlite.close(); }
});

test('partial failure preserves checkpoints and installed version; a re-authorized job does not redeploy completed Workers', async () => {
  const f = await fixture('consumer');
  try {
    const jobId = await hostedJob(f);
    await assert.rejects(f.workflow.run({ payload: { jobId } } as never, f.step as never));
    const job = await jobById(f.query, jobId);
    assert.equal(job.state, 'failed');
    assert.equal(job.credential, null);
    assert.ok(JSON.parse(job.checkpoint).workers.ingest.deployedVersion);
    assert.equal((await f.query("SELECT value FROM deployment_metadata WHERE key='product_version'"))[0]!.value, '2.4.0');
    await f.query("UPDATE update_jobs SET state='queued',error=NULL,credential=?,expires_at=? WHERE id=?", [await encryptCredential(testToken, f.keys.publicKey, jobId), Date.now() + 60_000, jobId]);
    f.clearFailure();
    await f.workflow.run({ payload: { jobId } } as never, f.step as never);
    assert.deepEqual(f.deployments, names);
    assert.equal((await jobById(f.query, jobId)).state, 'complete');
  } finally { f.network.mock.restore(); f.sqlite.close(); }
});

test('the console records a hashed, single-use update intent and links to the hosted installer without any credential', async () => {
  const f = await fixture();
  try {
    const status = await f.api.status(true);
    assert.equal(status.release?.newer, true);
    assert.ok(!('tokenSaved' in status));
    const before = Date.now();
    const intent = await f.api.intent({ releaseId: 42, digest: f.digest }, 'admin@example.com');
    const url = new URL(intent.url);
    assert.equal(url.origin, 'https://installer.cf-newsletter.com');
    const nonce = url.searchParams.get('update')!;
    assert.match(nonce, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(intent.recovery, false);
    assert.ok(intent.expiresAt >= before + UPDATE_INTENT_TTL_MS && intent.expiresAt <= Date.now() + UPDATE_INTENT_TTL_MS);
    const rows = await f.query('SELECT * FROM update_intents');
    assert.equal(rows.length, 1);
    assert.deepEqual({ ...rows[0] }, {
      id: await updateIntentId(nonce), release_id: 42, digest: f.digest, version: '2.5.0', actor: 'admin@example.com',
      created_at: rows[0]!.created_at, expires_at: intent.expiresAt, used_at: null,
    });
    assert.ok(!JSON.stringify(rows).includes(nonce), 'Only the nonce hash is stored');
    const second = await f.api.intent({ releaseId: 42, digest: f.digest }, 'other@example.com');
    const remaining = await f.query('SELECT id,actor FROM update_intents');
    assert.deepEqual(remaining.map(row => ({ ...row })), [{ id: await updateIntentId(new URL(second.url).searchParams.get('update')!), actor: 'other@example.com' }], 'A new request supersedes unredeemed links');
    await f.query('UPDATE update_intents SET used_at=?', [Date.now()]);
    await f.api.intent({ releaseId: 42, digest: f.digest }, 'admin@example.com');
    assert.equal((await f.query('SELECT * FROM update_intents WHERE used_at IS NOT NULL')).length, 1, 'Redeemed requests are retained for audit');
    assert.equal(f.instances.length, 0, 'Recording an intent never starts a deployment');
  } finally { f.network.mock.restore(); f.sqlite.close(); }
});

test('update intents bind the reviewed release and refuse stale, current, running, or malformed requests', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.api.intent({ releaseId: 42, digest: f.digest }, 'admin@example.com'), /Check for updates again/);
    await f.api.status(true);
    await assert.rejects(f.api.intent({ releaseId: 42, digest: '0'.repeat(64) }, 'admin@example.com'), /release changed/);
    await assert.rejects(f.api.intent({ releaseId: 41, digest: f.digest }, 'admin@example.com'), /release changed/);
    await assert.rejects(f.api.intent({ releaseId: 42, digest: 'not-a-digest' }, 'admin@example.com'), /Check for updates again/);
    await assert.rejects(f.api.intent({ releaseId: 42, digest: f.digest }, ''), /administrator could not be identified/);
    await f.query("UPDATE deployment_metadata SET value='2.5.0' WHERE key='product_version'");
    await assert.rejects(f.api.intent({ releaseId: 42, digest: f.digest }, 'admin@example.com'), /already up to date/);
    await f.query("UPDATE deployment_metadata SET value='2.4.0' WHERE key='product_version'");
    const jobId = await hostedJob(f);
    await assert.rejects(f.api.intent({ releaseId: 42, digest: f.digest }, 'admin@example.com'), /already in progress/);
    await finishJob(f.query, jobId, 'Simulated failure.');
    const recovery = await f.api.intent({ releaseId: 42, digest: f.digest }, 'admin@example.com');
    assert.equal(recovery.recovery, true, 'A failed job is resumed with its original release');
    const status = await f.api.status();
    assert.equal(status.activeJob?.release_id, 42);
    assert.equal(status.activeJob?.digest, f.digest);
    assert.ok(!('release_json' in status.activeJob!));
    Object.assign(f.env, { INSTALLER_ORIGIN: 'https://installer-dev.cf-newsletter.com' });
    assert.equal(new URL((await f.api.intent({ releaseId: 42, digest: f.digest }, 'admin@example.com')).url).origin, 'https://installer-dev.cf-newsletter.com');
    for (const origin of ['http://installer.example', 'https://installer.example/path', 'javascript:alert(1)']) {
      Object.assign(f.env, { INSTALLER_ORIGIN: origin });
      await assert.rejects(f.api.intent({ releaseId: 42, digest: f.digest }, 'admin@example.com'));
    }
    assert.equal(f.instances.length, 0);
  } finally { f.network.mock.restore(); f.sqlite.close(); }
});

test('abandoning a failed job stops its Workflow and releases the lock without a credential', async () => {
  const f = await fixture();
  try {
    const jobId = await hostedJob(f);
    await assert.rejects(f.api.abandon(jobId, 'admin@example.com'), /Only a failed update/);
    await finishJob(f.query, jobId, 'Simulated failure.');
    await f.api.abandon(jobId, 'admin@example.com');
    assert.deepEqual(f.terminated, [jobId]);
    assert.equal((await jobById(f.query, jobId)).state, 'abandoned');
    assert.equal((await f.query('SELECT * FROM update_lock')).length, 0);
  } finally { f.network.mock.restore(); f.sqlite.close(); }
});
