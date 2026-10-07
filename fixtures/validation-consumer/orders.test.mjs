import assert from 'node:assert/strict';
import test from 'node:test';
import { getOrder } from './orders.mjs';

test('API B requires the existing region to be forwarded without a fabricated default', async t => {
  t.mock.method(globalThis, 'fetch', async input => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://orders.example.invalid');
    assert.equal(url.pathname, '/orders/order%2F42');
    assert.equal(url.searchParams.get('region'), 'fixture/eu west');
    return Response.json({ id: 'order/42', amount: 42.5 });
  });
  assert.deepEqual(await getOrder('order/42', { region: 'fixture/eu west' }), {
    reference: 'order/42', total: 42.5,
  });
});

test('the API B parser preserves the application model and amount units', async t => {
  // This case isolates parsing from request construction using a controlled response.
  t.mock.method(globalThis, 'fetch', async () => Response.json({ id: 'order/42', amount: 42.5 }));
  assert.deepEqual(await getOrder('order/42', { region: 'fixture/eu west' }), {
    reference: 'order/42', total: 42.5,
  });
});

test('a malformed provider amount is still rejected', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ id: 'order/42', amount: '42.5' }));
  await assert.rejects(getOrder('order/42', { region: 'fixture/eu west' }), /Invalid order response/u);
});
