// Build a multipart/mixed (+ multipart/related, + multipart/alternative) MIME message
// with attachments and inline parts. Implemented from scratch (no Node deps) so it runs
// on Workers.

export interface AttachmentPart {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
  contentId?: string;
  disposition: 'attachment' | 'inline';
}

// An address is either a header-style string ('addr' or 'Name <addr>') or a
// structured name/email pair. Either form is re-rendered safely by buildEmail.
export type Address = string | { name?: string | null; email: string };

export interface BuildEmailInput {
  from: Address;
  to: Address;
  subject: string;
  messageId: string;
  // Origination date; defaults to now. Rendered as an RFC 5322 Date header.
  date?: Date;
  replyTo?: Address;
  text: string;
  html: string;
  headers?: Record<string, string>;
  attachments: AttachmentPart[];
}

const CRLF = '\r\n';

function boundary(prefix: string): string {
  const r = crypto.getRandomValues(new Uint8Array(12));
  let s = '';
  for (const b of r) s += b.toString(16).padStart(2, '0');
  return `${prefix}_${s}`;
}

function b64(bytes: Uint8Array): string {
  // chunked to stay safe with large inputs
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  const out = btoa(bin);
  return out.match(/.{1,76}/g)?.join(CRLF) ?? out;
}

// Header values must never carry CR/LF or other control characters: a line
// break would let data start a new header (header injection).
function stripControl(value: string): string {
  return value.replace(/[\x00-\x1F\x7F]+/g, ' ');
}

/**
 * Normalise a human display name (e.g. a subscriber name) for storage and
 * header use: control characters become spaces, whitespace is collapsed.
 */
export function sanitizeDisplayName(name: string): string {
  return stripControl(name).replace(/\s+/g, ' ').trim();
}

function utf8Bin(value: string): string {
  let bin = '';
  for (const b of new TextEncoder().encode(value)) bin += String.fromCharCode(b);
  return bin;
}

// RFC 2047 encoded-words, each at most 75 characters (45 UTF-8 bytes of
// payload), split on code-point boundaries and folded onto continuation lines.
function encodeWords(value: string, separator = `${CRLF} `): string {
  const words: string[] = [];
  let chunk = '';
  for (const ch of value) {
    if (chunk && utf8Bin(chunk + ch).length > 45) {
      words.push(`=?UTF-8?B?${btoa(utf8Bin(chunk))}?=`);
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk) words.push(`=?UTF-8?B?${btoa(utf8Bin(chunk))}?=`);
  return words.join(separator);
}

function encodeHeader(value: string): string {
  // RFC 2047 encoded-word for non-ASCII subjects.
  const clean = stripControl(value);
  return /^[\x20-\x7E]*$/.test(clean) ? clean : encodeWords(clean);
}

function encodeParam(value: string): string {
  // Filename parameter inside a quoted string: single encoded-word, no quotes.
  const clean = stripControl(value).replace(/"/g, '');
  return /^[\x20-\x7E]*$/.test(clean) ? clean : `=?UTF-8?B?${btoa(utf8Bin(clean))}?=`;
}

function cleanAddr(email: string): string {
  return email.replace(/[\x00-\x20\x7F<>"(),;:\\[\]]/g, '');
}

/**
 * Render an RFC 5322 mailbox. The display name is sanitised and either
 * quoted (ASCII with specials) or RFC 2047-encoded (non-ASCII).
 */
export function formatAddress(name: string | null | undefined, email: string): string {
  const addr = cleanAddr(email);
  const display = sanitizeDisplayName(name ?? '');
  return display ? `${renderPhrase(display)} <${addr}>` : addr;
}

// RFC 5322 phrase: bare when safe, quoted when it has specials, RFC 2047 when non-ASCII.
function renderPhrase(display: string, separator?: string): string {
  if (!/^[\x20-\x7E]*$/.test(display)) return encodeWords(display, separator);
  if (/[()<>\[\]:;@\\,."]/.test(display)) return `"${display.replace(/(["\\])/g, '\\$1')}"`;
  return display;
}

/**
 * HTML body for a campaign authored in plain text only. Mail clients prefer
 * the HTML alternative, so without this they would show an empty message with
 * just the footer. Text is escaped; blank lines become paragraphs and single
 * line breaks become <br>.
 */
export function textToHtml(text: string): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n(?:[ \t]*\n)+/)
    .map((p) => p.replace(/^\n+|\n+$/g, ''))
    .filter((p) => p.trim() !== '')
    .map((p) => `<p>${esc(p).replace(/\n/g, '<br>\n')}</p>`)
    .join('\n');
}

/**
 * RFC 2919 List-Id value: an optional description phrase plus a stable,
 * globally unique identifier `<listId>.<domain>`. Use an immutable id (not a
 * renameable name or slug) so mail filters keep matching the list.
 */
export function formatListId(name: string | null | undefined, listId: string, domain: string): string {
  const label = listId.toLowerCase().replace(/[^a-z0-9-]/g, '');
  const host = domain.toLowerCase().replace(/[^a-z0-9.-]/g, '').replace(/^\.+|\.+$/g, '');
  const display = sanitizeDisplayName(name ?? '');
  const id = `<${label}.${host}>`;
  return display ? `${renderPhrase(display, ' ')} ${id}` : id;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** RFC 5322 date-time in UTC, e.g. 'Sat, 21 Nov 2026 18:39:00 +0000'. */
export function formatEmailDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${DAYS[d.getUTCDay()]}, ${p(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

/** Split a header-style address ('addr' or 'Name <addr>', name optionally quoted). */
export function parseAddress(value: string): { name: string; email: string } {
  const v = stripControl(value).trim();
  const m = /^(.*?)\s*<([^<>\s]+)>\s*$/.exec(v);
  if (!m) return { name: '', email: v };
  let name = m[1]!.trim();
  if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) {
    name = name.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  return { name, email: m[2]! };
}

function renderAddress(a: Address): string {
  const { name, email } = typeof a === 'string' ? parseAddress(a) : { name: a.name ?? '', email: a.email };
  return formatAddress(name, email);
}

function quotedPrintable(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let out = '';
  let lineLen = 0;
  const push = (s: string) => {
    if (lineLen + s.length > 75) {
      out += `=${CRLF}`;
      lineLen = 0;
    }
    out += s;
    lineLen += s.length;
  };
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (b === 0x0a) {
      out += CRLF;
      lineLen = 0;
    } else if (b === 0x0d) {
      // skip; will be handled by next \n
    } else if (b === 0x3d || b < 0x20 || b > 0x7e) {
      push(`=${b.toString(16).toUpperCase().padStart(2, '0')}`);
    } else {
      push(String.fromCharCode(b));
    }
  }
  return out;
}

export function buildEmail(input: BuildEmailInput): string {
  const mixed = boundary('mixed');
  const related = boundary('related');
  const alt = boundary('alt');

  const inlineParts = input.attachments.filter((a) => a.disposition === 'inline');
  const fileParts = input.attachments.filter((a) => a.disposition === 'attachment');

  const lines: string[] = [];
  lines.push(`From: ${renderAddress(input.from)}`);
  if (input.replyTo) lines.push(`Reply-To: ${renderAddress(input.replyTo)}`);
  lines.push(`To: ${renderAddress(input.to)}`);
  lines.push(`Subject: ${encodeHeader(input.subject)}`);
  lines.push(`Date: ${formatEmailDate(input.date ?? new Date())}`);
  lines.push(`Message-ID: <${cleanAddr(input.messageId)}>`);
  lines.push('MIME-Version: 1.0');
  for (const [k, v] of Object.entries(input.headers ?? {})) {
    if (!/^[A-Za-z0-9_-]+$/.test(k)) throw new Error(`invalid header name: ${k}`);
    lines.push(`${k}: ${stripControl(v)}`);
  }
  lines.push(`Content-Type: multipart/mixed; boundary="${mixed}"`);
  lines.push('');

  // multipart/mixed -> multipart/related
  lines.push(`--${mixed}`);
  lines.push(`Content-Type: multipart/related; boundary="${related}"`);
  lines.push('');

  // multipart/related -> multipart/alternative
  lines.push(`--${related}`);
  lines.push(`Content-Type: multipart/alternative; boundary="${alt}"`);
  lines.push('');

  // text/plain
  lines.push(`--${alt}`);
  lines.push('Content-Type: text/plain; charset=UTF-8');
  lines.push('Content-Transfer-Encoding: quoted-printable');
  lines.push('');
  lines.push(quotedPrintable(input.text));
  lines.push('');

  // text/html
  lines.push(`--${alt}`);
  lines.push('Content-Type: text/html; charset=UTF-8');
  lines.push('Content-Transfer-Encoding: quoted-printable');
  lines.push('');
  lines.push(quotedPrintable(input.html));
  lines.push('');

  lines.push(`--${alt}--`);
  lines.push('');

  // inline parts (referenced by cid:)
  for (const a of inlineParts) {
    lines.push(`--${related}`);
    lines.push(`Content-Type: ${stripControl(a.contentType)}; name="${encodeParam(a.filename)}"`);
    lines.push('Content-Transfer-Encoding: base64');
    lines.push(`Content-Disposition: inline; filename="${encodeParam(a.filename)}"`);
    if (a.contentId) lines.push(`Content-ID: <${cleanAddr(a.contentId)}>`);
    lines.push('');
    lines.push(b64(a.bytes));
    lines.push('');
  }
  lines.push(`--${related}--`);
  lines.push('');

  // attachments
  for (const a of fileParts) {
    lines.push(`--${mixed}`);
    lines.push(`Content-Type: ${stripControl(a.contentType)}; name="${encodeParam(a.filename)}"`);
    lines.push('Content-Transfer-Encoding: base64');
    lines.push(`Content-Disposition: attachment; filename="${encodeParam(a.filename)}"`);
    lines.push('');
    lines.push(b64(a.bytes));
    lines.push('');
  }
  lines.push(`--${mixed}--`);
  lines.push('');

  return lines.join(CRLF);
}

// Rough size estimate of the final raw MIME (base64 overhead ~+33%).
export function estimateRawSize(textBytes: number, htmlBytes: number, attachments: AttachmentPart[]): number {
  let total = textBytes + htmlBytes + 2048; // headers + boundaries fudge
  for (const a of attachments) total += Math.ceil(a.bytes.byteLength * 4 / 3) + 512;
  return total;
}
