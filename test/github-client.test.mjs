import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGitHubClient } from '../dist/github-client.js';
import { PlumberError } from '../dist/errors.js';

const route = '/repos/fixture/consumer/git/refs';
const json = (value, init = {}) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' }, ...init });

test('GitHub requests use one fixed origin, explicit headers and fresh credentials without redirects', async () => {
  let calls = 0;
  const client = createGitHubClient({ getToken: () => `fixture-token-${++calls}`, transport: async (url, options) => {
    assert.equal(url.origin, 'https://api.github.com');
    assert.equal(options.headers.Authorization, `Bearer fixture-token-${calls}`);
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.headers['X-GitHub-Api-Version'], '2022-11-28');
    if (options.method === 'POST') assert.deepEqual(JSON.parse(options.body), { ref: 'refs/heads/feat/example' });
    return json({ ok: true });
  } });
  assert.deepEqual(await client.request('GET', route), { ok: true });
  assert.deepEqual(await client.request('POST', route, { ref: 'refs/heads/feat/example' }), { ok: true });
  assert.equal(calls, 2);
});

test('write failures are not retried and response bodies or tokens never appear in errors', async () => {
  for (const status of [401, 403, 409, 422, 429, 500, 503]) {
    let calls = 0;
    const client = createGitHubClient({ getToken: () => 'SECRET_FIXTURE_TOKEN', transport: async () => { calls++; return json({ secret: 'PRIVATE_RESPONSE' }, { status }); } });
    await assert.rejects(client.request('POST', route, {}), error => {
      assert.equal(error.code, 'ENGINE_FAILED');
      assert.doesNotMatch(error.message, /SECRET_FIXTURE_TOKEN|PRIVATE_RESPONSE/u);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('a missing resource is acknowledged only for explicitly allowed reads', async () => {
  const client = createGitHubClient({ getToken: () => 'fixture', transport: async () => json({}, { status: 404 }) });
  assert.equal(await client.request('GET', route, undefined, true), null);
  await assert.rejects(client.request('GET', route), { code: 'ENGINE_FAILED' });
  await assert.rejects(client.request('POST', route, {}, true), { code: 'ENGINE_FAILED' });
});

test('a timed out write is uncertain and signals cancellation exactly once', async () => {
  let calls = 0;
  let signal;
  const client = createGitHubClient({ getToken: () => 'fixture', timeoutMs: 10, transport: (_url, options) => {
    calls++; signal = options.signal; return new Promise(() => {});
  } });
  await assert.rejects(client.request('POST', route, {}), /may have completed remotely/u);
  assert.equal(calls, 1);
  assert.equal(signal.aborted, true);
});

test('a credential timeout cannot trigger a late request', async () => {
  let resolveToken;
  let calls = 0;
  const client = createGitHubClient({ timeoutMs: 10, getToken: () => new Promise(resolve => { resolveToken = resolve; }),
    transport: async () => { calls++; return json({}); } });
  await assert.rejects(client.request('GET', route), { code: 'ENGINE_FAILED' });
  resolveToken('late-fixture-token');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 0);
});

test('malformed, non-JSON, oversized, redirected or invalid UTF-8 responses are rejected', async () => {
  const fixtures = [
    () => new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }),
    () => new Response('{', { headers: { 'content-type': 'application/json' } }),
    () => new Response(Uint8Array.of(255), { headers: { 'content-type': 'application/json' } }),
    () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': String(2 * 1024 * 1024 + 1) } }),
    () => new Response(' '.repeat(2 * 1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } }),
    () => { const response = json({}); Object.defineProperty(response, 'url', { value: 'https://elsewhere.invalid/' }); return response; },
    () => { const response = json({}); Object.defineProperty(response, 'redirected', { value: true }); return response; },
  ];
  for (const response of fixtures) {
    const client = createGitHubClient({ getToken: () => 'fixture', transport: async () => response() });
    await assert.rejects(client.request('GET', route), { code: 'ENGINE_FAILED' });
  }
});

test('unbounded request input and invalid credentials fail before transport', async () => {
  let calls = 0;
  const transport = async () => { calls++; return json({}); };
  for (const token of ['', 'contains whitespace', 'line\nbreak', 'x'.repeat(4097)]) {
    await assert.rejects(createGitHubClient({ getToken: () => token, transport }).request('GET', route), { code: 'INVALID_INPUT' });
  }
  const client = createGitHubClient({ getToken: () => 'fixture', transport });
  for (const path of ['https://evil.invalid/', '//evil.invalid/', '/repos/x/y/a#fragment', '/repos/x/y/a\nb']) {
    await assert.rejects(client.request('GET', path), { code: 'INVALID_INPUT' });
  }
  await assert.rejects(client.request('POST', route, { large: 'x'.repeat(4 * 1024 * 1024) }), { code: 'INVALID_INPUT' });
  await assert.rejects(client.request('GET', route, {}), { code: 'INVALID_INPUT' });
  assert.equal(calls, 0);
});

test('raw transport and credential exceptions are not exposed', async () => {
  for (const options of [
    { getToken: () => { throw new Error('PRIVATE_ERROR'); } },
    { getToken: () => 'fixture', transport: () => { throw new Error('PRIVATE_ERROR'); } },
    { getToken: () => { throw new PlumberError('INVALID_INPUT', 'PRIVATE_ERROR'); } },
    { getToken: () => 'fixture', transport: () => { throw new PlumberError('ENGINE_FAILED', 'PRIVATE_ERROR'); } },
  ]) {
    await assert.rejects(createGitHubClient(options).request('GET', route), error => {
      assert.equal(error.code, 'ENGINE_FAILED'); assert.doesNotMatch(error.message, /PRIVATE_ERROR/u); return true;
    });
  }
});
test('authorization is rechecked after asynchronous credential resolution before a write', async () => {
  let calls = 0;
  const client = createGitHubClient({ getToken: async () => 'fixture', transport: async () => { calls++; return json({}); } });
  await assert.rejects(client.request('POST', route, {}, false, '2000-01-01T00:00:00.000Z'), /authorization expired/u);
  assert.equal(calls, 0);
});
