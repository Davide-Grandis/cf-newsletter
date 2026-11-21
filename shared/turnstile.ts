import { boundedBytes } from './update-release';
import type { Query } from './update-state';

const API = 'https://api.cloudflare.com/client/v4';
const TRACKER = 'cf-newsletter-tracker';
const CONFIG_BINDINGS = new Set(['TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY', 'TURNSTILE_ENABLED']);

export interface TurnstileWidget {
  sitekey: string;
  secret: string;
  domains: string[];
}

interface WorkerSettings {
  bindings: Array<{ name: string; type: string; text?: string }>;
  annotations?: Record<string, string>;
}

export class TurnstileError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export function validTurnstileSiteKey(value: string): boolean {
  return /^[A-Za-z0-9_-]{20,32}$/.test(value);
}

function accountPath(account: string): string {
  if (!/^[a-f0-9]{32}$/i.test(account)) throw new TurnstileError('Configure the Cloudflare account ID first.');
  return `/accounts/${account}`;
}

async function cf<T>(token: string, path: string, init: RequestInit = {}, allowMissing = false): Promise<T | null> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (typeof init.body === 'string') headers.set('Content-Type', 'application/json');
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, { ...init, headers, signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new TurnstileError('Cloudflare did not complete the Turnstile operation. Retry to reconcile its state.', 502);
  }
  if (allowMissing && response.status === 404) return null;
  if (response.status === 401 || response.status === 403) {
    throw new TurnstileError('Error: The configured API token needs Account: Turnstile Edit and Workers Scripts Edit on this account. Update the stored runtime token permissions and try again.', 403);
  }
  if (response.status === 404) throw new TurnstileError('The site key or tracker Worker was not found in this Cloudflare account.');
  if (!response.ok) throw new TurnstileError(`Cloudflare could not complete the Turnstile operation (HTTP ${response.status}).`, 502);
  // Never expose upstream response text: widget responses contain the secret.
  let body: { success?: boolean; result?: T };
  try { body = JSON.parse(new TextDecoder().decode(await boundedBytes(response, 1024 * 1024))); }
  catch { throw new TurnstileError('Cloudflare returned an invalid Turnstile response.', 502); }
  if (!response.ok || body.success !== true || (!body.result && init.method !== 'DELETE')) {
    throw new TurnstileError(`Cloudflare could not complete the Turnstile operation (HTTP ${response.status}).`, 502);
  }
  return body.result ?? null;
}

function validateWidget(widget: TurnstileWidget | null, siteKey: string, hostname: string): TurnstileWidget {
  if (!widget || widget.sitekey !== siteKey || !validTurnstileSiteKey(siteKey) ||
      typeof widget.secret !== 'string' || !widget.secret.trim()) {
    throw new TurnstileError('Cloudflare could not validate the site key and matching secret.');
  }
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (!host || !Array.isArray(widget.domains) || !widget.domains.some((domain) => {
    const allowed = typeof domain === 'string' ? domain.toLowerCase().replace(/\.$/, '') : '';
    return allowed && (host === allowed || host.endsWith(`.${allowed}`));
  })) throw new TurnstileError(`The Turnstile widget must allow the tracking hostname ${hostname}.`);
  return widget;
}

export async function createTurnstileWidget(
  token: string, account: string, hostname: string, name = `cf-newsletter signup (${hostname})`,
): Promise<TurnstileWidget> {
  const widget = await cf<TurnstileWidget>(token, `${accountPath(account)}/challenges/widgets`, {
    method: 'POST',
    body: JSON.stringify({ name, domains: [hostname], mode: 'managed', clearance_level: 'no_clearance' }),
  });
  return validateWidget(widget, widget?.sitekey ?? '', hostname);
}

async function trackerSettings(token: string, account: string): Promise<WorkerSettings> {
  const settings = await cf<WorkerSettings>(token, `${accountPath(account)}/workers/scripts/${TRACKER}/settings`);
  if (!settings || !Array.isArray(settings.bindings) || settings.bindings.some((binding) => !binding.name || !binding.type)) {
    throw new TurnstileError('Could not inspect the tracker bindings; no configuration was changed.', 502);
  }
  return settings;
}

export async function configureTrackerTurnstile(token: string, account: string, widget: TurnstileWidget | null): Promise<void> {
  const previous = await trackerSettings(token, account);
  // Inherit all unrelated bindings, including unreadable secrets, unchanged.
  const bindings: Array<{ name: string; type: string; text?: string }> = previous.bindings
    .filter((binding) => !CONFIG_BINDINGS.has(binding.name))
    .map((binding) => ({ name: binding.name, type: 'inherit' }));
  if (widget) bindings.push(
    { name: 'TURNSTILE_SITE_KEY', type: 'plain_text', text: widget.sitekey },
    { name: 'TURNSTILE_SECRET_KEY', type: 'secret_text', text: widget.secret },
    { name: 'TURNSTILE_ENABLED', type: 'plain_text', text: 'true' },
  );
  const form = new FormData();
  const annotations = previous.annotations && Object.fromEntries(Object.entries(previous.annotations).filter(([key]) => key !== 'workers/operation'));
  form.append('settings', new Blob([JSON.stringify({ bindings, ...(annotations ? { annotations } : {}) })], { type: 'application/json' }));
  await cf(token, `${accountPath(account)}/workers/scripts/${TRACKER}/settings`, { method: 'PATCH', body: form });
  const live = await trackerSettings(token, account);
  const configured = widget
    ? live.bindings.some((binding) => binding.name === 'TURNSTILE_SITE_KEY' && binding.type === 'plain_text' && binding.text === widget.sitekey) &&
      live.bindings.some((binding) => binding.name === 'TURNSTILE_SECRET_KEY' && binding.type === 'secret_text')
    : !live.bindings.some((binding) => CONFIG_BINDINGS.has(binding.name));
  if (!configured) throw new TurnstileError('Tracker configuration could not be verified. Retry setup before enabling protection.', 502);
}

export async function readTurnstileConfig(query: Query): Promise<{ enabled: boolean; siteKey: string }> {
  const rows = await query("SELECT key,value FROM settings WHERE key IN ('TURNSTILE_ENABLED','TURNSTILE_SITE_KEY')");
  const values = new Map(rows.map((row) => [String(row.key), String(row.value)]));
  return { enabled: values.get('TURNSTILE_ENABLED') === 'true', siteKey: values.get('TURNSTILE_SITE_KEY') ?? '' };
}

export async function turnstileStatus(query: Query, account: string, hostname: string, readToken?: string) {
  const config = await readTurnstileConfig(query);
  let ready = false;
  let checkError: string | null = null;
  if (config.siteKey && readToken) {
    try {
      const tracker = await trackerSettings(readToken, account);
      ready = tracker.bindings.some((binding) => binding.name === 'TURNSTILE_SITE_KEY' && binding.text === config.siteKey) &&
        tracker.bindings.some((binding) => binding.name === 'TURNSTILE_SECRET_KEY' && binding.type === 'secret_text');
    } catch { checkError = 'Could not verify tracker configuration. Check the stored runtime token and its Workers Scripts Edit permission.'; }
  } else if (config.siteKey) {
    checkError = 'The runtime API token is missing; tracker configuration could not be checked.';
  }
  return { ...config, hostname, ready, checkError };
}

async function withConfigurationLock<T>(query: Query, operation: () => Promise<T>): Promise<T> {
  const table = await query("SELECT name FROM sqlite_master WHERE type='table' AND name='update_lock'");
  if (table.length && (await query('SELECT job_id FROM update_lock WHERE id=1')).length) {
    throw new TurnstileError('Finish or recover the active application update before changing Turnstile.', 409);
  }
  const value = JSON.stringify({ id: crypto.randomUUID(), expires: Date.now() + 180_000 });
  const claimed = await query(`INSERT INTO deployment_metadata(key,value) VALUES('turnstile_configuration_lock',?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
    WHERE CAST(json_extract(deployment_metadata.value,'$.expires') AS INTEGER)<? RETURNING value`, [value, Date.now()]);
  if (!claimed.length) throw new TurnstileError('Another Turnstile operation is in progress. Please retry shortly.', 409);
  try { return await operation(); }
  finally {
    // A cleanup failure must not turn a verified configuration into a failure.
    // The non-secret lease expires if D1 is temporarily unavailable.
    try { await query("DELETE FROM deployment_metadata WHERE key='turnstile_configuration_lock' AND value=?", [value]); } catch {}
  }
}

export interface TurnstileChange {
  account: string;
  hostname: string;
  token: string;
  enabled: boolean;
  siteKey?: string;
  confirmDelete?: boolean;
}

async function automaticWidget(query: Query, input: TurnstileChange, savedKey: string): Promise<TurnstileWidget> {
  const path = `${accountPath(input.account)}/challenges/widgets`;
  if (validTurnstileSiteKey(savedKey)) {
    const existing = await cf<TurnstileWidget>(input.token, `${path}/${savedKey}`, {}, true);
    if (existing) return validateWidget(existing, savedKey, input.hostname);
  }

  // Persist a unique creation name before the API call so retries can recover
  // the same widget even when its creation response or the next D1 write is lost.
  const pending = (await query("SELECT value FROM deployment_metadata WHERE key='turnstile_widget_creation'"))[0]?.value;
  const creation = pending ? JSON.parse(String(pending)) as { account: string; hostname: string; name: string } : {
    account: input.account, hostname: input.hostname,
    name: `cf-newsletter signup (${input.hostname.slice(0, 160)}) ${crypto.randomUUID()}`,
  };
  if (creation.account !== input.account || creation.hostname !== input.hostname || typeof creation.name !== 'string') {
    throw new TurnstileError('A widget setup is pending for a different account or hostname. Restore that configuration before retrying.');
  }
  if (!pending) {
    await query("INSERT INTO deployment_metadata(key,value) VALUES('turnstile_widget_creation',?)", [JSON.stringify(creation)]);
  }
  const widgets = await cf<Array<{ sitekey: string; name: string }>>(
    input.token, `${path}?filter=${encodeURIComponent(`name:${creation.name}`)}&per_page=5`,
  );
  if (!Array.isArray(widgets) || widgets.length >= 5) throw new TurnstileError('Could not safely identify the app-created Turnstile widget. Retry after checking the Cloudflare dashboard.');
  const matches = widgets.filter((widget) => widget.name === creation.name);
  if (matches.length > 1) throw new TurnstileError('Multiple matching Turnstile widgets were found. Resolve the duplicate widgets in Cloudflare before retrying.');
  const match = matches[0];
  if (match && !validTurnstileSiteKey(match.sitekey)) throw new TurnstileError('Cloudflare returned an invalid Turnstile widget.');
  const widget = match
    ? validateWidget(await cf<TurnstileWidget>(input.token, `${path}/${match.sitekey}`), match.sitekey, input.hostname)
    : await createTurnstileWidget(input.token, input.account, input.hostname, creation.name);
  // Save only the public key for retries. Protection stays off until the
  // matching secret has been installed and verified on the tracker.
  await query("INSERT INTO settings(key,value) VALUES('TURNSTILE_SITE_KEY',?),('TURNSTILE_ENABLED','false') ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=datetime('now')", [widget.sitekey]);
  return widget;
}

export async function changeTurnstile(query: Query, input: TurnstileChange): Promise<void> {
  if (typeof input.enabled !== 'boolean' || (input.siteKey !== undefined && typeof input.siteKey !== 'string')) throw new TurnstileError('Invalid Turnstile configuration.');
  accountPath(input.account);
  if (typeof input.token !== 'string' || !/^[A-Za-z0-9._-]{20,512}$/.test(input.token)) {
    throw new TurnstileError('A valid configured Cloudflare API token with Turnstile Edit and Workers Scripts Edit is required.');
  }
  const automatic = input.enabled && input.siteKey === undefined;
  const siteKey = input.siteKey?.trim() ?? '';
  if (input.enabled && (!input.hostname || input.hostname === 'track.yourdomain.com')) throw new TurnstileError('Configure the tracking hostname before enabling Turnstile.');
  if (input.enabled && !automatic && !validTurnstileSiteKey(siteKey)) throw new TurnstileError('Enter a valid Turnstile site key before enabling protection.');
  await withConfigurationLock(query, async () => {
    const current = await readTurnstileConfig(query);
    if (input.enabled) {
      if (!automatic && current.siteKey && current.siteKey !== siteKey) throw new TurnstileError('Remove the existing Turnstile widget before configuring a different site key.');
      const widget = automatic
        ? await automaticWidget(query, input, current.siteKey)
        : validateWidget(await cf<TurnstileWidget>(input.token, `${accountPath(input.account)}/challenges/widgets/${siteKey}`), siteKey, input.hostname);
      await configureTrackerTurnstile(input.token, input.account, widget);
      // The enabled flag and public key are committed together, after verified
      // Worker configuration. Neither the token nor widget secret enters D1.
      await query("INSERT INTO settings(key,value) VALUES('TURNSTILE_SITE_KEY',?),('TURNSTILE_ENABLED','true') ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=datetime('now')", [widget.sitekey]);
      if (automatic) {
        // Retaining retry metadata is harmless if cleanup fails after enabling.
        try { await query("DELETE FROM deployment_metadata WHERE key='turnstile_widget_creation'"); } catch {}
      }
    } else {
      if (input.confirmDelete !== true || siteKey !== current.siteKey) throw new TurnstileError('Confirm deletion of the currently configured Turnstile widget.');
      // Check permission/existence before changing the app; a missing widget is
      // expected when retrying a deletion whose response was lost.
      if (validTurnstileSiteKey(siteKey)) await cf(input.token, `${accountPath(input.account)}/challenges/widgets/${siteKey}`, {}, true);
      await query("INSERT INTO settings(key,value) VALUES('TURNSTILE_ENABLED','false') ON CONFLICT(key) DO UPDATE SET value='false',updated_at=datetime('now')");
      await configureTrackerTurnstile(input.token, input.account, null);
      if (validTurnstileSiteKey(siteKey)) await cf(input.token, `${accountPath(input.account)}/challenges/widgets/${siteKey}`, { method: 'DELETE' }, true);
      await query("DELETE FROM settings WHERE key='TURNSTILE_SITE_KEY'");
    }
  });
}
