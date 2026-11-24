import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consoleAccessEmail } from '../workers/admin/src/access-email';

const base = { email: 'jane@example.com', consoleUrl: 'https://console.example.com' };

test('the welcome email names the role, links the console and embeds the logo by cid', () => {
  const mail = consoleAccessEmail({ ...base, event: 'added', role: 'super_admin', logoCid: 'logo' });
  assert.equal(mail.subject, 'You have been added to the Newsletter Console');
  assert.match(mail.html, /Super administrator/);
  assert.match(mail.html, /<a href="https:\/\/console\.example\.com"[^>]*>Open the console<\/a>/);
  assert.match(mail.html, /<img src="cid:logo"/);
  assert.match(mail.text, /as Super administrator\.[\s\S]*Open the console: https:\/\/console\.example\.com/);
});

test('without a logo there is no image, and the removal email has no sign-in button', () => {
  const mail = consoleAccessEmail({ ...base, event: 'removed', role: 'admin' });
  assert.doesNotMatch(mail.html, /<img/);
  assert.doesNotMatch(mail.html, /Open the console/);
  assert.match(mail.html, /previously had the role/);
  assert.match(mail.html, /Administrator/);
});

test('the recipient address is escaped in the HTML', () => {
  const mail = consoleAccessEmail({ ...base, email: '"<b>x</b>"@example.com', event: 'added', role: 'admin' });
  assert.doesNotMatch(mail.html, /<b>x<\/b>/);
  assert.match(mail.html, /&quot;&lt;b&gt;x&lt;\/b&gt;&quot;@example\.com/);
});
