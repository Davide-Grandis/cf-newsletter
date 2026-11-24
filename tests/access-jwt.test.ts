import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetAccessCaches, verifiedAccessRequest, verifyAccessJwt } from '../workers/admin/src/access-jwt';

const teamDomain = 'myteam.cloudflareaccess.com';
const aud = 'a'.repeat(64);
const config = { teamDomain, aud };

const b64url = (data: Uint8Array | string) =>
  Buffer.from(typeof data === 'string' ? data : data).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const other = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1', alg: 'RS256' };

let certFetches = 0;
let published = [jwk];
const fetcher = (async (url: string | URL) => {
  assert.equal(String(url), `https://${teamDomain}/cdn-cgi/access/certs`);
  certFetches++;
  return Response.json({ keys: published });
}) as typeof fetch;

async function token(claims: Record<string, unknown>, opts: { kid?: string; key?: CryptoKey } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', kid: opts.kid ?? 'k1', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ aud: [aud], iss: `https://${teamDomain}`, email: 'jane@example.com', iat: now, nbf: now, exp: now + 3600, ...claims }));
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', opts.key ?? pair.privateKey, new TextEncoder().encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(sig)}`;
}

function db(settings: Record<string, string>) {
  return { prepare: () => ({ all: async () => ({ results: Object.entries(settings).map(([key, value]) => ({ key, value })) }) }) } as unknown as D1Database;
}
const request = (headers: Record<string, string>) => new Request('https://console.example.com/api/me', { headers });

beforeEach(() => { resetAccessCaches(); certFetches = 0; published = [jwk]; });

test('a valid Access token for this team and application is accepted', async () => {
  const claims = await verifyAccessJwt(await token({}), config, fetcher);
  assert.equal(claims?.email, 'jane@example.com');
});

test('tokens for another application, another team, expired, or forged are rejected', async () => {
  assert.equal(await verifyAccessJwt(await token({ aud: ['b'.repeat(64)] }), config, fetcher), null, 'wrong audience');
  assert.equal(await verifyAccessJwt(await token({ iss: 'https://evil.cloudflareaccess.com' }), config, fetcher), null, 'wrong issuer');
  assert.equal(await verifyAccessJwt(await token({ exp: Math.floor(Date.now() / 1000) - 600 }), config, fetcher), null, 'expired');
  assert.equal(await verifyAccessJwt(await token({}, { key: other.privateKey }), config, fetcher), null, 'signed by another key');
  const valid = await token({});
  const [h, , s] = valid.split('.');
  const tampered = `${h}.${b64url(JSON.stringify({ aud: [aud], iss: `https://${teamDomain}`, email: 'admin@example.com', exp: 9999999999 }))}.${s}`;
  assert.equal(await verifyAccessJwt(tampered, config, fetcher), null, 'claims changed after signing');
  assert.equal(await verifyAccessJwt('not-a-token', config, fetcher), null);
});

test('signing keys are cached, and refreshed when Access rotates them', async () => {
  await verifyAccessJwt(await token({}), config, fetcher);
  await verifyAccessJwt(await token({}), config, fetcher);
  assert.equal(certFetches, 1);
  const rotated = { ...(await crypto.subtle.exportKey('jwk', other.publicKey)), kid: 'k2', alg: 'RS256' };
  published = [jwk, rotated];
  assert.ok(await verifyAccessJwt(await token({}, { kid: 'k2', key: other.privateKey }), config, fetcher));
  assert.equal(certFetches, 2);
});

test('with Access recorded, the console needs a valid token whose email matches the identity header', async () => {
  const configured = db({ ACCESS_TEAM_DOMAIN: teamDomain, ACCESS_AUD: aud });
  const good = await token({});
  assert.equal(await verifiedAccessRequest(request({ 'cf-access-authenticated-user-email': 'Jane@example.com', 'cf-access-jwt-assertion': good }), configured, fetcher), true);
  assert.equal(await verifiedAccessRequest(request({ 'cf-access-authenticated-user-email': 'jane@example.com' }), configured, fetcher), false, 'header without a token');
  assert.equal(await verifiedAccessRequest(request({ 'cf-access-authenticated-user-email': 'admin@example.com', 'cf-access-jwt-assertion': good }), configured, fetcher), false, 'header for someone else');
  assert.equal(await verifiedAccessRequest(request({ 'cf-access-jwt-assertion': good }), configured, fetcher), false, 'no identity header');
});

test('without Access recorded (older installations), the identity header alone is accepted as before', async () => {
  assert.equal(await verifiedAccessRequest(request({ 'cf-access-authenticated-user-email': 'jane@example.com' }), db({}), fetcher), true);
  resetAccessCaches();
  assert.equal(await verifiedAccessRequest(request({ 'cf-access-authenticated-user-email': 'jane@example.com' }), db({ ACCESS_TEAM_DOMAIN: 'not a domain', ACCESS_AUD: aud }), fetcher), true, 'invalid values are ignored');
  assert.equal(certFetches, 0);
});
