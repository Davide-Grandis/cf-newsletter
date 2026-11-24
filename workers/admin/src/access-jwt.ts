// Verifies the Cloudflare Access token (Cf-Access-Jwt-Assertion) on console
// requests, so the console doesn't rely only on Access sitting in front of it:
// the identity header is accepted only with a valid token for this console's
// Access application, signed by the account's Access team.

export interface AccessConfig {
  /** Team domain, e.g. "myteam.cloudflareaccess.com". */
  teamDomain: string;
  /** Audience (AUD) tag of the console's Access application. */
  aud: string;
}

export interface AccessClaims {
  email?: string;
  aud?: string | string[];
  iss?: string;
  exp?: number;
  nbf?: number;
  [key: string]: unknown;
}

type Jwk = JsonWebKey & { kid?: string };

const CLOCK_SKEW_S = 60;
const KEYS_TTL_MS = 60 * 60 * 1000;
const keyCache = new Map<string, { keys: Map<string, CryptoKey>; fetchedAt: number }>();

function b64urlBytes(value: string): Uint8Array {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function b64urlJson<T>(value: string): T {
  return JSON.parse(new TextDecoder().decode(b64urlBytes(value))) as T;
}

async function signingKeys(teamDomain: string, fetcher: typeof fetch, refresh: boolean): Promise<Map<string, CryptoKey>> {
  const cached = keyCache.get(teamDomain);
  if (cached && !refresh && Date.now() - cached.fetchedAt < KEYS_TTL_MS) return cached.keys;
  const res = await fetcher(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certificates unavailable (HTTP ${res.status})`);
  const body = await res.json() as { keys?: Jwk[] };
  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys ?? []) {
    if (!jwk.kid || jwk.kty !== 'RSA') continue;
    keys.set(jwk.kid, await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']));
  }
  keyCache.set(teamDomain, { keys, fetchedAt: Date.now() });
  return keys;
}

/**
 * Returns the token's claims when it is a valid RS256 token from this Access
 * team for this application and currently valid; otherwise null.
 */
export async function verifyAccessJwt(token: string, config: AccessConfig, fetcher: typeof fetch = fetch, nowS = Date.now() / 1000): Promise<AccessClaims | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let header: { alg?: string; kid?: string };
  let claims: AccessClaims;
  try {
    header = b64urlJson(parts[0]!);
    claims = b64urlJson(parts[1]!);
  } catch {
    return null;
  }
  if (header.alg !== 'RS256' || !header.kid) return null;
  let key = (await signingKeys(config.teamDomain, fetcher, false)).get(header.kid);
  // Unknown key id: Access may have rotated its keys.
  if (!key) key = (await signingKeys(config.teamDomain, fetcher, true)).get(header.kid);
  if (!key) return null;
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(parts[2]!), signed)) return null;
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(config.aud)) return null;
  if (claims.iss !== `https://${config.teamDomain}`) return null;
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_S < nowS) return null;
  if (typeof claims.nbf === 'number' && claims.nbf - CLOCK_SKEW_S > nowS) return null;
  return claims;
}

let configCache: { config: AccessConfig | null; at: number } | null = null;
const CONFIG_TTL_MS = 5 * 60 * 1000;

/**
 * The console's Access team and audience, recorded in settings by the hosted
 * installer. Null for installations that haven't recorded them yet.
 */
export async function accessConfig(db: D1Database): Promise<AccessConfig | null> {
  if (configCache && Date.now() - configCache.at < CONFIG_TTL_MS) return configCache.config;
  const { results } = await db
    .prepare("SELECT key, value FROM settings WHERE key IN ('ACCESS_TEAM_DOMAIN','ACCESS_AUD')")
    .all<{ key: string; value: string }>();
  const value = (key: string) => (results ?? []).find((r) => r.key === key)?.value?.trim() ?? '';
  const teamDomain = value('ACCESS_TEAM_DOMAIN').toLowerCase();
  const aud = value('ACCESS_AUD');
  const config = /^[a-z0-9-]+\.cloudflareaccess\.com$/.test(teamDomain) && /^[A-Za-z0-9]{16,128}$/.test(aud) ? { teamDomain, aud } : null;
  configCache = { config, at: Date.now() };
  return config;
}

/** For tests: forget cached settings and keys. */
export function resetAccessCaches(): void {
  configCache = null;
  keyCache.clear();
}

/**
 * Whether a console request carries a valid Access identity. With Access
 * recorded in settings, the token must verify and its email must match the
 * identity header; without it, the header alone is accepted (as before).
 */
export async function verifiedAccessRequest(req: Request, db: D1Database, fetcher: typeof fetch = fetch): Promise<boolean> {
  const headerEmail = (req.headers.get('cf-access-authenticated-user-email') ?? '').toLowerCase();
  if (!headerEmail) return false;
  const config = await accessConfig(db);
  if (!config) return true;
  const token = req.headers.get('cf-access-jwt-assertion');
  if (!token) return false;
  try {
    const claims = await verifyAccessJwt(token, config, fetcher);
    return !!claims && typeof claims.email === 'string' && claims.email.toLowerCase() === headerEmail;
  } catch (error) {
    console.error('Access token verification failed', error);
    return false;
  }
}
