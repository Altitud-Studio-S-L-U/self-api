import assert from 'node:assert/strict';
import test from 'node:test';
import { getOrder } from './orders.mjs';

test('the original consumer preserves its internal model against fictional API A', async t => {
  t.mock.method(globalThis, 'fetch', async input => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://orders.example.invalid');
    assert.equal(url.pathname, '/orders/order%2F42');
    assert.equal(url.search, '');
    return Response.json({ id: 'order/42', total: 42.5 });
  });
  assert.deepEqual(await getOrder('order/42', { region: 'fixture/eu west' }), {
    reference: 'order/42', total: 42.5,
  });
});
