import assert from 'node:assert/strict';
import test from 'node:test';
import { applyMailMerge, renderMailMerge, sanitizeMailMergeHtml } from '../shared/mail-merge';
import { renderFooterHtml, renderFooterText, sanitizeFooterHtml } from '../shared/footer';

const JANE = { first_name: 'Jane' };

const settings = {
  mail_merge_enabled: 1,
  mail_merge_incoming: 0,
  mail_merge_html: '<p>Hello {{full_name}},</p>',
  mail_merge_text: 'Hello {{ full_name }},',
};

test('personalizes both parts for each recipient without modifying the templates or body', () => {
  const html = '<p>Original body</p>';
  const text = 'Original body';
  for (const name of ['Jane', 'John']) {
    assert.deepEqual(applyMailMerge(settings, { first_name: name }, html, text), {
      html: `<p>Hello ${name},</p>\n${html}`,
      text: `Hello ${name},\n\n${text}`,
    });
  }
  assert.equal(settings.mail_merge_html, '<p>Hello {{full_name}},</p>');
});

test('disabled mail merge leaves both parts unchanged and retains templates', () => {
  const disabled = { ...settings, mail_merge_enabled: 0 };
  assert.deepEqual(applyMailMerge(disabled, JANE, '<p>Body</p>', 'Body'), {
    html: '<p>Body</p>', text: 'Body',
  });
  assert.deepEqual(applyMailMerge({ ...disabled, mail_merge_enabled: 1 }, JANE, '', ''), {
    html: '<p>Hello Jane,</p>\n', text: 'Hello Jane,',
  });
});

test('missing names render as empty text in both parts', () => {
  for (const vars of [null, undefined, {}, { first_name: '', last_name: ' ' }]) {
    assert.deepEqual(applyMailMerge(settings, vars, '', ''), {
      html: '<p>Hello ,</p>\n', text: 'Hello ,',
    });
  }
});

test('escapes subscriber data in HTML while preserving literal text and replacement characters', () => {
  const name = '<img src=x onerror=alert(1)> & "O\'Brien" $& {{full_name}}';
  assert.equal(renderMailMerge('{{ full_name }}', { first_name: name }, true),
    '&lt;img src=x onerror=alert(1)&gt; &amp; &quot;O&#39;Brien&quot; $&amp; {{full_name}}');
  assert.equal(renderMailMerge('{{full_name}}', { first_name: name }, false), name);
});

test('only name variables are substituted, including repeated and whitespace-padded tokens', () => {
  assert.equal(renderMailMerge('{{full_name}} / {{ full_name }} / {{email}} / {{newsletter_name}} / {{subscriber_name}}', JANE, false),
    'Jane / Jane / {{email}} / {{newsletter_name}} / {{subscriber_name}}');
});

test('first_name, last_name and full_name are derived from the first and last name', () => {
  const template = '{{first_name}}|{{ last_name }}|{{full_name}}';
  assert.equal(renderMailMerge(template, { first_name: 'Davide', last_name: 'Grandis' }, false), 'Davide|Grandis|Davide Grandis');
  assert.equal(renderMailMerge(template, { first_name: ' Davide ', last_name: null }, false), 'Davide||Davide');
  assert.equal(renderMailMerge(template, { first_name: 'Ann', last_name: "O'Neil & Co" }, true), 'Ann|O&#39;Neil &amp; Co|Ann O&#39;Neil &amp; Co');
});

test('inserts the HTML header inside a complete document and preserves its head and body attributes', () => {
  const html = '<!doctype html><html><head><title>Issue</title></head><BODY class="issue"><p>Body</p></BODY></html>';
  assert.equal(applyMailMerge(settings, JANE, html, 'Body').html,
    '<!doctype html><html><head><title>Issue</title></head><BODY class="issue">\n<p>Hello Jane,</p>\n<p>Body</p></BODY></html>');
});

test('empty templates add nothing and HTML/text headers work independently', () => {
  for (const empty of [null, '', ' \n ']) {
    assert.deepEqual(applyMailMerge({ ...settings, mail_merge_html: empty, mail_merge_text: empty }, JANE, 'HTML', 'Text'),
      { html: 'HTML', text: 'Text' });
  }
  assert.deepEqual(applyMailMerge({ ...settings, mail_merge_html: null }, JANE, 'HTML', 'Text'),
    { html: 'HTML', text: 'Hello Jane,\n\nText' });
  assert.deepEqual(applyMailMerge({ ...settings, mail_merge_text: null }, JANE, 'HTML', 'Text'),
    { html: '<p>Hello Jane,</p>\nHTML', text: 'Text' });
});

test('sanitizes headers using the footer allow-list without trusting names as URL tokens', () => {
  const template = '<script>alert(1)</script><p onclick="alert(1)">Hello {{full_name}}</p>' +
    '<a href="{{full_name}}">Name</a><a href="javascript:alert(1)">Bad</a>' +
    '<a href="https://example.com">Safe</a>';
  assert.equal(sanitizeMailMergeHtml(template),
    '<p>Hello {{full_name}}</p><a>Name</a><a>Bad</a><a href="https://example.com">Safe</a>');
});

test('does not add unsubscribe links to headers or change footer sanitization and unsubscribe guarantees', () => {
  assert.equal(renderMailMerge(sanitizeMailMergeHtml(settings.mail_merge_html), JANE, true), '<p>Hello Jane,</p>');
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
    'Hello <strong>{{ full_name }}</strong>,</p><p>News for {{full_name}}</p></td></tr></table></body></html>';
  const result = applyMailMerge(incoming, { first_name: 'Jane & John' }, html, 'Hello {{full_name}},\nNews for {{ full_name }}');
  assert.deepEqual(result, {
    html: html.replace('{{ full_name }}', 'Jane &amp; John').replace('{{full_name}}', 'Jane &amp; John'),
    text: 'Hello Jane & John,\nNews for Jane & John',
  });
  assert.equal(incoming.mail_merge_html, settings.mail_merge_html);
  assert.equal(incoming.mail_merge_text, settings.mail_merge_text);
});

test('incoming mode does not fall back to prepending saved headers when there is no placeholder', () => {
  assert.deepEqual(applyMailMerge({ ...settings, mail_merge_incoming: 1 }, JANE, '<p>Original body</p>', 'Original body'),
    { html: '<p>Original body</p>', text: 'Original body' });
});

test('the master switch leaves placeholders unchanged in incoming mode when disabled', () => {
  assert.deepEqual(applyMailMerge({ ...settings, mail_merge_enabled: 0, mail_merge_incoming: 1 }, JANE,
    '<p>Hello {{full_name}}</p>', 'Hello {{full_name}}'), {
    html: '<p>Hello {{full_name}}</p>', text: 'Hello {{full_name}}',
  });
});

test('incoming mode escapes names in visible HTML without changing URLs, styles, comments or document metadata', () => {
  const html = '<html><head><title>{{full_name}}</title><style>/* {{full_name}} */</style></head>' +
    '<body><!-- {{full_name}} --><a href="{{full_name}}" title="1 > 0 {{full_name}}">' +
    '{{full_name}}</a><script>const name="{{full_name}}"</script>' +
    '<p style="font-family:{{full_name}}">{{email}}</p></body></html>';
  const result = applyMailMerge({ ...settings, mail_merge_incoming: 1 }, { first_name: '<img src=x onerror=alert(1)>' }, html, '');
  assert.equal(result.html, html.replace('>{{full_name}}</a>', '>&lt;img src=x onerror=alert(1)&gt;</a>'));
});

test('incoming mode renders missing names as empty text and does not recursively substitute subscriber data', () => {
  for (const vars of [null, undefined, {}]) {
    assert.deepEqual(applyMailMerge({ ...settings, mail_merge_incoming: 1 }, vars, '<p>Hello {{full_name}},</p>', 'Hello {{full_name}},'),
      { html: '<p>Hello ,</p>', text: 'Hello ,' });
  }
  assert.deepEqual(applyMailMerge({ ...settings, mail_merge_incoming: 1 }, { first_name: '$& {{full_name}}' },
    '<p>{{full_name}}</p>', '{{full_name}}'),
  { html: '<p>$&amp; {{full_name}}</p>', text: '$& {{full_name}}' });
});

test('prepend mode does not substitute the incoming body and remains available after switching modes', () => {
  const html = '<p>Hello {{full_name}} in the body</p>';
  const text = 'Hello {{full_name}} in the body';
  const incoming = { ...settings, mail_merge_incoming: 1 };
  applyMailMerge(incoming, JANE, html, text);
  assert.deepEqual(applyMailMerge({ ...incoming, mail_merge_incoming: 0 }, JANE, html, text), {
    html: '<p>Hello Jane,</p>\n' + html,
    text: 'Hello Jane,\n\n' + text,
  });
});

test('incoming placeholders split by formatting tags (pasted with styling) are still resolved', () => {
  const html = '<p>Hi {{<span style="color:red">first_name</span>}} {{ <b>last_name</b> }}, {{<i>full_name</i>}}</p>';
  assert.equal(applyMailMerge({ ...settings, mail_merge_incoming: 1 }, { first_name: 'Jane', last_name: 'Doe' }, html, '').html,
    '<p>Hi <span style="color:red">Jane</span> <b>Doe</b>, <i>Jane Doe</i></p>');
});
