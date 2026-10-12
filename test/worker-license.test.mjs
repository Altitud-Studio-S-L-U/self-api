import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { verifyWorkerLicense, normalizeWorkerLicenseTrust, WorkerLicenseStore } from '../dist/worker-license.js';
import { checkWindowsPermissions } from '../dist/windows-permissions.js';
import { createLicenseFixture } from '../tooling/license-fixture.mjs';

async function fixture(t) {
  const parent = resolve('work/test-worker-license'); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(await realpath(parent), 'case-'));
  checkWindowsPermissions([directory], true, directory);
  const stores = [];
  t.after(async () => { for (const store of stores) store.close(); await rm(directory, { recursive: true }); });
  const value = await createLicenseFixture(directory);
  return { directory, ...value, open: async () => { const store = await WorkerLicenseStore.open(directory, value.credentials, value.trust); stores.push(store); return store; } };
}
test('real JWS binds license to installation, project, DPoP key and separate trusted issuer key', async t => {
  const f = await fixture(t); const claims = await verifyWorkerLicense(f.token, f.trust, f.credentials);
  assert.equal(claims.decision, 'allowed'); assert.equal(claims.exp - claims.iat, 86400);
  for (const token of [f.token.slice(0, -3) + 'abc', await f.sign({ installationId: 'd'.repeat(64) }),
    await f.sign({ projectId: 'd'.repeat(64) }), await f.sign({ jkt: 'd'.repeat(43) }),
    await f.sign({ entitlementExpiresAt: Math.floor(Date.now() / 1000) + 60 }), await f.sign({ unexpected: true })]) {
    await assert.rejects(verifyWorkerLicense(token, f.trust, f.credentials), { code: 'INVALID_INPUT' });
  }
  await assert.rejects(verifyWorkerLicense(f.token, { ...f.trust, keys: [{ ...f.trust.keys[0], kid: 'other' }] }, f.credentials), { code: 'INVALID_INPUT' });
  assert.throws(() => normalizeWorkerLicenseTrust({ ...f.trust, keys: [{ ...f.trust.keys[0], d: 'not-a-public-key' }] }), { code: 'INVALID_INPUT' });
});
test('offline lease persists original expiry, revision and denial across process-store restart', async t => {
  const f = await fixture(t), claims = await verifyWorkerLicense(f.token, f.trust, f.credentials);
  let store = await f.open();
  assert.equal((await store.status()).reason, 'missing'); await store.apply(f.token);
  assert.equal((await store.status()).allowed, true); store.close();
  store = await f.open();
  assert.equal((await store.status(claims.exp * 1000)).reason, 'expired');
  assert.equal((await store.status(claims.exp * 1000 - 1)).reason, 'clock-rollback');
});
test('signed suspension cannot be rolled back; only a higher revision can resume', async t => {
  const f = await fixture(t), store = await f.open();
  await store.apply(f.token); await store.apply(await f.sign({ decision: 'suspended', revision: 2 }));
  assert.equal((await store.status()).reason, 'suspended');
  await assert.rejects(store.apply(f.token), { code: 'INVALID_INPUT' });
  await assert.rejects(store.apply(await f.sign({ revision: 2 })), { code: 'INVALID_INPUT' });
  await store.apply(await f.sign({ revision: 3 })); assert.equal((await store.status()).allowed, true);
});
test('known credential rejection invalidates offline permission and startup import cannot restore it', async t => {
  const f = await fixture(t); let store = await f.open();
  await store.apply(f.token); store.revoke(); store.close();
  store = await f.open();
  assert.equal((await store.status()).reason, 'revoked');
  await assert.rejects(store.apply(f.token), { code: 'INVALID_INPUT' });
  await store.apply(await f.sign(), Date.now(), 'authenticated-control'); assert.equal((await store.status()).allowed, true);
});
