import type { GitHubRelease } from './update-release';

export type Query = (sql: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>;
export const UPDATE_TTL_MS = 60 * 60 * 1000;
export const UPDATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS update_jobs (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, actor TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued', phase TEXT NOT NULL DEFAULT 'queued',
  release_json TEXT NOT NULL, digest TEXT NOT NULL, installed_version TEXT NOT NULL,
  credential TEXT, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
  finished_at INTEGER, error TEXT, checkpoint TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS update_lock (id INTEGER PRIMARY KEY CHECK(id=1), job_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS update_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, phase TEXT NOT NULL,
  message TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS update_events_job ON update_events(job_id,id);
CREATE TABLE IF NOT EXISTS update_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, checked_at INTEGER NOT NULL);
`;

export interface UpdateJob {
  id: string;
  source: string;
  actor: string;
  state: string;
  phase: string;
  release_json: string;
  digest: string;
  installed_version: string;
  credential: string | null;
  expires_at: number;
  checkpoint: string;
}

export function bindingQuery(db: D1Database): Query {
  return async (sql, params = []) => {
    const statements = sqlStatements(sql);
    if (statements.length > 1) {
      if (params.length) throw new Error('Parameterized multi-statement updates are not supported.');
      return (await db.batch<Record<string, unknown>>(statements.map((statement) => db.prepare(statement)))).flatMap((result) => result.results);
    }
    return (await db.prepare(sql).bind(...params).all<Record<string, unknown>>()).results;
  };
}

export function sqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let quote = '';
  let comment = '';
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if (comment === '--') { if (c === '\n') comment = ''; continue; }
    if (comment === '/*') { if (c === '*' && next === '/') { comment = ''; i++; } continue; }
    if (quote) {
      if (c === quote) { if (next === quote) i++; else quote = ''; }
      continue;
    }
    if (c === '-' && next === '-') { comment = '--'; i++; continue; }
    if (c === '/' && next === '*') { comment = '/*'; i++; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === ';') { if (sql.slice(start, i).trim()) statements.push(sql.slice(start, i)); start = i + 1; }
  }
  if (quote || comment === '/*') throw new Error('Invalid SQL migration.');
  if (sql.slice(start).trim()) statements.push(sql.slice(start));
  return statements;
}

export async function jobById(query: Query, id: string): Promise<UpdateJob> {
  const rows = await query('SELECT * FROM update_jobs WHERE id=?', [id]);
  if (!rows[0]) throw new Error('Update job not found.');
  return rows[0] as unknown as UpdateJob;
}

export async function acquireJob(query: Query, input: {
  id: string; source: string; actor: string; release: GitHubRelease; digest: string;
  installedVersion: string; credential: string;
}): Promise<void> {
  // Never expire a deployment lock automatically: an interrupted operation must
  // be reconciled before another deployment is allowed to modify the same app.
  await query(`INSERT INTO update_jobs(id,source,actor,release_json,digest,installed_version,credential,expires_at,created_at)
    VALUES(?,?,?,?,?,?,?,?,?)`, [
    input.id, input.source, input.actor, JSON.stringify(input.release), input.digest,
    input.installedVersion, input.credential, Date.now() + UPDATE_TTL_MS, Date.now(),
  ]);
  const lock = await query('INSERT OR IGNORE INTO update_lock(id,job_id) VALUES(1,?) RETURNING job_id', [input.id]);
  if (lock[0]?.job_id !== input.id) {
    await query("UPDATE update_jobs SET state='failed',credential=NULL,error='Another update holds the deployment lock.',finished_at=? WHERE id=?", [Date.now(), input.id]);
    throw new Error('Another update is active or needs recovery. Inspect the Updates page before retrying.');
  }
}

export async function updateEvent(query: Query, id: string, phase: string, message: string): Promise<void> {
  await query("UPDATE update_jobs SET state='running',phase=? WHERE id=?", [phase, id]);
  await query('INSERT INTO update_events(job_id,phase,message,created_at) VALUES(?,?,?,?)', [id, phase, message, Date.now()]);
}

export async function finishJob(query: Query, id: string, error?: string): Promise<void> {
  await query('UPDATE update_jobs SET state=?,phase=?,error=?,credential=NULL,finished_at=? WHERE id=?', [
    error ? 'failed' : 'complete', error ? 'failed' : 'complete', error ?? null, Date.now(), id,
  ]);
  // Failures retain the lock until an operator explicitly resumes or releases it.
  if (!error) await query('DELETE FROM update_lock WHERE id=1 AND job_id=?', [id]);
}

function toBase64(bytes: ArrayBuffer): string {
  return btoa(Array.from(new Uint8Array(bytes), (byte) => String.fromCharCode(byte)).join(''));
}

function fromBase64(value: string): ArrayBuffer {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0)).buffer;
}

export async function credentialKeyPair(): Promise<{ publicKey: string; privateKey: string }> {
  const keys = await crypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['encrypt', 'decrypt']);
  if (!('publicKey' in keys)) throw new Error('Could not generate updater credential keys.');
  return {
    publicKey: JSON.stringify(await crypto.subtle.exportKey('jwk', keys.publicKey)),
    privateKey: JSON.stringify(await crypto.subtle.exportKey('jwk', keys.privateKey)),
  };
}

export async function encryptCredential(token: string, publicKey: string, jobId: string): Promise<string> {
  if (!token || token.length > 160) throw new Error('Invalid update token.');
  const key = await crypto.subtle.importKey('jwk', JSON.parse(publicKey), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  return toBase64(await crypto.subtle.encrypt({ name: 'RSA-OAEP', label: new TextEncoder().encode(jobId) }, key, new TextEncoder().encode(token)));
}

export async function decryptCredential(job: UpdateJob, privateKey: string): Promise<string> {
  if (!job.credential || job.expires_at <= Date.now()) throw new Error('Update credential expired. Resume with a new token.');
  const key = await crypto.subtle.importKey('jwk', JSON.parse(privateKey), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']);
  const bytes = await crypto.subtle.decrypt({ name: 'RSA-OAEP', label: new TextEncoder().encode(job.id) }, key, fromBase64(job.credential));
  return new TextDecoder().decode(bytes);
}
