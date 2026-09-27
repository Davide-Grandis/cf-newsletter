#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const allowedAccount = {
  id: '2c7a54ba6843fd28e1ab295fd1535687',
  name: 'davideg-individual-account',
};
const workers = ['ingest', 'consumer', 'tracker', 'bounce', 'cleanup', 'admin'];
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
const commit = revision.status === 0 ? revision.stdout.trim() : 'unknown';
const action = process.argv[2] ?? 'check';

function fail(message) {
  throw new Error(message);
}

function run(command, args, { cwd = root, capture = false, env = {} } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env, CLOUDFLARE_ACCOUNT_ID: allowedAccount.id },
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.status !== 0) {
    const detail = capture ? `\n${result.stderr || result.stdout}` : '';
    fail(`${command} ${args.join(' ')} failed.${detail}`);
  }
  return capture ? `${result.stdout}${result.stderr}` : '';
}

function validateRequestedAccount() {
  const requested = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (requested && requested !== allowedAccount.id) {
    fail(`Deployment is locked to ${allowedAccount.name} (${allowedAccount.id}); refusing CLOUDFLARE_ACCOUNT_ID=${requested}.`);
  }
}

function verifyAccountAccess() {
  const output = run('npx', ['wrangler', 'whoami'], { capture: true });
  if (!output.includes(allowedAccount.id) || !output.includes(allowedAccount.name)) {
    fail(`Wrangler credentials do not have access to ${allowedAccount.name} (${allowedAccount.id}).`);
  }
}

function validateConfigs() {
  for (const worker of workers) {
    const configPath = join(root, 'workers', worker, 'wrangler.toml');
    if (!existsSync(configPath)) fail(`Missing workers/${worker}/wrangler.toml.`);
    const config = readFileSync(configPath, 'utf8');
    const required = [
      `name = "cf-newsletter-${worker}"`,
      `account_id = "${allowedAccount.id}"`,
      'database_name = "cf-newsletter-db"',
    ];
    for (const value of required) {
      if (!config.includes(value)) fail(`workers/${worker}/wrangler.toml must contain ${value}.`);
    }
    if (config.includes('REPLACE_WITH_D1_ID') || config.includes('yourdomain.com')) {
      fail(`workers/${worker}/wrangler.toml is not configured for the development deployment.`);
    }
    if (/(?<!cf-)newsletter-(?:admin|tracker|ingest|consumer|bounce|cleanup|queue|dlq|archive)|newsletter_db/.test(config)) {
      fail(`workers/${worker}/wrangler.toml contains a legacy Cloudflare resource name.`);
    }
  }
}

function deployWorker(worker) {
  if (worker === 'admin') run('npm', ['run', 'build:web'], { env: { PRODUCT_COMMIT: commit } });
  run('npx', ['wrangler', 'deploy', '--var', `APP_VERSION:${version}`, '--var', `APP_COMMIT:${commit}`], { cwd: join(root, 'workers', worker) });
}

function main() {
  const allowedActions = new Set(['check', 'all', 'db', ...workers]);
  if (!allowedActions.has(action)) fail(`Unknown deployment action: ${action}.`);
  validateRequestedAccount();
  verifyAccountAccess();
  validateConfigs();
  if (action !== 'check' && action !== 'db') {
    const changes = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
    if (changes.status !== 0 || changes.stdout.trim()) fail('Deployments require a clean committed checkout.');
  }
  console.log(`Deployment guard passed for ${allowedAccount.name} (${allowedAccount.id}).`);

  if (action === 'check') return;
  if (action === 'db') {
    run('npx', ['wrangler', 'd1', 'execute', 'cf-newsletter-db', '--remote', '--file=db/schema.sql', '--yes']);
    return;
  }
  if (action === 'all') {
    run('npm', ['run', 'build:web'], { env: { PRODUCT_COMMIT: commit } });
    for (const worker of workers) run('npx', ['wrangler', 'deploy', '--var', `APP_VERSION:${version}`, '--var', `APP_COMMIT:${commit}`], { cwd: join(root, 'workers', worker) });
    run('npx', ['wrangler', 'd1', 'execute', 'cf-newsletter-db', '--remote', '--command',
      `INSERT INTO deployment_metadata(key,value) VALUES ('product_version','${version}'),('product_commit','${commit}') ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=datetime('now')`, '--yes']);
    return;
  }
  deployWorker(action);
}

try {
  main();
} catch (error) {
  console.error(`\nDeployment blocked: ${error.message}`);
  process.exitCode = 1;
}
