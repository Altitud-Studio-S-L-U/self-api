import assert from 'node:assert/strict';
import test from 'node:test';
import { captureGitHub } from '../dev/live-validation/capture.mjs';

const path = '/repos/git/git/contents?ref=master';
function reply(version, body = []) {
  const response = new Response(JSON.stringify(body), { headers: {
    'content-type': 'application/json', 'x-github-api-version-selected': version,
  } });
  Object.defineProperty(response, 'url', { value: 'https://api.github.com' + path });
  return response;
}

test('live probe keeps its public GET credential-free and binds the returned version and bytes', async t => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.github.com' + path);
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.headers['X-GitHub-Api-Version'], '2026-03-10');
    return reply('2026-03-10', [{ path: 'controlled-fixture' }]);
  });
  const capture = await captureGitHub(path, '2026-03-10');
  assert.equal(capture.evidence.selectedVersion, '2026-03-10');
  assert.deepEqual(capture.body, JSON.parse(capture.bytes));
  assert.match(capture.evidence.sha256, /^[a-f0-9]{64}$/u);
});

test('a cached response from the wrong version cannot become live migration evidence', async t => {
  t.mock.method(globalThis, 'fetch', async () => reply('2022-11-28'));
  await assert.rejects(captureGitHub(path, '2026-03-10'), /Server must confirm the requested version/);
});

test('the live pilot cannot be repurposed into arbitrary requests and rejects oversized responses', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return reply('2026-03-10', 'x'.repeat(1048576)); });
  await assert.rejects(captureGitHub('/repos/private/repo/contents?ref=master', '2026-03-10'));
  await assert.rejects(captureGitHub(path, 'invalid-version'));
  assert.equal(calls, 0);
  await assert.rejects(captureGitHub(path, '2026-03-10'), /exceeded 1 MiB/);
  assert.equal(calls, 1);
});
