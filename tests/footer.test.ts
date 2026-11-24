import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hasUnsubscribePlaceholder,
  prepareIncomingFooterHtml,
  renderIncomingFooterHtml,
  renderIncomingFooterText,
} from '../shared/footer';
import { instrumentHtml } from '../shared/tracking';

const vars = { unsubscribe_url: 'https://track.example.com/u/7?t=a&b', newsletter_name: 'News & Co', email: 'jane@example.com' };
const url = 'https://track.example.com/u/7?t=a&amp;b';

test('detects the unsubscribe placeholder as typed and as mangled by mail clients', () => {
  for (const s of ['{{unsubscribe_url}}', '{{ unsubscribe_url }}', 'http://{{unsubscribe_url}}', 'https://%7B%7Bunsubscribe_url%7D%7D', '%7b%7bunsubscribe_url%7d%7d']) {
    assert.ok(hasUnsubscribePlaceholder(s), s);
  }
  for (const s of [null, undefined, '', '{{email}}', 'unsubscribe_url']) assert.ok(!hasUnsubscribePlaceholder(s));
});

test('incoming HTML footer resolves link targets, visible text and data variables', () => {
  const html = '<p>{{newsletter_name}} for {{ email }}</p><a href="{{unsubscribe_url}}">Leave</a>';
  assert.equal(renderIncomingFooterHtml(prepareIncomingFooterHtml(html), vars),
    `<p>News &amp; Co for jane@example.com</p><a href="${url}">Leave</a>`);
});

test('mangled unsubscribe links are normalised before tracking and never click-rewritten', async () => {
  const html = `<a href='http://{{unsubscribe_url}}'>Leave</a> <a href="https://%7B%7Bunsubscribe_url%7D%7D">Stop</a> <a href="https://example.com">Site</a>`;
  const tracked = await instrumentHtml(prepareIncomingFooterHtml(html), 'https://track.example.com', 'key', 'c1', 7);
  const out = renderIncomingFooterHtml(tracked, vars);
  const hrefs = [...out.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(hrefs.slice(0, 2), [url, url]);
  assert.ok(hrefs[2]!.includes(encodeURIComponent('https://example.com')) && hrefs[2] !== 'https://example.com');
  assert.ok(!out.includes('unsubscribe_url'));
});

test('a bare placeholder becomes a link, but not inside an existing link', () => {
  assert.equal(renderIncomingFooterHtml('<p>Unsubscribe: {{unsubscribe_url}}</p>', vars),
    `<p>Unsubscribe: <a href="${url}">${url}</a></p>`);
  assert.equal(renderIncomingFooterHtml('<a href="{{unsubscribe_url}}">{{unsubscribe_url}}</a>', vars),
    `<a href="${url}">${url}</a>`);
});

test('variables are not substituted in comments, styles, scripts or document metadata', () => {
  const html = '<head><title>{{email}}</title></head><!-- {{unsubscribe_url}} --><style>/* {{email}} */</style><p>x</p>';
  const out = renderIncomingFooterHtml(html, vars);
  assert.ok(out.startsWith(html));
  assert.match(out, /Unsubscribe<\/a><\/p>$/);
});

test('without a placeholder the standard unsubscribe line is appended to each part', () => {
  assert.equal(renderIncomingFooterHtml('<p>Body</p>', vars),
    `<p>Body</p>\n<p style="font-size:12px;line-height:1.5;color:#64748b;margin:8px 0 0"><a href="${url}" style="color:#64748b">Unsubscribe</a></p>`);
  assert.equal(renderIncomingFooterText('Body\n\n', vars), `Body\n\nUnsubscribe: ${vars.unsubscribe_url}`);
  assert.equal(renderIncomingFooterText('', vars), `Unsubscribe: ${vars.unsubscribe_url}`);
});

test('incoming text footer substitutes raw values', () => {
  assert.equal(renderIncomingFooterText('{{newsletter_name}} / {{email}} / leave: http://{{unsubscribe_url}}', vars),
    `News & Co / jane@example.com / leave: ${vars.unsubscribe_url}`);
});

test('placeholders split by formatting tags (pasted with styling) are still resolved', () => {
  const html = '<div>Leave: {{<span style="color:red">unsubscribe_url</span>}} / {{ <b>email</b> }} / {{<i>newsletter_name</i>}}</div>';
  assert.equal(renderIncomingFooterHtml(prepareIncomingFooterHtml(html), vars),
    `<div>Leave: <span style="color:red"><a href="${url}">${url}</a></span> / <b>jane@example.com</b> / <i>News &amp; Co</i></div>`);
});
