import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import { repositoryRoot, seedDevelopment, selectProviderVersion } from '../dev/local/environment.mjs';
import { createProviderServer } from '../dev/local/provider.mjs';
import { createConsumerServer } from '../dev/local/consumer.mjs';

async function fixture(t) {
  const parent = join(repositoryRoot, 'work/development-tests');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(await realpath(parent), 'environment-'));
  t.after(async () => {
    const actual = await realpath(root);
    assert.equal(dirname(actual), await realpath(parent));
    assert.ok(basename(actual).startsWith('environment-'));
    await rm(actual, { recursive: true, force: false });
  });
  return seedDevelopment(root);
}

async function listen(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('local development seeding preserves provider data, consumer edits, versions and state across restarts', async t => {
  const paths = await fixture(t);
  await writeFile(join(paths.consumer, 'payments.mjs'), '// developer edit\n');
  await writeFile(join(paths.state, 'local-note'), 'retained');
  const data = JSON.stringify([{ id: 'developer-payment', amountMinor: 123, currency: 'USD' }]);
  await writeFile(join(paths.provider, 'payments.json'), data);
  await selectProviderVersion('v2', paths.root);
  assert.deepEqual(await seedDevelopment(paths.root), paths);
  assert.equal(await readFile(join(paths.consumer, 'payments.mjs'), 'utf8'), '// developer edit\n');
  assert.equal(await readFile(join(paths.state, 'local-note'), 'utf8'), 'retained');
  assert.equal(await readFile(join(paths.provider, 'payments.json'), 'utf8'), data);
  assert.equal(JSON.parse(await readFile(join(paths.provider, 'current.json'), 'utf8')).info.version, '2026-02');
  await assert.rejects(selectProviderVersion('unrecognized', paths.root), /Select v1 or v2/u);
});

test('development state rejects accidental reuse from a different OS or path', async t => {
  const paths = await fixture(t);
  const marker = JSON.parse(await readFile(join(paths.root, 'environment.json'), 'utf8'));
  await writeFile(join(paths.root, 'environment.json'), JSON.stringify({ ...marker, platform: 'other-operating-system' }));
  await assert.rejects(seedDevelopment(paths.root), /another host path or operating system/u);
});

test('the persistent fictional provider serves seeded data and retires the old API immediately on a version change', async t => {
  const paths = await fixture(t);
  const base = await listen(t, createProviderServer({ statePath: paths.provider }));
  const request = (path, version = '2026-01', method = 'GET') => fetch(`${base}${path}`, { method,
    headers: { Authorization: 'Bearer fixture-payments-token', 'X-Api-Version': version } });
  assert.equal((await request('/payments/demo-eur', '2026-01', 'POST')).status, 405);
  assert.equal((await fetch(`${base}/payments/demo-eur`)).status, 401);
  assert.deepEqual(await (await request('/payments/demo-eur')).json(), { id: 'demo-eur', totalCents: 2599, currency: 'EUR' });
  await selectProviderVersion('v2', paths.root);
  assert.equal((await request('/payments/demo-eur')).status, 410);
  assert.equal((await request('/payments/demo-eur', '2026-02')).status, 400);
  assert.equal((await request('/payments/demo-eur?currency=USD', '2026-02')).status, 409);
  assert.deepEqual(await (await request('/payments/demo-usd?currency=USD', '2026-02')).json(),
    { id: 'demo-usd', amount: { value: '19.99', currency_code: 'USD' } });
  assert.equal((await (await request('/openapi.json')).json()).info.version, '2026-02');
  await selectProviderVersion('v1', paths.root);
  assert.equal((await request('/payments/demo-eur')).status, 200);
});

test('the development consumer preserves application results and reports upstream failures without raw error details', async t => {
  let calls = 0;
  const base = await listen(t, createConsumerServer({ getPayment: async (id, context) => {
    calls++;
    assert.equal(context.currency, 'EUR');
    if (id === 'gone') throw Object.assign(new Error('private diagnostic fixture'), { status: 410 });
    return { reference: id, amountMinor: 2599, currency: context.currency };
  } }));
  assert.equal((await fetch(`${base}/payments/demo-eur`)).status, 400);
  assert.equal(calls, 0);
  assert.deepEqual(await (await fetch(`${base}/payments/demo-eur?currency=EUR`)).json(),
    { reference: 'demo-eur', amountMinor: 2599, currency: 'EUR' });
  const failed = await fetch(`${base}/payments/gone?currency=EUR`);
  assert.equal(failed.status, 502);
  assert.deepEqual(await failed.json(), { error: 'payment-integration-failed', upstreamStatus: 410 });
  assert.equal((await fetch(`${base}/health`)).status, 200);
});
