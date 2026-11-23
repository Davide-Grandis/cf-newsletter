import { PRODUCT_WORKERS, assertUpdateCompatible, compareVersions, type ProductWorker, type ReleaseArtifact } from './update-release';
import { jobById, updateEvent, type Query } from './update-state';

export const CF_API = 'https://api.cloudflare.com/client/v4';
export const WORKFLOW_NAME = 'cf-newsletter-update';
export const UPDATER_NAME = 'cf-newsletter-updater';
type Binding = { type: string; name: string; [key: string]: unknown };
type Settings = { bindings: Binding[]; compatibility_date?: string; compatibility_flags?: string[]; [key: string]: unknown };
interface Snapshot { settings: Settings; previousVersion: string; deployedVersion?: string }
interface Checkpoint { workers?: Partial<Record<ProductWorker, Snapshot>>; assetsJwt?: string; recoveryBookmark?: string; recoveryConfirmed?: boolean }

export async function cloudflare<T>(token: string, path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (typeof options.body === 'string') headers.set('Content-Type', 'application/json');
  const response = await fetch(`${CF_API}${path}`, { ...options, headers, signal: AbortSignal.timeout(60_000) });
  const payload = await response.json() as { success?: boolean; result: T };
  // Upstream error text may reflect input. Persist only the endpoint and status.
  if (!response.ok || payload.success === false) throw new Error(`Cloudflare ${options.method ?? 'GET'} ${path.split('?')[0]} failed (HTTP ${response.status}). Check token permissions and resource state.`);
  return payload.result;
}

export function apiQuery(token: string, account: string, database: string): Query {
  return async (sql, params = []) => {
    const result = await cloudflare<Array<{ success?: boolean; results?: Array<Record<string, unknown>> }>>(token, `/accounts/${account}/d1/database/${database}/query`, {
      method: 'POST', body: JSON.stringify({ sql, params }),
    });
    if (result.some((item) => item.success === false)) throw new Error('Database update query failed.');
    return result.flatMap((item) => item.results ?? []);
  };
}

async function activeVersion(token: string, account: string, name: string): Promise<string> {
  const result = await cloudflare<{ deployments: Array<{ versions: Array<{ version_id: string; percentage: number }> }> }>(
    token, `/accounts/${account}/workers/scripts/${name}/deployments`,
  );
  const active = result.deployments[0]?.versions;
  if (active?.length !== 1 || active[0]?.percentage !== 100) throw new Error(`${name} has a split or unrecognized deployment. Resolve it before updating.`);
  return active[0].version_id;
}

// Cloudflare's deployments API can keep reporting the previous version for a
// while after an upload. Wait for the uploaded version to become active
// instead of recording the first answer (engines up to 1.1.1 recorded the
// previous version as deployed, which then failed verification).
export const ACTIVATION_POLL = { attempts: 10, delayMs: 2_000 };

async function newActiveVersion(token: string, account: string, name: string, previousVersion: string): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const current = await activeVersion(token, account, name);
    if (current !== previousVersion) return current;
    if (attempt >= ACTIVATION_POLL.attempts) throw new Error(`${name} was uploaded but Cloudflare still reports the previous version as active. Resume the update to continue.`);
    await new Promise((resolve) => setTimeout(resolve, ACTIVATION_POLL.delayMs));
  }
}

// A record pointing at the previous version can only come from that lag; the
// active version is ours when it is new and carries this release's identity.
function staleRecord(snapshot: Snapshot, currentVersion: string, matchesRelease: boolean): boolean {
  return snapshot.deployedVersion === snapshot.previousVersion && currentVersion !== snapshot.previousVersion && matchesRelease;
}

export async function captureWorkers(token: string, account: string, database: string, artifact: ReleaseArtifact, installed: string): Promise<Record<ProductWorker, Snapshot>> {
  assertUpdateCompatible(artifact, installed);
  const snapshots: Partial<Record<ProductWorker, Snapshot>> = {};
  for (const worker of PRODUCT_WORKERS) {
    const name = `cf-newsletter-${worker}`;
    const settings = await cloudflare<Settings>(token, `/accounts/${account}/workers/scripts/${name}/settings`);
    if (!settings.bindings?.some((binding) => binding.type === 'd1' && binding.name === 'DB' && binding.id === database)) {
      throw new Error(`${name} is not bound to the expected database. No resources were changed.`);
    }
    const required: Record<ProductWorker, string[]> = {
      ingest: ['ARCHIVE', 'QUEUE'], consumer: ['ARCHIVE', 'QUEUE', 'SEND_EMAIL', 'LINK_SIGNING_KEY', 'ATTACHMENT_SIGNING_KEY'],
      tracker: ['ARCHIVE', 'SEND_EMAIL', 'LINK_SIGNING_KEY', 'ATTACHMENT_SIGNING_KEY'],
      bounce: ['ARCHIVE'], cleanup: ['ARCHIVE'], admin: ['ASSETS', 'ASSETS_R2', 'ARCHIVE', 'SEND_EMAIL', 'UPDATER'],
    };
    if (required[worker].some((name) => !settings.bindings.some((binding) => binding.name === name))) throw new Error(`${name} is missing required bindings or secrets.`);
    const liveVersion = settings.bindings.find((binding) => binding.name === 'APP_VERSION')?.text;
    if (typeof liveVersion !== 'string' || (liveVersion !== installed && liveVersion !== artifact.manifest.version)) {
      throw new Error(`${name} has an unexpected installed version. Reconcile this installation before updating.`);
    }
    // Secret values are not returned by Cloudflare; keep only their names.
    settings.bindings = settings.bindings.map((binding) => binding.type === 'secret_text' ? { name: binding.name, type: binding.type } : binding);
    snapshots[worker] = { settings, previousVersion: await activeVersion(token, account, name) };
  }
  return snapshots as Record<ProductWorker, Snapshot>;
}

export async function uploadAssets(token: string, account: string, artifact: ReleaseArtifact): Promise<string> {
  const manifest = Object.fromEntries(Object.entries(artifact.assets).map(([path, asset]) => [path, { hash: asset.hash, size: asset.size }]));
  const session = await cloudflare<{ buckets?: string[][]; jwt: string }>(token, `/accounts/${account}/workers/scripts/cf-newsletter-admin/assets-upload-session`, {
    method: 'POST', body: JSON.stringify({ manifest }),
  });
  if (!session.jwt) throw new Error('Asset upload session did not return a token.');
  if (!session.buckets?.length) return session.jwt;
  let completed = '';
  for (const bucket of session.buckets) {
    const form = new FormData();
    for (const hash of bucket) {
      const asset = Object.values(artifact.assets).find((item) => item.hash === hash);
      if (!asset) throw new Error('Asset upload requested an unknown file.');
      form.append(hash, new Blob([asset.base64], { type: asset.contentType }), hash);
    }
    const response = await fetch(`${CF_API}/accounts/${account}/workers/assets/upload?base64=true`, {
      method: 'POST', headers: { Authorization: `Bearer ${session.jwt}` }, body: form, signal: AbortSignal.timeout(60_000),
    });
    const payload = await response.json() as { success?: boolean; result?: { jwt?: string } };
    if (!response.ok || payload.success === false) throw new Error(`Console asset upload failed (HTTP ${response.status}).`);
    if (response.status === 201 && payload.result?.jwt) completed = payload.result.jwt;
    else if (response.status !== 202) throw new Error('Asset upload returned an unexpected response.');
  }
  if (!completed) throw new Error('Asset upload did not return a completion token.');
  return completed;
}

export function deploymentMetadata(settings: Settings, artifact: ReleaseArtifact, publishedAt: string, assetsJwt?: string): Record<string, unknown> {
  const contract = artifact.manifest.update!;
  const bindings = settings.bindings.filter((binding) => binding.type !== 'secret_text' && !['APP_VERSION', 'APP_COMMIT', 'APP_RELEASED_AT'].includes(binding.name));
  bindings.push(
    { type: 'plain_text', name: 'APP_VERSION', text: artifact.manifest.version },
    { type: 'plain_text', name: 'APP_COMMIT', text: artifact.manifest.commit },
    { type: 'plain_text', name: 'APP_RELEASED_AT', text: publishedAt },
  );
  const metadata: Record<string, unknown> = {
    main_module: 'main.js', compatibility_date: contract.compatibilityDate,
    compatibility_flags: contract.compatibilityFlags, bindings, keep_bindings: ['secret_text'],
    annotations: { 'workers/message': `cf-newsletter ${artifact.manifest.version}` },
  };
  for (const key of ['observability', 'limits', 'logpush', 'tail_consumers', 'placement']) {
    if (settings[key] !== undefined) metadata[key] = settings[key];
  }
  if (assetsJwt) metadata.assets = { jwt: assetsJwt, config: { not_found_handling: 'single-page-application', run_worker_first: ['/api/*', '/media/*'] } };
  return metadata;
}

export async function deployProductWorker(token: string, account: string, worker: ProductWorker, artifact: ReleaseArtifact, settings: Settings, publishedAt: string, previousVersion: string, assetsJwt?: string): Promise<string> {
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(deploymentMetadata(settings, artifact, publishedAt, assetsJwt))], { type: 'application/json' }));
  form.append('main.js', new Blob([artifact.workers[worker]!], { type: 'application/javascript+module' }), 'main.js');
  await cloudflare(token, `/accounts/${account}/workers/scripts/cf-newsletter-${worker}`, { method: 'PUT', body: form });
  return newActiveVersion(token, account, `cf-newsletter-${worker}`, previousVersion);
}

export async function loadCheckpoint(query: Query, id: string): Promise<Checkpoint> {
  return JSON.parse((await jobById(query, id)).checkpoint) as Checkpoint;
}

export async function saveCheckpoint(query: Query, id: string, checkpoint: Checkpoint): Promise<void> {
  await query('UPDATE update_jobs SET checkpoint=? WHERE id=?', [JSON.stringify(checkpoint), id]);
}

export async function prepareUpdate(query: Query, id: string, token: string, account: string, database: string, artifact: ReleaseArtifact): Promise<void> {
  const job = await jobById(query, id);
  assertUpdateCompatible(artifact, job.installed_version);
  const checkpoint = await loadCheckpoint(query, id);
  if (!checkpoint.workers) {
    await updateEvent(query, id, 'preflight', 'Verifying existing Workers, resource bindings and deployment versions.');
    checkpoint.workers = await captureWorkers(token, account, database, artifact, job.installed_version);
    await saveCheckpoint(query, id, checkpoint);
  }
  if (!checkpoint.recoveryBookmark && !checkpoint.recoveryConfirmed) throw new Error('Confirm the database recovery checkpoint before updating.');
}

export async function migrateUpdate(query: Query, id: string, artifact: ReleaseArtifact): Promise<void> {
  for (const migration of artifact.migrations) {
    const applied = await query('SELECT version FROM schema_migrations WHERE version=?', [migration.id]);
    if (applied.length) continue;
    await updateEvent(query, id, 'migrating', `${migration.id}: ${migration.description}`);
    const before = await query(migration.checkSql);
    if (Number(before[0]?.present) !== 1) await query(migration.sql);
    const after = await query(migration.checkSql);
    if (Number(after[0]?.present) !== 1) throw new Error(`Migration ${migration.id} did not satisfy its postcondition. Inspect the database before resuming.`);
    await query('INSERT OR IGNORE INTO schema_migrations(version) VALUES(?)', [migration.id]);
  }
}

export async function deployUpdateWorker(query: Query, id: string, token: string, account: string, worker: ProductWorker, artifact: ReleaseArtifact, publishedAt: string): Promise<void> {
  const checkpoint = await loadCheckpoint(query, id);
  const snapshot = checkpoint.workers?.[worker];
  if (!snapshot) throw new Error('Deployment preflight checkpoint is missing.');
  await updateEvent(query, id, 'deploying', `Deploying cf-newsletter-${worker}.`);
  const live = await cloudflare<Settings>(token, `/accounts/${account}/workers/scripts/cf-newsletter-${worker}/settings`);
  const version = live.bindings.find((binding) => binding.name === 'APP_VERSION')?.text;
  const commit = live.bindings.find((binding) => binding.name === 'APP_COMMIT')?.text;
  const currentVersion = await activeVersion(token, account, `cf-newsletter-${worker}`);
  const matchesRelease = version === artifact.manifest.version && commit === artifact.manifest.commit;
  // Only the deployments-API lag can record the previous version as deployed;
  // treat it as not yet recorded, so the new version is adopted or redeployed.
  if (snapshot.deployedVersion === snapshot.previousVersion) delete snapshot.deployedVersion;
  if (snapshot.deployedVersion) {
    if (currentVersion !== snapshot.deployedVersion || !matchesRelease) {
      throw new Error('Deployment changed outside this update. Inspect the live state before recovery.');
    }
    return;
  }
  // A timeout after a successful upload must not blindly redeploy the Worker.
  if (currentVersion !== snapshot.previousVersion && matchesRelease) {
    snapshot.deployedVersion = currentVersion;
  } else {
    if (currentVersion !== snapshot.previousVersion) throw new Error('Deployment changed after preflight. Inspect it before recovery.');
    if (worker === 'admin' && !checkpoint.assetsJwt) checkpoint.assetsJwt = await uploadAssets(token, account, artifact);
    snapshot.deployedVersion = await deployProductWorker(token, account, worker, artifact, snapshot.settings, publishedAt, snapshot.previousVersion, worker === 'admin' ? checkpoint.assetsJwt : undefined);
  }
  await saveCheckpoint(query, id, checkpoint);
}

export async function verifyUpdate(query: Query, id: string, token: string, account: string, artifact: ReleaseArtifact, publishedAt: string): Promise<void> {
  await updateEvent(query, id, 'verifying', 'Verifying all six active deployments and recording the installed release.');
  const checkpoint = await loadCheckpoint(query, id);
  for (const worker of PRODUCT_WORKERS) {
    const settings = await cloudflare<Settings>(token, `/accounts/${account}/workers/scripts/cf-newsletter-${worker}/settings`);
    const matchesRelease = settings.bindings.find((binding) => binding.name === 'APP_VERSION')?.text === artifact.manifest.version &&
      settings.bindings.find((binding) => binding.name === 'APP_COMMIT')?.text === artifact.manifest.commit;
    const snapshot = checkpoint.workers?.[worker];
    const active = await activeVersion(token, account, `cf-newsletter-${worker}`);
    if (!snapshot || !matchesRelease) throw new Error(`Verification failed for cf-newsletter-${worker}.`);
    if (active !== snapshot.deployedVersion) {
      if (!staleRecord(snapshot, active, matchesRelease)) throw new Error(`Verification failed for cf-newsletter-${worker}.`);
      snapshot.deployedVersion = active;
    }
  }
  const values: Record<string, string> = {
    product_version: artifact.manifest.version, product_commit: artifact.manifest.commit,
    product_released_at: publishedAt, product_installed_at: new Date().toISOString(),
  };
  for (const [key, value] of Object.entries(values)) await query("INSERT INTO deployment_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=datetime('now')", [key, value]);
  // The asset session JWT is temporary authorization, not useful recovery data.
  delete checkpoint.assetsJwt;
  await saveCheckpoint(query, id, checkpoint);
}

export async function installedVersion(query: Query): Promise<string> {
  const rows = await query("SELECT value FROM deployment_metadata WHERE key='product_version'");
  const value = rows[0]?.value;
  if (typeof value !== 'string') throw new Error('Installed version is unknown. Use the hosted updater to reconcile this installation.');
  compareVersions(value, value);
  return value;
}
