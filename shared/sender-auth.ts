// Inbound author authentication for the ingest worker.
//
// Email Routing only requires inbound mail to pass SPF *or* DKIM for *some*
// domain, and enforces DMARC only as strictly as the claimed domain's policy
// asks (p=none is not enforced). An allow-list match on an address is therefore
// not proof of authorship: a message DKIM-signed for an attacker's own domain
// can still carry an author's address. We require the visible `From:` address
// (the one matched against the allow-list) to be authenticated with DMARC
// alignment, using the `Authentication-Results` header Email Routing prepends.
// Only the first such header with the `mx.cloudflare.net` authserv-id is
// trusted; any others may have been supplied by the sender.

export const CLOUDFLARE_AUTHSERV_ID = 'mx.cloudflare.net';

export interface AuthResult {
  method: string;
  result: string;
  props: Record<string, string>;
}

export type AuthorAuthVerdict =
  | { ok: true; method: 'dmarc' | 'dkim' | 'spf' }
  | { ok: false; reason: string };

/** Unfolded top-level header lines of a raw RFC 5322 message. */
export function headerLines(raw: Uint8Array | string): string[] {
  const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw.subarray(0, 256 * 1024));
  const end = text.search(/\r?\n\r?\n/);
  const block = end >= 0 ? text.slice(0, end) : text;
  return block.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/);
}

function headerValues(lines: string[], name: string): string[] {
  const prefix = `${name.toLowerCase()}:`;
  return lines.filter((l) => l.toLowerCase().startsWith(prefix)).map((l) => l.slice(prefix.length).trim());
}

function stripComments(value: string): string {
  let out = '';
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (c === '\\') { if (!depth) out += c + (value[i + 1] ?? ''); i++; continue; }
    if (c === '"' && !depth) quoted = !quoted;
    if (!quoted && c === '(') { depth++; continue; }
    if (!quoted && c === ')' && depth) { depth--; continue; }
    if (!depth) out += c;
  }
  return out;
}

/** Parse an RFC 8601 Authentication-Results value. */
export function parseAuthResults(value: string): { authservId: string; results: AuthResult[] } {
  const [id = '', ...parts] = stripComments(value).split(';').map((s) => s.trim());
  const results: AuthResult[] = [];
  for (const part of parts) {
    const [head, ...rest] = part.split(/\s+/);
    const m = /^([a-z0-9_.-]+)=([a-z0-9_-]+)$/i.exec(head ?? '');
    if (!m) continue;
    const props: Record<string, string> = {};
    for (const kv of rest) {
      const eq = kv.indexOf('=');
      if (eq > 0) props[kv.slice(0, eq).toLowerCase()] = kv.slice(eq + 1).replace(/^"|"$/g, '').toLowerCase();
    }
    results.push({ method: m[1]!.toLowerCase(), result: m[2]!.toLowerCase(), props });
  }
  return { authservId: (id.split(/\s+/)[0] ?? '').toLowerCase(), results };
}

function domainOf(addressOrDomain: string): string {
  const v = addressOrDomain.trim().toLowerCase().replace(/^<|>$/g, '');
  return v.slice(v.lastIndexOf('@') + 1).replace(/\.$/, '');
}

// Relaxed DMARC alignment without a public-suffix list: equal domains or one a
// subdomain of the other. Stricter than DMARC for sibling subdomains, which
// only ever rejects, never accepts, more mail.
function aligned(a: string, b: string): boolean {
  return !!a && !!b && (a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`));
}

/**
 * Decide whether the visible From address is authenticated: a DMARC pass for
 * its domain, or (when the domain publishes no DMARC policy) a passing DKIM
 * signature or SPF check aligned with it. A DMARC fail is always rejected.
 */
export function verifyAuthorAuthentication(raw: Uint8Array | string, fromAddress: string): AuthorAuthVerdict {
  const lines = headerLines(raw);
  if (headerValues(lines, 'from').length !== 1) return { ok: false, reason: 'from_header_count' };
  const fromDomain = domainOf(fromAddress);
  if (!fromAddress.includes('@') || !fromDomain) return { ok: false, reason: 'from_missing' };

  const ar = headerValues(lines, 'authentication-results')[0];
  if (ar === undefined) return { ok: false, reason: 'auth_results_missing' };
  const { authservId, results } = parseAuthResults(ar);
  if (authservId !== CLOUDFLARE_AUTHSERV_ID) return { ok: false, reason: 'auth_results_untrusted' };

  const dmarc = results.filter((r) => r.method === 'dmarc' && (!r.props['header.from'] || r.props['header.from'] === fromDomain));
  if (dmarc.some((r) => r.result === 'fail')) return { ok: false, reason: 'dmarc_fail' };
  if (dmarc.some((r) => r.result === 'pass' && r.props['header.from'] === fromDomain)) return { ok: true, method: 'dmarc' };

  if (results.some((r) => r.method === 'dkim' && r.result === 'pass' && aligned(r.props['header.d'] ?? '', fromDomain))) {
    return { ok: true, method: 'dkim' };
  }
  if (results.some((r) => r.method === 'spf' && r.result === 'pass' && aligned(domainOf(r.props['smtp.mailfrom'] ?? ''), fromDomain))) {
    return { ok: true, method: 'spf' };
  }
  return { ok: false, reason: 'not_aligned' };
}
