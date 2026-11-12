import assert from 'node:assert/strict';
import test from 'node:test';
import { applyMailMerge, renderMailMerge, sanitizeMailMergeHtml } from '../shared/mail-merge';
import { renderFooterHtml, renderFooterText, sanitizeFooterHtml } from '../shared/footer';

const settings = {
  mail_merge_enabled: 1,
  mail_merge_incoming: 0,
  mail_merge_html: '<p>Hello {{subscriber_name}},</p>',
  mail_merge_text: 'Hello {{ subscriber_name }},',
};

test('personalizes both parts for each recipient without modifying the templates or body', () => {
  const html = '<p>Original body</p>';
  const text = 'Original body';
  for (const name of ['Jane', 'John']) {
    assert.deepEqual(applyMailMerge(settings, name, html, text), {
      html: `<p>Hello ${name},</p>\n${html}`,
      text: `Hello ${name},\n\n${text}`,
    });
  }
  assert.equal(settings.mail_merge_html, '<p>Hello {{subscriber_name}},</p>');
});

test('disabled mail merge leaves both parts unchanged and retains templates', () => {
  const disabled = { ...settings, mail_merge_enabled: 0 };
  assert.deepEqual(applyMailMerge(disabled, 'Jane', '<p>Body</p>', 'Body'), {
    html: '<p>Body</p>', text: 'Body',
  });
  assert.deepEqual(applyMailMerge({ ...disabled, mail_merge_enabled: 1 }, 'Jane', '', ''), {
    html: '<p>Hello Jane,</p>\n', text: 'Hello Jane,',
  });
});

test('missing names render as empty text in both parts', () => {
  for (const name of [null, undefined, '']) {
    assert.deepEqual(applyMailMerge(settings, name, '', ''), {
      html: '<p>Hello ,</p>\n', text: 'Hello ,',
    });
  }
});

test('escapes subscriber data in HTML while preserving literal text and replacement characters', () => {
  const name = '<img src=x onerror=alert(1)> & "O\'Brien" $& {{subscriber_name}}';
  assert.equal(renderMailMerge('{{ subscriber_name }}', name, true),
    '&lt;img src=x onerror=alert(1)&gt; &amp; &quot;O&#39;Brien&quot; $&amp; {{subscriber_name}}');
  assert.equal(renderMailMerge('{{subscriber_name}}', name, false), name);
});

test('only subscriber_name is substituted, including repeated and whitespace-padded tokens', () => {
  assert.equal(renderMailMerge('{{subscriber_name}} / {{ subscriber_name }} / {{email}} / {{newsletter_name}}', 'Jane', false),
    'Jane / Jane / {{email}} / {{newsletter_name}}');
});

test('inserts the HTML header inside a complete document and preserves its head and body attributes', () => {
  const html = '<!doctype html><html><head><title>Issue</title></head><BODY class="issue"><p>Body</p></BODY></html>';
  assert.equal(applyMailMerge(settings, 'Jane', html, 'Body').html,
    '<!doctype html><html><head><title>Issue</title></head><BODY class="issue">\n<p>Hello Jane,</p>\n<p>Body</p></BODY></html>');
});

test('empty templates add nothing and HTML/text headers work independently', () => {
  for (const empty of [null, '', ' \n ']) {
    assert.deepEqual(applyMailMerge({ ...settings, mail_merge_html: empty, mail_merge_text: empty }, 'Jane', 'HTML', 'Text'),
      { html: 'HTML', text: 'Text' });
  }
  assert.deepEqual(applyMailMerge({ ...settings, mail_merge_html: null }, 'Jane', 'HTML', 'Text'),
    { html: 'HTML', text: 'Hello Jane,\n\nText' });
  assert.deepEqual(applyMailMerge({ ...settings, mail_merge_text: null }, 'Jane', 'HTML', 'Text'),
    { html: '<p>Hello Jane,</p>\nHTML', text: 'Text' });
});

test('sanitizes headers using the footer allow-list without trusting names as URL tokens', () => {
  const template = '<script>alert(1)</script><p onclick="alert(1)">Hello {{subscriber_name}}</p>' +
    '<a href="{{subscriber_name}}">Name</a><a href="javascript:alert(1)">Bad</a>' +
    '<a href="https://example.com">Safe</a>';
  assert.equal(sanitizeMailMergeHtml(template),
    '<p>Hello {{subscriber_name}}</p><a>Name</a><a>Bad</a><a href="https://example.com">Safe</a>');
});

test('does not add unsubscribe links to headers or change footer sanitization and unsubscribe guarantees', () => {
  assert.equal(renderMailMerge(sanitizeMailMergeHtml(settings.mail_merge_html), 'Jane', true), '<p>Hello Jane,</p>');
  assert.equal(sanitizeFooterHtml('<a href="{{unsubscribe_url}}">Leave</a>'),
    '<a href="{{unsubscribe_url}}">Leave</a>');
  const vars = { unsubscribe_url: 'https://example.com/unsubscribe', newsletter_name: 'News', email: 'jane@example.com' };
  assert.match(renderFooterHtml('<p>Footer</p>', vars), /<a href="https:\/\/example.com\/unsubscribe"/);
  assert.equal(renderFooterText('Footer', vars), 'Footer\nUnsubscribe: https://example.com/unsubscribe');
});

test('incoming mode replaces body placeholders while preserving the original formatting and saved headers', () => {
  const incoming = { ...settings, mail_merge_incoming: 1 };
  const html = '<!doctype html><html><head><style>p{font-family:Georgia}</style></head>' +
    '<body><table align="center"><tr><td style="padding:20px"><p style="text-align:right">' +
    'Hello <strong>{{ subscriber_name }}</strong>,</p><p>News for {{subscriber_name}}</p></td></tr></table></body></html>';
  const result = applyMailMerge(incoming, 'Jane & John', html, 'Hello {{subscriber_name}},\nNews for {{ subscriber_name }}');
  assert.deepEqual(result, {
    html: html.replace('{{ subscriber_name }}', 'Jane &amp; John').replace('{{subscriber_name}}', 'Jane &amp; John'),
    text: 'Hello Jane & John,\nNews for Jane & John',
  });
  assert.equal(incoming.mail_merge_html, settings.mail_merge_html);
  assert.equal(incoming.mail_merge_text, settings.mail_merge_text);
});

test('incoming mode does not fall back to prepending saved headers when there is no placeholder', () => {
  assert.deepEqual(applyMailMerge({ ...settings, mail_merge_incoming: 1 }, 'Jane', '<p>Original body</p>', 'Original body'),
    { html: '<p>Original body</p>', text: 'Original body' });
});

test('the master switch leaves placeholders unchanged in incoming mode when disabled', () => {
  assert.deepEqual(applyMailMerge({ ...settings, mail_merge_enabled: 0, mail_merge_incoming: 1 }, 'Jane',
    '<p>Hello {{subscriber_name}}</p>', 'Hello {{subscriber_name}}'), {
    html: '<p>Hello {{subscriber_name}}</p>', text: 'Hello {{subscriber_name}}',
  });
});

test('incoming mode escapes names in visible HTML without changing URLs, styles, comments or document metadata', () => {
  const html = '<html><head><title>{{subscriber_name}}</title><style>/* {{subscriber_name}} */</style></head>' +
    '<body><!-- {{subscriber_name}} --><a href="{{subscriber_name}}" title="1 > 0 {{subscriber_name}}">' +
    '{{subscriber_name}}</a><script>const name="{{subscriber_name}}"</script>' +
    '<p style="font-family:{{subscriber_name}}">{{email}}</p></body></html>';
  const result = applyMailMerge({ ...settings, mail_merge_incoming: 1 }, '<img src=x onerror=alert(1)>', html, '');
  assert.equal(result.html, html.replace('>{{subscriber_name}}</a>', '>&lt;img src=x onerror=alert(1)&gt;</a>'));
});

test('incoming mode renders missing names as empty text and does not recursively substitute subscriber data', () => {
  for (const name of [null, undefined, '']) {
    assert.deepEqual(applyMailMerge({ ...settings, mail_merge_incoming: 1 }, name, '<p>Hello {{subscriber_name}},</p>', 'Hello {{subscriber_name}},'),
      { html: '<p>Hello ,</p>', text: 'Hello ,' });
  }
  assert.deepEqual(applyMailMerge({ ...settings, mail_merge_incoming: 1 }, '$& {{subscriber_name}}',
    '<p>{{subscriber_name}}</p>', '{{subscriber_name}}'),
  { html: '<p>$&amp; {{subscriber_name}}</p>', text: '$& {{subscriber_name}}' });
});

test('prepend mode does not substitute the incoming body and remains available after switching modes', () => {
  const html = '<p>Hello {{subscriber_name}} in the body</p>';
  const text = 'Hello {{subscriber_name}} in the body';
  const incoming = { ...settings, mail_merge_incoming: 1 };
  applyMailMerge(incoming, 'Jane', html, text);
  assert.deepEqual(applyMailMerge({ ...incoming, mail_merge_incoming: 0 }, 'Jane', html, text), {
    html: '<p>Hello Jane,</p>\n' + html,
    text: 'Hello Jane,\n\n' + text,
  });
});
