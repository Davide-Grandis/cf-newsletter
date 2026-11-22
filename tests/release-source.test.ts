import assert from 'node:assert/strict';
import test from 'node:test';
import { githubRelease } from '../shared/update-release';

const release = {
  id: 454617547, tag_name: 'v2.6.2', draft: false, prerelease: false, published_at: '2026-11-22T17:25:06Z', body: 'notes',
  assets: [{ name: 'cf-newsletter-2.6.2.json', size: 1832525, digest: `sha256:${'a'.repeat(64)}`,
    browser_download_url: 'https://github.com/Davide-Grandis/cf-newsletter/releases/download/v2.6.2/cf-newsletter-2.6.2.json' }],
};
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function stubFetch(handler: (url: string, init?: RequestInit) => Response): string[] {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    return handler(url, init);
  }) as typeof fetch;
  return calls;
}
const INSTALLER = 'https://installer.cf-newsletter.com';
const GITHUB = 'https://api.github.com/repos/Davide-Grandis/cf-newsletter/releases';

test('without a token, release metadata comes from the installer and GitHub is not called', async () => {
  const calls = stubFetch(() => json(release));
  assert.equal((await githubRelease('/latest', { installerOrigin: INSTALLER })).tag_name, 'v2.6.2');
  assert.deepEqual(calls, [`${INSTALLER}/api/releases/latest`]);
  await githubRelease('/454617547', { installerOrigin: INSTALLER });
  assert.equal(calls[1], `${INSTALLER}/api/releases/454617547`);
});

test('with a token, GitHub is called directly with it', async () => {
  let auth: string | null = null;
  const calls = stubFetch((_url, init) => { auth = new Headers(init?.headers).get('authorization'); return json(release); });
  await githubRelease('/latest', { token: 't0ken', installerOrigin: INSTALLER });
  assert.deepEqual(calls, [`${GITHUB}/latest`]);
  assert.equal(auth, 'Bearer t0ken');
  await githubRelease('/latest', 't0ken');
  assert.equal(calls[1], `${GITHUB}/latest`);
});

test('falls back to anonymous GitHub when the installer lookup fails', async () => {
  const calls = stubFetch((url) => url.startsWith(INSTALLER) ? json({ error: 'down' }, 502) : json(release));
  assert.equal((await githubRelease('/latest', { installerOrigin: INSTALLER })).id, 454617547);
  assert.deepEqual(calls, [`${INSTALLER}/api/releases/latest`, `${GITHUB}/latest`]);
});

test('reports GitHub rate limiting and the installer failure when both fail', async () => {
  stubFetch((url) => url.startsWith(INSTALLER)
    ? json({ error: 'GitHub Releases request failed (HTTP 503).' }, 502)
    : json({ message: 'API rate limit exceeded for 104.28.0.1.' }, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1795375200' }));
  await assert.rejects(githubRelease('/latest', { installerOrigin: INSTALLER }), (error: Error) => {
    assert.match(error.message, /HTTP 403: API rate limit exceeded for 104\.28\.0\.1\.; rate limit resets at 2026-11-22T19:20:00\.000Z/);
    assert.match(error.message, /installer release lookup also failed \(HTTP 502: GitHub Releases request failed/);
    return true;
  });
});

test('installer responses are validated like GitHub responses', async () => {
  stubFetch((url) => url.startsWith(INSTALLER) ? json({ ...release, draft: true }) : json({ message: 'Not Found' }, 404));
  await assert.rejects(githubRelease('/latest', { installerOrigin: INSTALLER }), /HTTP 404: Not Found/);
  stubFetch(() => json({ ...release, tag_name: 'latest' }));
  await assert.rejects(githubRelease('/latest', { token: 'x' }), /Invalid or unpublished product release/);
  await assert.rejects(githubRelease('/../evil', { installerOrigin: INSTALLER }), /Invalid release selection/);
});
