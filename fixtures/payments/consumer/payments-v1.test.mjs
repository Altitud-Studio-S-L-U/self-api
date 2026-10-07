import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { getPayment } from './payments.mjs';

// Synthetic credentials and a fictional provider. Only one selected test file runs in each isolated container.
test('fictional payments API 2026-01 over a real loopback HTTP socket', { timeout: 5000 }, async t => {
  const calls = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1:43127');
    calls.push({ method: request.method, path: url.pathname, search: url.search, headers: { ...request.headers } });
    response.setHeader('content-type', 'application/json');
    if (request.headers.authorization !== 'Bearer fixture-payments-token') {
      response.writeHead(401).end(JSON.stringify({ error: 'invalid-synthetic-token' })); return;
    }
    if (request.method !== 'GET' || request.headers['x-api-version'] !== '2026-01' || !url.pathname.startsWith('/payments/')) {
      response.writeHead(400).end(JSON.stringify({ error: 'invalid-fictional-request' })); return;
    }
    const id = decodeURIComponent(url.pathname.slice('/payments/'.length));
    response.end(JSON.stringify({ id, totalCents: 2599, currency: 'EUR',
      ...(id === 'additive-fields' ? { status: 'COMPLETED', metadata: { optionalProviderField: true } } : {}) }));
  });
  server.requestTimeout = 2000;
  server.headersTimeout = 2000;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(43127, '127.0.0.1', resolve);
    });
    await t.test('the original request preserves encoded IDs, version, credentials and minor units', async () => {
      const id = 'pay/42?attempt=1#part';
      assert.deepEqual(await getPayment(id, { currency: 'EUR', accessToken: 'fixture-payments-token' }), {
        reference: id, amountMinor: 2599, currency: 'EUR',
      });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].method, 'GET');
      assert.equal(calls[0].path, `/payments/${encodeURIComponent(id)}`);
      assert.equal(calls[0].search, '');
      assert.equal(calls[0].headers['x-api-version'], '2026-01');
    });
    await t.test('additive provider fields preserve the existing application model', async () => {
      assert.deepEqual(await getPayment('additive-fields', { currency: 'EUR', accessToken: 'fixture-payments-token' }), {
        reference: 'additive-fields', amountMinor: 2599, currency: 'EUR',
      });
      assert.equal(calls.length, 2);
    });
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
