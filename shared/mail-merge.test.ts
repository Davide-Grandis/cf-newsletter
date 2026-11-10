import assert from 'node:assert/strict';
import test from 'node:test';
import { applyMailMerge, renderMailMerge, sanitizeMailMergeHtml } from './mail-merge';
import { renderFooterHtml, renderFooterText, sanitizeFooterHtml } from './footer';

const settings = {
  mail_merge_enabled: 1,
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
