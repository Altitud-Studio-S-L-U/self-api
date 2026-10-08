import assert from 'node:assert/strict';
import test from 'node:test';
import { parseEntries, listRepository } from './github-contents.mjs';
import { capturedResponse, expectedEntries } from './live-response.mjs';

test('the captured live 2026 response preserves the existing internal listing', () => {
  assert.deepEqual(parseEntries(capturedResponse), expectedEntries);
  assert.deepEqual(parseEntries(capturedResponse).find(entry => entry.path === 'sha1collisiondetection'),
    expectedEntries.find(entry => entry.path === 'sha1collisiondetection'));
});
test('the consumer selects the reviewed API version and parses its response', async t => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.github.com/repos/git/git/contents?ref=master');
    assert.equal(options.headers['X-GitHub-Api-Version'], '2026-03-10');
    return new Response(JSON.stringify(capturedResponse), { headers: { 'content-type': 'application/json' } });
  });
  assert.deepEqual(await listRepository(), expectedEntries);
});
test('unknown entry types still require review', () => {
  assert.throws(() => parseEntries([{ path: 'x', type: 'unknown', html_url: 'https://github.com/git/git' }]), /Unsupported/);
  assert.throws(() => parseEntries({}), /Invalid contents/);
});
