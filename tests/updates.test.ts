import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import {
  acquireJob, bindingQuery, credentialKeyPair, decryptCredential, encryptCredential,
  finishJob, jobById, UPDATE_SCHEMA, sqlStatements,
} from '../shared/update-state';
import { compareVersions, boundedBytes, validateArtifact, assertUpdateCompatible, type ReleaseArtifact } from '../shared/update-release';
import { deploymentMetadata } from '../shared/update-engine';
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

test('a durable update deploys all six Workers, admin last, and removes credential and lock only after verification', async () => {
  const f = await fixture();
  try {
    const input = { releaseId: 42, digest: f.digest, token: testToken, recoveryConfirmed: true };
    assert.equal((await f.api.preflight(input)).workers, 6);
    const { jobId } = await f.api.start(input, 'admin@example.com');
    assert.deepEqual(f.instances[0], { id: jobId, params: { jobId } });
    assert.ok(!JSON.stringify(f.instances).includes(testToken));
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

test('partial failure preserves checkpoints and installed version; recovery does not redeploy completed Workers', async () => {
  const f = await fixture('consumer');
  try {
    const { jobId } = await f.api.start({ releaseId: 42, digest: f.digest, token: testToken, recoveryConfirmed: true }, 'admin@example.com');
    await assert.rejects(f.workflow.run({ payload: { jobId } } as never, f.step as never));
    const job = await jobById(f.query, jobId);
    assert.equal(job.state, 'failed');
    assert.equal(job.credential, null);
    assert.ok(JSON.parse(job.checkpoint).workers.ingest.deployedVersion);
    assert.equal((await f.query("SELECT value FROM deployment_metadata WHERE key='product_version'"))[0]!.value, '2.4.0');
    await f.api.recover(jobId, testToken, 'admin@example.com');
    assert.ok(f.instances[1]!.id.startsWith(`${jobId}-r-`));
    f.clearFailure();
    await f.workflow.run({ payload: { jobId } } as never, f.step as never);
    assert.deepEqual(f.deployments, names);
    assert.equal((await jobById(f.query, jobId)).state, 'complete');
  } finally { f.network.mock.restore(); f.sqlite.close(); }
});

test('a saved token starts the same durable flow without requesting a per-update token', async () => {
  const f = await fixture();
  try {
    Object.assign(f.env, { CF_UPDATE_TOKEN: testToken });
    const input = { releaseId: 42, digest: f.digest, recoveryConfirmed: true };
    assert.equal((await f.api.preflight(input)).workers, 6);
    const { jobId } = await f.api.start(input, 'admin@example.com');
    assert.equal(await decryptCredential(await jobById(f.query, jobId), f.keys.privateKey), testToken);
    assert.ok(!JSON.stringify(await f.api.status()).includes(testToken));
  } finally { f.network.mock.restore(); f.sqlite.close(); }
});
