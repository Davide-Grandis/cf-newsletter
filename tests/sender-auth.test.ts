import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAuthResults, verifyAuthorAuthentication } from '../shared/sender-auth';

// Header layout as delivered by Email Routing (captured from a real message,
// domains replaced): ARC-Authentication-Results and Received-SPF come first,
// then Email Routing's own Authentication-Results, then the sender's headers.
const msg = (ar: string | null, opts: { from?: string; extra?: string } = {}) =>
  [
    'ARC-Authentication-Results: i=2; mx.cloudflare.net; dmarc=pass header.from=example.com',
    'Received-SPF: pass (mx.cloudflare.net: domain of author@example.com designates 2001:db8::1 as permitted sender)',
    ...(ar === null ? [] : [`Authentication-Results: ${ar}`]),
    ...(opts.extra ? [opts.extra] : []),
    `From: ${opts.from ?? 'Author <author@example.com>'}`,
    'Subject: hello',
    '',
    'body',
  ].join('\r\n');

const REAL =
  'mx.cloudflare.net; dkim=pass header.d=example.com header.s=google09082023 header.b=WjkhL69V; ' +
  'dmarc=pass header.from=example.com policy.dmarc=reject; ' +
  'spf=none (mx.cloudflare.net: no SPF records found for postmaster@mail-oa1-x2c.google.com) smtp.helo=mail-oa1-x2c.google.com; ' +
  'spf=pass (mx.cloudflare.net: domain of author@example.com designates 2001:db8::1 as permitted sender) smtp.mailfrom=author@example.com';

test('parses the Email Routing Authentication-Results format, ignoring comments', () => {
  const { authservId, results } = parseAuthResults(REAL);
  assert.equal(authservId, 'mx.cloudflare.net');
  assert.deepEqual(results.map((r) => `${r.method}=${r.result}`), ['dkim=pass', 'dmarc=pass', 'spf=none', 'spf=pass']);
  assert.equal(results[1]!.props['header.from'], 'example.com');
  assert.equal(results[3]!.props['smtp.mailfrom'], 'author@example.com');
});

test('accepts a genuine author with a DMARC pass for the From domain', () => {
  assert.deepEqual(verifyAuthorAuthentication(msg(REAL), 'author@example.com'), { ok: true, method: 'dmarc' });
  assert.deepEqual(verifyAuthorAuthentication(new TextEncoder().encode(msg(REAL)), 'author@example.com'), { ok: true, method: 'dmarc' });
});

test('rejects the spoof: valid DKIM for the attacker domain, author address in From (p=none)', () => {
  const ar = 'mx.cloudflare.net; dkim=pass header.d=attacker.test header.s=s1; dmarc=fail header.from=example.com policy.dmarc=none; spf=fail smtp.mailfrom=author@example.com';
  assert.deepEqual(verifyAuthorAuthentication(msg(ar), 'author@example.com'), { ok: false, reason: 'dmarc_fail' });
});

test('rejects unaligned auth when the From domain has no DMARC record', () => {
  const ar = 'mx.cloudflare.net; dkim=pass header.d=attacker.test; dmarc=none header.from=example.com; spf=pass smtp.mailfrom=bounce@attacker.test';
  assert.deepEqual(verifyAuthorAuthentication(msg(ar), 'author@example.com'), { ok: false, reason: 'not_aligned' });
});

test('without DMARC, accepts aligned DKIM or aligned SPF (relaxed, subdomains)', () => {
  const dkim = 'mx.cloudflare.net; dkim=pass header.d=mail.example.com; dmarc=none header.from=example.com; spf=none';
  assert.deepEqual(verifyAuthorAuthentication(msg(dkim), 'author@example.com'), { ok: true, method: 'dkim' });
  const spf = 'mx.cloudflare.net; dkim=none; dmarc=none header.from=example.com; spf=pass smtp.mailfrom=bounces@example.com';
  assert.deepEqual(verifyAuthorAuthentication(msg(spf), 'author@example.com'), { ok: true, method: 'spf' });
});

test('trusts only the first Authentication-Results header, and only from mx.cloudflare.net', () => {
  const fail = 'mx.cloudflare.net; dkim=none; dmarc=fail header.from=example.com; spf=fail smtp.mailfrom=author@example.com';
  const forged = 'Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=example.com';
  assert.deepEqual(verifyAuthorAuthentication(msg(fail, { extra: forged }), 'author@example.com'), { ok: false, reason: 'dmarc_fail' });
  const other = 'mx.google.com; dkim=pass header.d=example.com; dmarc=pass header.from=example.com';
  assert.deepEqual(verifyAuthorAuthentication(msg(other), 'author@example.com'), { ok: false, reason: 'auth_results_untrusted' });
  assert.deepEqual(verifyAuthorAuthentication(msg(null), 'author@example.com'), { ok: false, reason: 'auth_results_missing' });
});

test('a DMARC pass for a different domain does not authenticate the From address', () => {
  const ar = 'mx.cloudflare.net; dkim=pass header.d=attacker.test; dmarc=pass header.from=attacker.test';
  assert.deepEqual(verifyAuthorAuthentication(msg(ar), 'author@example.com'), { ok: false, reason: 'not_aligned' });
});

test('rejects messages with zero or multiple From headers, or no address', () => {
  assert.deepEqual(
    verifyAuthorAuthentication(msg(REAL, { extra: 'From: attacker@attacker.test' }), 'author@example.com'),
    { ok: false, reason: 'from_header_count' },
  );
  assert.deepEqual(verifyAuthorAuthentication(msg(REAL), ''), { ok: false, reason: 'from_missing' });
});

test('folded headers are unfolded before parsing', () => {
  const folded = msg('mx.cloudflare.net;\r\n\tdkim=pass header.d=example.com;\r\n\tdmarc=pass header.from=example.com policy.dmarc=reject');
  assert.deepEqual(verifyAuthorAuthentication(folded, 'author@example.com'), { ok: true, method: 'dmarc' });
});
