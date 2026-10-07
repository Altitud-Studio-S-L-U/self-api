import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { getPayment, parsePayment } from './payments.mjs';

// The fictional server and assertions share the selected, protected test file; recipes may only edit payments.mjs.
test('fictional payments API 2026-02 over a real loopback HTTP socket', { timeout: 5000 }, async t => {
  const calls = [];
  const context = { currency: 'EUR', accessToken: 'fixture-payments-token' };
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1:43127');
    const id = decodeURIComponent(url.pathname.slice('/payments/'.length));
    calls.push({ id, method: request.method, path: url.pathname, currency: url.searchParams.get('currency'), headers: { ...request.headers } });
    response.setHeader('content-type', 'application/json');
    const reject = (status, code) => {
      // An error body deliberately resembles a valid payment. HTTP failure must still prevent normalization.
      response.writeHead(status).end(JSON.stringify({ id, amount: { value: '25.99', currency_code: 'EUR' }, error: code }));
    };
    if (request.headers.authorization !== 'Bearer fixture-payments-token') { reject(401, 'invalid-synthetic-token'); return; }
    if (request.headers['x-api-version'] === '2026-01') { reject(410, 'api-version-retired'); return; }
    if (request.method !== 'GET' || request.headers['x-api-version'] !== '2026-02' || !url.pathname.startsWith('/payments/')) {
      reject(400, 'invalid-fictional-request'); return;
    }
    const currency = url.searchParams.get('currency');
    if (!['EUR', 'USD'].includes(currency) || url.searchParams.getAll('currency').length !== 1) {
      reject(400, 'currency-required'); return;
    }
    if (id === 'rate-limited') { response.setHeader('retry-after', '120'); reject(429, 'rate-limited'); return; }
    if (id === 'unavailable') { reject(503, 'provider-unavailable'); return; }
    if (id === 'retired') { reject(410, 'payment-endpoint-retired'); return; }
    if (id === 'malformed-json') { response.end('{"id":'); return; }
    const values = {
      'zero-amount': '0.00', 'one-cent': '0.01', 'fractional-binary': '0.29',
      'maximum-safe': '90071992547409.91', 'unsafe-amount': '90071992547409.92',
      'malformed-money': '25.9', 'money-needs-rounding': '1.005', 'exponent-money': '1e2',
      'leading-zero-money': '025.99', 'negative-money': '-1.00', 'numeric-money': 25.99,
    };
    response.end(JSON.stringify({ id, amount: id === 'missing-amount' ? null : {
      value: Object.hasOwn(values, id) ? values[id] : '25.99',
      currency_code: id === 'currency-mismatch' ? 'USD' : currency,
    }, ...(id === 'additive-fields' ? { status: 'COMPLETED', metadata: { optionalProviderField: true } } : {}) }));
  });
  server.requestTimeout = 2000;
  server.headersTimeout = 2000;
  const count = id => calls.filter(call => call.id === id).length;
  const raw = async (id, { currency = 'EUR', version = '2026-02' } = {}) => {
    const query = currency === null ? '' : `?currency=${encodeURIComponent(currency)}`;
    return fetch(`http://127.0.0.1:43127/payments/${encodeURIComponent(id)}${query}`, {
      headers: { Authorization: 'Bearer fixture-payments-token', 'X-Api-Version': version },
      signal: AbortSignal.timeout(2000),
    });
  };
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(43127, '127.0.0.1', resolve);
    });
    await t.test('the provider rejects the old version and the missing required currency', async () => {
      const old = await raw('old-snapshot-control', { version: '2026-01' });
      assert.equal(old.status, 410);
      assert.equal((await old.json()).error, 'api-version-retired');
      const missing = await raw('missing-currency-control', { currency: null });
      assert.equal(missing.status, 400);
      assert.equal((await missing.json()).error, 'currency-required');
    });
    await t.test('the migrated request forwards caller currency and version while preserving encoded IDs', async () => {
      const id = 'pay/42?attempt=1#part';
      assert.deepEqual(await getPayment(id, context), { reference: id, amountMinor: 2599, currency: 'EUR' });
      assert.equal(count(id), 1);
      const request = calls.find(call => call.id === id);
      assert.equal(request.method, 'GET');
      assert.equal(request.path, `/payments/${encodeURIComponent(id)}`);
      assert.equal(request.currency, 'EUR');
      assert.equal(request.headers['x-api-version'], '2026-02');
    });
    await t.test('the parser independently preserves exact minor units from the real nested response', async () => {
      const response = await raw('parser-isolation');
      assert.equal(response.status, 200);
      assert.deepEqual(parsePayment(await response.json(), 'EUR'), {
        reference: 'parser-isolation', amountMinor: 2599, currency: 'EUR',
      });
    });
    await t.test('caller USD currency is forwarded without fabricating an EUR default', async () => {
      assert.deepEqual(await getPayment('usd-payment', { ...context, currency: 'USD' }), {
        reference: 'usd-payment', amountMinor: 2599, currency: 'USD',
      });
      assert.equal(calls.find(call => call.id === 'usd-payment').currency, 'USD');
    });
    await t.test('additive response fields do not alter the application model', async () => {
      assert.deepEqual(await getPayment('additive-fields', context), {
        reference: 'additive-fields', amountMinor: 2599, currency: 'EUR',
      });
    });
    for (const [id, amountMinor] of [['zero-amount', 0], ['one-cent', 1], ['fractional-binary', 29], ['maximum-safe', Number.MAX_SAFE_INTEGER]]) {
      await t.test(`exact decimal conversion preserves ${id}`, async () => {
        assert.deepEqual(await getPayment(id, context), { reference: id, amountMinor, currency: 'EUR' });
      });
    }
    for (const [id, status] of [['wrong-token', 401], ['rate-limited', 429], ['unavailable', 503], ['retired', 410]]) {
      await t.test(`HTTP ${status} remains a failure with one attempt and no payment conversion`, async () => {
        await assert.rejects(getPayment(id, id === 'wrong-token' ? { ...context, accessToken: 'wrong-fixture-token' } : context), error => {
          assert.equal(error.status, status);
          assert.equal(error.message, `Payment request failed (${status}).`);
          assert.equal(Object.hasOwn(error, 'amountMinor'), false);
          assert.equal(error.message.includes(context.accessToken), false);
          if (status === 429) assert.equal(error.retryAfter, '120');
          return true;
        });
        assert.equal(count(id), 1, 'Neither HTTP errors nor Retry-After authorize another request.');
      });
    }
    for (const id of ['malformed-json', 'malformed-money', 'money-needs-rounding', 'exponent-money', 'leading-zero-money',
      'negative-money', 'numeric-money', 'missing-amount', 'unsafe-amount', 'currency-mismatch']) {
      await t.test(`${id} fails without guessing, rounding or coercing`, async () => {
        await assert.rejects(getPayment(id, context), { message: 'Invalid payment response.' });
        assert.equal(count(id), 1);
      });
    }
    await t.test('missing or unsupported caller currency fails before HTTP', async () => {
      const before = calls.length;
      for (const currency of [undefined, 'JPY', 'eur', '']) {
        await assert.rejects(getPayment('invalid-context', { ...context, currency }), { message: 'Invalid payment request.' });
      }
      assert.equal(calls.length, before);
    });
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
