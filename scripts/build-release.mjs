import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const development = process.argv.includes('--development');
const product = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const web = JSON.parse(readFileSync(join(root, 'web/package.json'), 'utf8'));
const rootLock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
const webLock = JSON.parse(readFileSync(join(root, 'web/package-lock.json'), 'utf8'));
const version = product.version;
const workers = ['ingest', 'consumer', 'tracker', 'bounce', 'cleanup', 'admin'];
const mimeTypes = {
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp',
};

function git(...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function filesIn(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesIn(path) : entry.isFile() ? [path] : [];
  });
}

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`Invalid product version ${version}`);
if ([web.version, rootLock.version, rootLock.packages[''].version, webLock.version, webLock.packages[''].version].some((value) => value !== version)) {
  throw new Error('Root/web package and lockfile versions must match');
}
if (!development && git('status', '--porcelain')) throw new Error('Release builds require a clean working tree');
const commit = git('rev-parse', 'HEAD');
if (!development && git('describe', '--tags', '--exact-match') !== `v${version}`) {
  throw new Error(`Release commit must be tagged v${version}`);
}
const timestamp = git('show', '-s', '--format=%cI', 'HEAD');
const webBuild = spawnSync('npm', ['run', 'build:web'], {
  cwd: root, env: { ...process.env, PRODUCT_COMMIT: commit }, stdio: 'inherit',
});
if (webBuild.status !== 0) throw new Error('Admin SPA build failed');
const workerArtifacts = {};
for (const name of workers) {
  const result = await build({
    entryPoints: [join(root, 'workers', name, 'src', 'index.ts')],
    bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
    minify: true, write: false, loader: { '.md': 'text' }, external: ['cloudflare:*'],
  });
  workerArtifacts[name] = result.outputFiles[0].text;
}
const assets = {};
for (const path of filesIn(join(root, 'workers/admin/public'))) {
  const bytes = readFileSync(path);
  const extension = extname(path).toLowerCase();
  assets[`/${relative(join(root, 'workers/admin/public'), path).replaceAll('\\', '/')}`] = {
    base64: bytes.toString('base64'),
    hash: createHash('sha256').update(bytes.toString('base64') + extension.slice(1)).digest('hex').slice(0, 32),
    size: bytes.byteLength,
    contentType: mimeTypes[extension] ?? 'application/octet-stream',
  };
}
const schema = readFileSync(join(root, 'db/schema.sql'), 'utf8');
const migrationDirectory = join(root, 'db/updates');
const migrations = JSON.parse(readFileSync(join(migrationDirectory, 'manifest.json'), 'utf8')).map((migration) => ({
  ...migration,
  sql: readFileSync(join(migrationDirectory, migration.file), 'utf8'),
}));
const checksums = {};
for (const [name, code] of Object.entries(workerArtifacts)) checksums[`workers/${name}.js`] = sha256(Buffer.from(code));
for (const [path, asset] of Object.entries(assets)) checksums[`assets${path}`] = sha256(Buffer.from(asset.base64, 'base64'));
checksums['db/schema.sql'] = sha256(Buffer.from(schema));
for (const migration of migrations) checksums[`db/updates/${migration.file}`] = sha256(Buffer.from(migration.sql));
const artifact = {
  manifest: { format: 1, version, commit, timestamp, development, minimumInstallerVersion: '1.1.0', checksums },
  workers: workerArtifacts, assets, schema, migrations,
};
const outputDirectory = join(root, 'dist/release');
mkdirSync(outputDirectory, { recursive: true });
const output = join(outputDirectory, `cf-newsletter-${version}${development ? '-development' : ''}.json`);
writeFileSync(output, JSON.stringify(artifact));
console.log(`${output}: sha256:${sha256(readFileSync(output))}`);
