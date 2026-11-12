export const UPDATER_VERSION = '1.0.0';
export const PRODUCT_WORKERS = ['ingest', 'consumer', 'tracker', 'bounce', 'cleanup', 'admin'] as const;
export type ProductWorker = typeof PRODUCT_WORKERS[number];

export interface UpdateContract {
  minimumUpdaterVersion: string;
  minimumAppVersion: string;
  migrations: 'additive';
  infrastructure: false;
  compatibilityDate: string;
  compatibilityFlags: string[];
}

export interface ReleaseArtifact {
  manifest: {
    format: number;
    version: string;
    commit: string;
    timestamp: string;
    development: boolean;
    minimumInstallerVersion: string;
    checksums: Record<string, string>;
    update?: UpdateContract;
  };
  workers: Record<string, string>;
  updater?: { version: string; code: string };
  assets: Record<string, { base64: string; contentType: string; hash: string; size: number }>;
  schema: string;
  migrations: Array<{ id: string; file: string; description: string; checkSql: string; sql: string }>;
}

export interface GitHubRelease {
  id: number;
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  html_url?: string;
  body?: string;
  assets: Array<{ name: string; size: number; digest: string | null; browser_download_url: string }>;
}

const RELEASES = 'https://api.github.com/repos/Davide-Grandis/cf-newsletter/releases';
export const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;

export function compareVersions(left: string, right: string): number {
  const parse = (value: string) => {
    const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/.exec(value);
    if (!match) throw new Error('Unrecognized product version.');
    return { numbers: match.slice(1, 4).map(Number), pre: match[4]?.split('.') ?? [] };
  };
  const a = parse(left);
  const b = parse(right);
  for (let i = 0; i < 3; i++) {
    const difference = a.numbers[i]! - b.numbers[i]!;
    if (difference) return difference;
  }
  if (!a.pre.length || !b.pre.length) return Number(!a.pre.length) - Number(!b.pre.length);
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? -1 : 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    return xn && yn ? Number(x) - Number(y) : xn !== yn ? (xn ? -1 : 1) : x < y ? -1 : 1;
  }
  return 0;
}

export async function boundedBytes(response: Response, maximum: number): Promise<ArrayBuffer> {
  if (!response.ok || !response.body || Number(response.headers.get('content-length') ?? 0) > maximum) {
    throw new Error('Download failed or exceeds size limit.');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new Error('Download exceeds size limit.');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel();
    throw error;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes.buffer;
}

export async function githubRelease(path = '/latest', token?: string): Promise<GitHubRelease> {
  if (!/^\/(?:latest|\d+|tags\/v[\w.-]+)$/.test(path)) throw new Error('Invalid release selection.');
  const response = await fetch(`${RELEASES}${path}`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'cf-newsletter-updater', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`GitHub release check unavailable (HTTP ${response.status}). Retry later.`);
  const release = JSON.parse(new TextDecoder().decode(await boundedBytes(response, 512 * 1024))) as GitHubRelease;
  if (!Number.isSafeInteger(release.id) || release.draft || !/^v\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(release.tag_name)) {
    throw new Error('Invalid or unpublished product release.');
  }
  return release;
}

export async function sha256(bytes: ArrayBuffer): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function textBytes(value: string): ArrayBuffer {
  return new Uint8Array(new TextEncoder().encode(value)).buffer;
}

export function releaseDigest(release: GitHubRelease): string {
  const version = release.tag_name.replace(/^v/, '');
  const asset = release.assets?.find((item) => item.name === `cf-newsletter-${version}.json`);
  const digest = asset?.digest?.match(/^sha256:([a-f0-9]{64})$/)?.[1];
  if (!asset || !digest || asset.size < 100 || asset.size > MAX_ARTIFACT_BYTES ||
      asset.browser_download_url !== `https://github.com/Davide-Grandis/cf-newsletter/releases/download/${release.tag_name}/cf-newsletter-${version}.json`) {
    throw new Error('Release artifact or SHA-256 digest is missing or invalid.');
  }
  return digest;
}

export async function verifiedArtifact(release: GitHubRelease, installerVersion?: string): Promise<{ artifact: ReleaseArtifact; digest: string }> {
  if (release.draft || !/^v\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(release.tag_name)) throw new Error('Invalid or unpublished product release.');
  const digest = releaseDigest(release);
  const asset = release.assets.find((item) => item.digest === `sha256:${digest}`)!;
  const bytes = await boundedBytes(await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(60_000) }), MAX_ARTIFACT_BYTES);
  if (bytes.byteLength !== asset.size || await sha256(bytes) !== digest) throw new Error('Release artifact does not match the GitHub SHA-256 digest.');
  const artifact = JSON.parse(new TextDecoder().decode(bytes)) as ReleaseArtifact;
  await validateArtifact(artifact, release.tag_name.replace(/^v/, ''), installerVersion);
  return { artifact, digest };
}

export async function validateArtifact(artifact: ReleaseArtifact, version: string, installerVersion?: string): Promise<void> {
  const { manifest, workers, assets, schema, migrations, updater } = artifact;
  if (manifest?.format !== 1 || manifest.version !== version || !/^[a-f0-9]{40}$/.test(manifest.commit) || manifest.development ||
      !workers || !assets || typeof schema !== 'string' || !Array.isArray(migrations)) throw new Error('Invalid release artifact manifest.');
  if (installerVersion && compareVersions(manifest.minimumInstallerVersion, installerVersion) > 0) {
    throw new Error(`Installer ${manifest.minimumInstallerVersion} or newer is required.`);
  }
  if (Object.keys(workers).sort().join(',') !== [...PRODUCT_WORKERS].sort().join(',')) throw new Error('Incomplete Worker release artifact.');
  const values: Record<string, ArrayBuffer> = {};
  for (const [name, code] of Object.entries(workers)) {
    if (typeof code !== 'string') throw new Error('Invalid Worker module.');
    values[`workers/${name}.js`] = textBytes(code);
  }
  if (updater) {
    if (typeof updater.code !== 'string' || !/^\d+\.\d+\.\d+$/.test(updater.version)) throw new Error('Invalid updater module.');
    values['workers/updater.js'] = textBytes(updater.code);
  }
  for (const [path, entry] of Object.entries(assets)) {
    if (!/^\/[a-zA-Z0-9_./-]+$/.test(path) || path.includes('..') || !entry || !/^[A-Za-z0-9+/]*={0,2}$/.test(entry.base64)) throw new Error('Invalid admin asset.');
    const raw = Uint8Array.from(atob(entry.base64), (character) => character.charCodeAt(0));
    if (raw.byteLength !== entry.size) throw new Error('Invalid admin asset size.');
    const extension = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : '';
    if (entry.hash !== (await sha256(textBytes(entry.base64 + extension))).slice(0, 32)) throw new Error('Invalid admin asset upload hash.');
    values[`assets${path}`] = raw.buffer;
  }
  values['db/schema.sql'] = textBytes(schema);
  for (const migration of migrations) {
    if (!/^[a-zA-Z0-9_]+\.sql$/.test(migration.file) || !/^[\w]+$/.test(migration.id) || typeof migration.sql !== 'string' || !migration.checkSql) throw new Error('Invalid release migration.');
    const path = `db/updates/${migration.file}`;
    if (values[path]) throw new Error('Duplicate release migration.');
    values[path] = textBytes(migration.sql);
  }
  if (Object.keys(manifest.checksums ?? {}).sort().join(',') !== Object.keys(values).sort().join(',')) throw new Error('Release manifest file list does not match payload.');
  for (const [path, value] of Object.entries(values)) {
    if (await sha256(value) !== manifest.checksums[path]) throw new Error(`Release payload checksum mismatch: ${path}`);
  }
}

export function assertUpdateCompatible(artifact: ReleaseArtifact, installed: string, engineVersion = UPDATER_VERSION): void {
  const contract = artifact.manifest.update;
  if (!contract || contract.infrastructure !== false || contract.migrations !== 'additive' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(contract.compatibilityDate) || !Array.isArray(contract.compatibilityFlags)) {
    throw new Error('This release requires the hosted updater or a newer update engine.');
  }
  if (compareVersions(contract.minimumUpdaterVersion, engineVersion) > 0) throw new Error('Update the updater engine through the hosted updater first.');
  if (compareVersions(installed, contract.minimumAppVersion) < 0) throw new Error('An intermediate release or manual migration is required.');
  if (compareVersions(artifact.manifest.version, installed) < 0) throw new Error('Refusing to downgrade the installed application.');
}
