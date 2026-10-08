#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const productVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
const productCommit = revision.status === 0 ? revision.stdout.trim() : 'unknown';
const workers = ['ingest', 'consumer', 'tracker', 'bounce', 'cleanup', 'admin'];
const resources = {
  workerPrefix: 'cf-newsletter',
  database: 'cf-newsletter-db',
  queue: 'cf-newsletter-queue',
  deadLetterQueue: 'cf-newsletter-dlq',
  archiveBucket: 'cf-newsletter-archive',
  adminBucket: 'cf-newsletter-admin',
};
const legacyResources = {
  workerPrefix: 'newsletter',
  database: 'newsletter_db',
  queue: 'newsletter-queue',
  deadLetterQueue: 'newsletter-dlq',
  archiveBucket: 'newsletter-archive',
  adminBucket: 'newsletter-admin',
};
const dryRun = process.argv.includes('--dry-run');
let muteOutput = false;
const promptOutput = new Writable({
  write(chunk, encoding, callback) {
    if (!muteOutput) process.stdout.write(chunk, encoding);
    callback();
  },
});
promptOutput.isTTY = process.stdout.isTTY;
promptOutput.columns = process.stdout.columns;
const rl = createInterface({ input: process.stdin, output: promptOutput, terminal: Boolean(process.stdin.isTTY) });
let installToken = '';
let accountId = '';
let stepNumber = 0;

function step(label) {
  stepNumber++;
  console.log(`\n[${stepNumber}/11] ${label}`);
}

function status(action, component) {
  console.log(`  ${action.padEnd(12)} ${component}`);
}

function fail(message) {
  throw new Error(message);
}

function commandText(command, args) {
  return [command, ...args].join(' ');
}

function run(command, args, options = {}) {
  const label = commandText(command, args);
  if (dryRun) {
    console.log(`  [dry-run] ${label}`);
    return '';
  }
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: installToken },
    input: options.input,
    encoding: 'utf8',
    stdio: options.capture ? ['pipe', 'pipe', 'pipe'] : options.input ? ['pipe', 'inherit', 'inherit'] : 'inherit',
  });
  if (result.status !== 0) {
    const detail = options.capture ? `\n${result.stderr || result.stdout}` : '';
    fail(`${label} failed.${detail}`);
  }
  return options.capture ? result.stdout : '';
}

function wrangler(args, options = {}) {
  return run('npx', ['wrangler', ...args], options);
}

async function prompt(label, defaultValue = '') {
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  const value = (await rl.question(`${label}${suffix}: `)).trim();
  return value || defaultValue;
}

async function confirm(label, defaultYes = true) {
  const answer = (await rl.question(`${label} ${defaultYes ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase();
  return answer ? answer === 'y' || answer === 'yes' : defaultYes;
}

async function secret(label, required = false) {
  if (!process.stdin.isTTY) {
    const value = (await rl.question(`${label}: `)).trim();
    if (required && !value) fail(`${label} is required.`);
    return value;
  }
  process.stdout.write(`${label}: `);
  muteOutput = true;
  let value;
  try {
    value = (await rl.question('')).trim();
  } finally {
    muteOutput = false;
    process.stdout.write('\n');
  }
  if (required && !value) fail(`${label} is required.`);
  return value;
}

function validate(value, pattern, label) {
  if (!pattern.test(value)) fail(`Invalid ${label}: ${value}`);
  return value;
}

async function cf(path, { method = 'GET', body, allowNotFound = false } = {}) {
  if (dryRun) {
    status('would call', `${method} ${path}`);
    return { result: undefined, result_info: undefined };
  }
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: {
      authorization: `Bearer ${installToken}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (allowNotFound && response.status === 404) return null;
  if (!response.ok || payload.success === false) {
    const errors = (payload.errors ?? []).map((error) => error.message).filter(Boolean).join('; ');
    fail(`Cloudflare API ${method} ${path} failed: ${errors || `HTTP ${response.status}`}`);
  }
  return payload;
}

function escapeSql(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function containsResource(output, name) {
  return output.split('\n').some((line) => line.split(/\s+/).includes(name));
}

async function ensureCliResource(name, listArgs, createArgs) {
  const output = dryRun ? '' : wrangler(listArgs, { capture: true });
  if (!dryRun && containsResource(output, name)) {
    status('reusing', name);
    return;
  }
  status(dryRun ? 'would create' : 'creating', name);
  wrangler(createArgs);
}

function readInstalledDataLocality() {
  const databases = JSON.parse(wrangler(['d1', 'list', '--json'], { capture: true }));
  if (!databases.some((item) => item.name === resources.database)) return null;
  const rows = JSON.parse(wrangler(['d1', 'execute', resources.database, '--remote', '--command', "SELECT value FROM settings WHERE key = 'DATA_LOCALITY'", '--json'], { capture: true }));
  const value = rows[0]?.results?.[0]?.value;
  return value ? validate(value, /^(automatic|eu|us)$/, 'stored data locality') : null;
}

async function ensureQueue(name, locality) {
  const output = dryRun ? '' : wrangler(['queues', 'list'], { capture: true });
  if (!dryRun && containsResource(output, name)) {
    status('reusing', name);
    return;
  }
  status(dryRun ? 'would create' : 'creating', `${name} (${locality ?? 'automatic'})`);
  await cf(`/accounts/${accountId}/queues`, {
    method: 'POST',
    body: { queue_name: name, ...(locality && locality !== 'automatic' ? { jurisdiction: locality } : {}) },
  });
}

async function detectInstallation() {
  if (dryRun) return 'fresh';
  const databases = JSON.parse(wrangler(['d1', 'list', '--json'], { capture: true }));
  const queues = wrangler(['queues', 'list'], { capture: true });
  const buckets = wrangler(['r2', 'bucket', 'list'], { capture: true });
  const scripts = await cf(`/accounts/${accountId}/workers/scripts`);
  const workerNames = new Set((scripts.result ?? []).map((item) => item.id ?? item.name).filter(Boolean));

  const matches = (names) => [
    databases.some((item) => item.name === names.database) && names.database,
    containsResource(queues, names.queue) && names.queue,
    containsResource(queues, names.deadLetterQueue) && names.deadLetterQueue,
    containsResource(buckets, names.archiveBucket) && names.archiveBucket,
    containsResource(buckets, names.adminBucket) && names.adminBucket,
    ...workers.map((worker) => {
      const name = `${names.workerPrefix}-${worker}`;
      return workerNames.has(name) && name;
    }),
  ].filter(Boolean);

  const current = matches(resources);
  const legacy = matches(legacyResources);
  if (current.length && legacy.length) {
    fail(`Mixed current and legacy resources detected. Current: ${current.join(', ')}. Legacy: ${legacy.join(', ')}. Resolve the interrupted migration before installing.`);
  }
  if (legacy.length) {
    fail(`Legacy 2.2 resources detected: ${legacy.join(', ')}. Migration is required before this installer can deploy cf-newsletter-* resources; no resources were changed.`);
  }
  if (current.length) {
    status('detected', `existing cf-newsletter installation (${current.length} resources)`);
    return 'current';
  }
  status('detected', 'fresh installation');
  return 'fresh';
}

async function ensureD1(locality) {
  let databases = dryRun ? [] : JSON.parse(wrangler(['d1', 'list', '--json'], { capture: true }));
  let database = databases.find((item) => item.name === resources.database);
  const existing = Boolean(database);
  if (!database) {
    const selected = locality ?? 'eu';
    status(dryRun ? 'would create' : 'creating', `D1 ${resources.database} (${selected})`);
    wrangler(['d1', 'create', resources.database, ...(selected === 'automatic' ? [] : ['--jurisdiction', selected])]);
    if (dryRun) return '00000000-0000-0000-0000-000000000000';
    databases = JSON.parse(wrangler(['d1', 'list', '--json'], { capture: true }));
    database = databases.find((item) => item.name === resources.database);
  }
  if (!database?.uuid) fail(`Could not resolve the ${resources.database} database ID.`);
  if (locality) {
    const details = await cf(`/accounts/${accountId}/d1/database/${database.uuid}`);
    const actual = details.result?.jurisdiction ?? 'automatic';
    if (actual !== locality) fail(`D1 uses ${actual}, not ${locality}; refusing to record inconsistent data locality.`);
  }
  status(existing ? 'reusing' : 'confirmed', `D1 ${resources.database}`);
  return database.uuid;
}

function generateConfigs(databaseId, domain, archiveLocality, adminLocality) {
  for (const worker of workers) {
    const templatePath = join(root, 'workers', worker, 'wrangler.toml.example');
    const configPath = join(root, 'workers', worker, 'wrangler.toml');
    let content = readFileSync(templatePath, 'utf8').replaceAll('REPLACE_WITH_D1_ID', databaseId);
    content = content.replaceAll('REPLACE_WITH_ACCOUNT_ID', accountId);
    content = content.replaceAll('yourdomain.com', domain);
    content = content.replace('jurisdiction = "eu"', adminLocality === 'automatic' ? '' : `jurisdiction = "${adminLocality}"`);
    if (archiveLocality !== 'automatic') {
      content = content.replace('bucket_name = "cf-newsletter-archive"', `bucket_name = "cf-newsletter-archive"\njurisdiction = "${archiveLocality}"`);
    }
    status(dryRun ? 'would write' : 'writing', `workers/${worker}/wrangler.toml`);
    if (!dryRun) writeFileSync(configPath, content);
  }
}

async function ensureAccessOrganization(teamName) {
  if (dryRun) {
    await cf(`/accounts/${accountId}/access/organizations`);
    status('would ensure', `${teamName}.cloudflareaccess.com`);
    return;
  }
  const organization = await cf(`/accounts/${accountId}/access/organizations`, { allowNotFound: true });
  if (organization?.result?.auth_domain) {
    status('reusing', `Access organization ${organization.result.auth_domain}`);
    return;
  }
  status('creating', `Access organization ${teamName}.cloudflareaccess.com`);
  await cf(`/accounts/${accountId}/access/organizations`, {
    method: 'POST',
    body: { name: 'cf-newsletter Platform', auth_domain: `${teamName}.cloudflareaccess.com` },
  });
}

async function ensureAccessList(adminEmail) {
  const name = 'cf-newsletter Console Administrators';
  if (dryRun) {
    status('would ensure', `Access email list with ${adminEmail}`);
    return '00000000-0000-0000-0000-000000000000';
  }
  const payload = await cf(`/accounts/${accountId}/gateway/lists`);
  let list = (payload.result ?? []).find((item) => item.name === name && item.type === 'EMAIL');
  if (!list) {
    status('creating', 'Access email list');
    const created = await cf(`/accounts/${accountId}/gateway/lists`, {
      method: 'POST',
      body: { name, type: 'EMAIL', description: 'Users allowed to access the newsletter console', items: [{ value: adminEmail }] },
    });
    list = created.result;
  } else {
    status('reusing', 'Access email list');
    const items = await cf(`/accounts/${accountId}/gateway/lists/${list.id}/items?per_page=1000`);
    if (!(items.result ?? []).some((item) => String(item.value).toLowerCase() === adminEmail)) {
      status('adding', adminEmail);
      await cf(`/accounts/${accountId}/gateway/lists/${list.id}`, {
        method: 'PATCH',
        body: { append: [{ value: adminEmail }] },
      });
    }
  }
  if (!list?.id) fail('Could not resolve the Access email list ID.');
  return list.id;
}

async function ensureAccessApplication(domain, listId) {
  const hostname = `console.${domain}`;
  if (dryRun) {
    status('would ensure', `Access application ${hostname}`);
    status('would ensure', 'Access allow policy');
    return;
  }
  const apps = await cf(`/accounts/${accountId}/access/apps`);
  let app = (apps.result ?? []).find((item) => item.domain === hostname);
  if (!app) {
    status('creating', `Access application ${hostname}`);
    const created = await cf(`/accounts/${accountId}/access/apps`, {
      method: 'POST',
      body: { name: 'cf-newsletter Admin Console', domain: hostname, type: 'self_hosted', session_duration: '24h' },
    });
    app = created.result;
  } else {
    status('reusing', `Access application ${hostname}`);
  }
  if (!app?.id) fail('Could not resolve the Access application ID.');
  const policies = await cf(`/accounts/${accountId}/access/apps/${app.id}/policies`);
  if ((policies.result ?? []).some((policy) => policy.name === 'cf-newsletter administrators')) {
    status('reusing', 'Access allow policy');
    return;
  }
  status('creating', 'Access allow policy');
  await cf(`/accounts/${accountId}/access/apps/${app.id}/policies`, {
    method: 'POST',
    body: {
      name: 'cf-newsletter administrators',
      decision: 'allow',
      precedence: 1,
      include: [{ email_list: { id: listId } }],
    },
  });
}

async function ensureEmailRouting(zoneId, domain) {
  status('configuring', 'Email Routing DNS and settings');
  await cf(`/zones/${zoneId}/email/routing/enable`, { method: 'POST', body: {} });
  if (dryRun) {
    await cf(`/zones/${zoneId}/email/routing/rules`, { method: 'POST' });
    await cf(`/zones/${zoneId}/email/routing/rules/catch_all`, { method: 'PUT' });
    return;
  }
  const address = `newsletter@${domain}`;
  const rules = await cf(`/zones/${zoneId}/email/routing/rules`);
  const exists = (rules.result ?? []).some((rule) =>
    (rule.matchers ?? []).some((matcher) => matcher.type === 'literal' && matcher.field === 'to' && matcher.value === address),
  );
  if (!exists) {
    status('creating', `routing rule for ${address}`);
    await cf(`/zones/${zoneId}/email/routing/rules`, {
      method: 'POST',
      body: {
        name: 'Newsletter inbound',
        enabled: true,
        matchers: [{ type: 'literal', field: 'to', value: address }],
        actions: [{ type: 'worker', value: [`${resources.workerPrefix}-ingest`] }],
      },
    });
  }
  status('configuring', `catch-all rule for ${resources.workerPrefix}-bounce`);
  await cf(`/zones/${zoneId}/email/routing/rules/catch_all`, {
    method: 'PUT',
    body: {
      name: 'Newsletter unsubscribe and bounce handling',
      enabled: true,
      matchers: [{ type: 'all' }],
      actions: [{ type: 'worker', value: [`${resources.workerPrefix}-bounce`] }],
    },
  });
}

function putSecrets(worker, secrets) {
  if (!Object.keys(secrets).length) return;
  status(dryRun ? 'would set' : 'setting', `${Object.keys(secrets).join(', ')} on ${resources.workerPrefix}-${worker}`);
  wrangler(['secret', 'bulk', '--name', `${resources.workerPrefix}-${worker}`], { input: JSON.stringify(secrets) });
}

async function main() {
  console.log('\ncf-newsletter installer\n');
  console.log('Create a short-lived Cloudflare API token scoped to the target account and zone with:');
  console.log('  Account: Workers Scripts Edit, D1 Edit, Queues Edit, Workers R2 Storage Edit');
  console.log('  Account: Access Organizations/Identity Providers/Groups Write');
  console.log('  Account: Access Apps and Policies Write, Zero Trust Write, Email Read');
  console.log('  Zone: Zone Read, Zone Settings Edit, Workers Routes Edit');
  console.log('  Zone: Email Routing Rules Edit, Analytics Read');
  console.log('The installer uses it in memory and does not save it.\n');

  accountId = validate(await prompt('Cloudflare account ID'), /^[a-f0-9]{32}$/i, 'account ID');
  const domain = validate((await prompt('Cloudflare zone domain')).toLowerCase(), /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i, 'domain');
  const adminEmail = validate((await prompt('Cloudflare administrator email (becomes cf-newsletter super admin)')).toLowerCase(), /^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'email');
  const fromAddress = validate((await prompt('Default sender address', `newsletter@${domain}`)).toLowerCase(), /^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'sender address');
  const defaultTeamName = `cf-newsletter-${accountId.slice(0, 8)}`;
  const teamName = validate((await prompt('Zero Trust team name', defaultTeamName)).toLowerCase(), /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, 'Zero Trust team name');
  if (!dryRun) installToken = await secret('Short-lived installation API token', true);

  const existingConfigs = workers.filter((worker) => existsSync(join(root, 'workers', worker, 'wrangler.toml')));
  if (existingConfigs.length) {
    const overwrite = await confirm(`Overwrite ${existingConfigs.length} existing deployment config(s)?`, false);
    if (!overwrite) fail('Installation cancelled without changing deployment configs.');
  }

  console.log('\nThis will create or update Cloudflare resources, replace the zone catch-all email rule, and deploy six Workers.');
  if (!(await confirm('Continue with installation?', false))) fail('Installation cancelled.');

  step('Validating Cloudflare account, token and zone');
  if (!dryRun) {
    const verification = await cf('/user/tokens/verify');
    if (verification.result?.status !== 'active') fail('The installation API token is not active.');
  }
  status('checking', `${domain} in account ${accountId}`);
  const zones = await cf(`/zones?name=${encodeURIComponent(domain)}&account.id=${accountId}`);
  const zoneId = dryRun ? '00000000000000000000000000000000' : zones.result?.[0]?.id;
  if (!zoneId) fail(`Zone ${domain} was not found in account ${accountId}.`);
  const installation = await detectInstallation();
  const dataLocality = installation === 'fresh'
    ? validate((await prompt('Data locality for D1, R2, and Queues (automatic/eu/us)', 'eu')).toLowerCase(), /^(automatic|eu|us)$/, 'data locality')
    : readInstalledDataLocality();

  step('Installing project dependencies');
  status(dryRun ? 'would install' : 'installing', 'Worker dependencies');
  run('npm', ['install']);
  status(dryRun ? 'would install' : 'installing', 'Web console dependencies');
  run('npm', ['install'], { cwd: join(root, 'web') });

  step('Provisioning D1, Queues and R2');
  const archiveLocality = dataLocality ?? 'automatic';
  const adminLocality = dataLocality ?? 'eu';
  const databaseId = await ensureD1(dataLocality);
  await ensureQueue(resources.queue, dataLocality);
  await ensureQueue(resources.deadLetterQueue, dataLocality);
  const archiveJurisdiction = archiveLocality === 'automatic' ? [] : ['--jurisdiction', archiveLocality];
  const adminJurisdiction = adminLocality === 'automatic' ? [] : ['--jurisdiction', adminLocality];
  await ensureCliResource(resources.archiveBucket, ['r2', 'bucket', 'list', ...archiveJurisdiction], ['r2', 'bucket', 'create', resources.archiveBucket, ...archiveJurisdiction]);
  await ensureCliResource(resources.adminBucket, ['r2', 'bucket', 'list', ...adminJurisdiction], ['r2', 'bucket', 'create', resources.adminBucket, ...adminJurisdiction]);

  step('Generating all six Worker configurations');
  generateConfigs(databaseId, domain, archiveLocality, adminLocality);

  step('Applying the D1 schema');
  status('configuring', `${resources.database} schema`);
  wrangler(['d1', 'execute', resources.database, '--remote', '--file', 'db/schema.sql', '--yes']);

  step('Configuring Cloudflare Zero Trust and Access');
  await ensureAccessOrganization(teamName);
  const accessListId = await ensureAccessList(adminEmail);
  await ensureAccessApplication(domain, accessListId);

  const settings = {
    ...(dataLocality ? { DATA_LOCALITY: dataLocality } : {}),
    BASE_DOMAIN: domain,
    EMAIL_ROUTING_ZONE_ID: zoneId,
    ACCESS_ACCOUNT_ID: accountId,
    ACCESS_LIST_ID: accessListId,
    FROM_ADDRESS: fromAddress,
    TRACKING_BASE_URL: `https://track.${domain}`,
    INGEST_WORKER_NAME: `${resources.workerPrefix}-ingest`,
  };
  const settingValues = Object.entries(settings)
    .map(([key, value]) => `(${escapeSql(key)}, ${escapeSql(value)})`)
    .join(', ');
  const seedSql = `INSERT INTO settings (key, value) VALUES ${settingValues} ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now'); INSERT INTO admins (email, role) VALUES (${escapeSql(adminEmail)}, 'super_admin') ON CONFLICT(email) DO UPDATE SET role='super_admin', updated_at=datetime('now');`;
  step('Configuring cf-newsletter and its super admin');
  status('configuring', 'deployment settings');
  status('assigning', `${adminEmail} as super_admin`);
  wrangler(['d1', 'execute', resources.database, '--remote', '--command', seedSql, '--yes']);

  step('Building and deploying all Workers');
  status('building', 'admin web console');
  run('npm', ['run', 'build:web']);
  for (const worker of workers) {
    status(dryRun ? 'would deploy' : 'deploying', `${resources.workerPrefix}-${worker}`);
    wrangler(['deploy', '--var', `APP_VERSION:${productVersion}`, '--var', `APP_COMMIT:${productCommit}`], { cwd: join(root, 'workers', worker) });
  }

  step('Configuring Worker secrets');
  if (installation === 'fresh') {
    const linkKey = randomBytes(48).toString('base64');
    const attachmentKey = randomBytes(48).toString('base64');
    putSecrets('consumer', { LINK_SIGNING_KEY: linkKey, ATTACHMENT_SIGNING_KEY: attachmentKey });
    putSecrets('tracker', { LINK_SIGNING_KEY: linkKey, ATTACHMENT_SIGNING_KEY: attachmentKey });
  } else {
    status('preserving', 'existing signing secrets');
  }

  const configureRuntime = await confirm('Configure optional Cloudflare API automation tokens now?', true);
  if (configureRuntime && !dryRun) {
    console.log('Use dedicated least-privilege tokens; press Enter to skip an optional feature.');
    const routingToken = await secret('Routing/analytics token (Email Routing Rules Edit + Analytics Read)');
    const readToken = await secret('Read token (Zone Read + Account Email Read)');
    const zeroTrustToken = await secret('Zero Trust token (Zero Trust Write)');
    if (routingToken) {
      putSecrets('admin', { CF_API_TOKEN: routingToken });
      putSecrets('bounce', { CF_API_TOKEN: routingToken });
    }
    if (readToken) {
      putSecrets('admin', { CF_READ_API_TOKEN: readToken });
      putSecrets('consumer', { CF_READ_API_TOKEN: readToken });
    }
    if (zeroTrustToken) putSecrets('admin', { CF_ZT_API_TOKEN: zeroTrustToken });
  }

  step('Configuring Email Routing and Worker rules');
  await ensureEmailRouting(zoneId, domain);

  step('Publishing initial help content');
  if (existsSync(join(root, 'docs', 'help.md'))) {
    status(dryRun ? 'would upload' : 'uploading', 'docs/help.md to R2');
    wrangler([
      'r2', 'object', 'put', `${resources.adminBucket}/help.md`, ...adminJurisdiction, '--remote',
      '--file', './docs/help.md', '--content-type', 'text/markdown',
    ]);
  }

  const deployedSql = `INSERT INTO deployment_metadata(key,value) VALUES ('product_version', ${escapeSql(productVersion)}), ('product_commit', ${escapeSql(productCommit)}) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')`;
  wrangler(['d1', 'execute', resources.database, '--remote', '--command', deployedSql, '--yes']);

  console.log('\nInstallation complete.');
  console.log(`Admin console: https://console.${domain}`);
  console.log(`Tracking URL: https://track.${domain}`);
  console.log(`Inbound address: newsletter@${domain}`);
  console.log('\nFinal Cloudflare dashboard check: Compute > Email Service > Email Sending.');
  console.log(`Onboard ${domain} if it is not already enabled and wait for its DNS/DKIM status to become active.`);
  console.log('The Email Sending API currently requires a legacy global API key, which this installer intentionally does not request.');
}

main()
  .catch((error) => {
    console.error(`\nInstallation failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => rl.close());
