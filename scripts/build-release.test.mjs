import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const artifact = JSON.parse(readFileSync(join(root, `dist/release/cf-newsletter-${version}-development.json`), 'utf8'));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('release includes all six Workers, the SPA, schema and migrations with correct digests', () => {
  assert.equal(artifact.manifest.version, version);
  assert.equal(artifact.manifest.format, 1);
  assert.match(artifact.manifest.commit, /^[a-f0-9]{40}$/);
  assert.deepEqual(Object.keys(artifact.workers).sort(), ['admin', 'bounce', 'cleanup', 'consumer', 'ingest', 'tracker']);
  assert.ok(artifact.assets['/index.html']);
  for (const [name, code] of Object.entries(artifact.workers)) {
    assert.equal(artifact.manifest.checksums[`workers/${name}.js`], hash(code));
  }
  for (const [path, asset] of Object.entries(artifact.assets)) {
    const bytes = Buffer.from(asset.base64, 'base64');
    assert.equal(asset.size, bytes.length);
    assert.equal(artifact.manifest.checksums[`assets${path}`], hash(bytes));
  }
  assert.equal(artifact.manifest.checksums['db/schema.sql'], hash(artifact.schema));
  for (const migration of artifact.migrations) {
    assert.equal(artifact.manifest.checksums[`db/updates/${migration.file}`], hash(migration.sql));
  }
});
