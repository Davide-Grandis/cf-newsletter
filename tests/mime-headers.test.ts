import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEmail, formatAddress, parseAddress, sanitizeDisplayName } from '../shared/mime';
import { mailtoUnsubscribeAddress, mailtoTokenMatches, parseMailtoUnsubscribe } from '../shared/tracking';

const headersOf = (raw: string) => raw.split('\r\n\r\n')[0]!;
const base = {
  from: 'News <news@example.com>',
  subject: 'Hello',
  messageId: 'id@example.com',
  text: 'body',
  html: '<p>body</p>',
  attachments: [],
};

test('CR/LF in a subscriber name cannot inject headers', () => {
  const name = 'Eve\r\nBcc: victim@example.com\r\nX-Injected: yes';
  const head = headersOf(buildEmail({ ...base, to: { name, email: 'eve@example.com' } }));
  assert.doesNotMatch(head, /^Bcc:/m);
  assert.doesNotMatch(head, /^X-Injected:/m);
  assert.match(head, /^To: "Eve Bcc: victim@example.com X-Injected: yes" <eve@example.com>$/m);
});

test('CR/LF in string addresses, subject and custom header values is neutralised', () => {
  const head = headersOf(buildEmail({
    ...base,
    from: 'News\r\nBcc: a@b.c <news@example.com>',
    to: 'x@example.com\r\nBcc: a@b.c',
    replyTo: 'r@example.com\nX-Evil: 1',
    subject: 'Hi\r\nBcc: a@b.c',
    headers: { 'X-Campaign-ID': 'c1\r\nBcc: a@b.c' },
  }));
  for (const line of head.split('\r\n')) {
    assert.doesNotMatch(line, /^(Bcc|X-Evil):/, line);
  }
});

test('invalid custom header names are rejected', () => {
  assert.throws(() => buildEmail({ ...base, to: 'x@example.com', headers: { 'Bcc: a@b.c\r\nX': 'v' } }));
});

test('non-ASCII display names are RFC 2047 encoded and round-trip', () => {
  const head = headersOf(buildEmail({ ...base, from: 'Café Nouvelles <news@example.com>', to: { name: 'Zoë', email: 'z@example.com' } }));
  assert.match(head, /^From: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <news@example.com>$/m);
  assert.match(head, /^To: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <z@example.com>$/m);
  const word = /^From: =\?UTF-8\?B\?([^?]+)\?=/m.exec(head)![1]!;
  assert.equal(new TextDecoder().decode(Uint8Array.from(atob(word), (c) => c.charCodeAt(0))), 'Café Nouvelles');
  assert.ok(/^[\x00-\x7F]*$/.test(head), 'headers must be 7-bit');
});

test('long non-ASCII subjects are split into encoded-words of at most 75 chars', () => {
  const subject = 'Ünïcödé '.repeat(20);
  const head = headersOf(buildEmail({ ...base, to: 'x@example.com', subject }));
  const words = head.match(/=\?UTF-8\?B\?[^?]+\?=/g)!;
  assert.ok(words.length > 1);
  for (const w of words) assert.ok(w.length <= 75, w);
  const decoded = words
    .map((w) => new TextDecoder().decode(Uint8Array.from(atob(w.slice(10, -2)), (c) => c.charCodeAt(0))))
    .join('');
  assert.equal(decoded, subject);
});

test('ASCII names with specials are quoted and escaped; plain names stay bare', () => {
  assert.equal(formatAddress('Jane Doe', 'j@example.com'), 'Jane Doe <j@example.com>');
  assert.equal(formatAddress('Doe, Jane "JD"', 'j@example.com'), '"Doe, Jane \\"JD\\"" <j@example.com>');
  assert.equal(formatAddress('', 'j@example.com'), 'j@example.com');
  assert.equal(formatAddress(null, 'j@example.com'), 'j@example.com');
  assert.deepEqual(parseAddress('"Doe, Jane \\"JD\\"" <j@example.com>'), { name: 'Doe, Jane "JD"', email: 'j@example.com' });
  assert.deepEqual(parseAddress('j@example.com'), { name: '', email: 'j@example.com' });
});

test('sanitizeDisplayName strips control characters and collapses whitespace', () => {
  assert.equal(sanitizeDisplayName('  Eve\r\n\tSmith\u0000 '), 'Eve Smith');
});

test('mailto unsubscribe address carries the token and round-trips', () => {
  const token = '3F2504E0-4F89-11D3-9A0C-0305E82C3301';
  const addr = mailtoUnsubscribeAddress(42, token, 'example.com');
  assert.equal(addr, 'unsubscribe+42.3f2504e04f8911d39a0c0305e82c3301@example.com');
  assert.ok(addr.split('@')[0]!.length <= 64);
  const parsed = parseMailtoUnsubscribe(addr.toUpperCase());
  assert.equal(parsed?.subscriberId, 42);
  assert.ok(mailtoTokenMatches(token, parsed!.token));
});

test('mailto unsubscribe rejects legacy, malformed and wrong-token addresses', () => {
  assert.equal(parseMailtoUnsubscribe('unsubscribe+42@example.com'), null);
  assert.equal(parseMailtoUnsubscribe('unsubscribe+abc.def@example.com'), null);
  const parsed = parseMailtoUnsubscribe('unsubscribe+42.00000000000000000000000000000000@example.com')!;
  assert.equal(mailtoTokenMatches('3f2504e0-4f89-11d3-9a0c-0305e82c3301', parsed.token), false);
  assert.equal(mailtoTokenMatches('', ''), false);
});
