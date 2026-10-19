import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { completeWorkerSetup, diagnoseWorker, initWorkerSetup, installWorkerLicenseTrust, runWorkerSetupCli, workerSetupFiles } from '../dist/index.js';

const posix = process.platform !== 'win32';
const origin = 'https://keepseam.com', projectId = 'b'.repeat(64), clientSecret = 'c'.repeat(64);
const fingerprint = key => createHash('sha256').update(JSON.stringify({ crv: key.crv, kty: key.kty, x: key.x, y: key.y })).digest('hex');
async function licenseKey(kid) {
  const pair = await generateKeyPair('ES256', { extractable: true });
  const { kty, crv, x, y } = await exportJWK(pair.publicKey);
  return { privateKey: pair.privateKey, publicJwk: { kty, crv, kid, x, y } };
}
async function enrolled(t, { complete = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'keepseam-trust-'));
  if (posix) await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'worker');
  const identity = await initWorkerSetup({ directory });
  if (complete) await completeWorkerSetup({ directory, enrollment: { baseUrl: origin, installationId: identity.installationId, projectId, clientSecret } });
  return { root, directory, identity };
}
const document = (...keys) => ({ schemaVersion: 1, issuer: origin, keys: keys.map(key => key.publicJwk) });
const expected = (...keys) => Object.fromEntries(keys.map(key => [key.publicJwk.kid, fingerprint(key.publicJwk)]));

test('trust is installed only when every key matches a fingerprint obtained separately', async t => {
  const { directory } = await enrolled(t);
  const [first, second] = [await licenseKey('license-2026a'), await licenseKey('license-2026b')];
  const result = await installWorkerLicenseTrust({ directory, trust: document(first, second), expected: expected(first, second) });
  assert.deepEqual(result.keys.map(key => key.publicKeySha256), [fingerprint(first.publicJwk), fingerprint(second.publicJwk)]);
  assert.deepEqual(JSON.parse(await readFile(result.trustPath, 'utf8')), document(first, second));
  if (posix) assert.equal((await stat(result.trustPath)).mode & 0o777, 0o600);
  // An identical re-run is accepted; a different document never replaces the installed one.
  await installWorkerLicenseTrust({ directory, trust: document(first, second), expected: expected(first, second) });
  await assert.rejects(installWorkerLicenseTrust({ directory, trust: document(first), expected: expected(first) }), /differs/u);
});

test('missing, extra, mismatched or foreign keys and issuers are refused without writing', async t => {
  const { directory } = await enrolled(t);
  const [first, second] = [await licenseKey('license-a'), await licenseKey('license-b')];
  const trustPath = join(directory, workerSetupFiles.trust);
  for (const [trust, wanted, message] of [
    [document(first, second), expected(first), /exactly the keys/u],
    [document(first), expected(first, second), /exactly the keys/u],
    [document(first), { 'license-a': fingerprint(second.publicJwk) }, /expected fingerprint/u],
    [{ ...document(first), issuer: 'https://keepseam.example' }, expected(first), /issuer differs/u],
    [{ ...document(first), extra: true }, expected(first), /malformed/u],
    [document({ publicJwk: { ...first.publicJwk, y: second.publicJwk.y } }), { 'license-a': fingerprint({ ...first.publicJwk, y: second.publicJwk.y }) }, /malformed/u],
    [document(first), {}, /kid=sha256/u],
  ]) {
    await assert.rejects(installWorkerLicenseTrust({ directory, trust, expected: wanted }), message);
    assert.equal(existsSync(trustPath), false);
  }
});

test('before completion the trust must name the origin pinned at init', async t => {
  const { directory } = await enrolled(t, { complete: false });
  const key = await licenseKey('license-a');
  await assert.rejects(installWorkerLicenseTrust({ directory, trust: { ...document(key), issuer: 'https://other.example' }, expected: expected(key) }), /issuer differs/u);
  assert.ok((await installWorkerLicenseTrust({ directory, trust: document(key), expected: expected(key) })).trustPath);
});

test('doctor reports the configuration hash, the trust and a pure offline lease check, without claims or tokens', async t => {
  const { directory, identity } = await enrolled(t);
  const key = await licenseKey('license-a');
  await installWorkerLicenseTrust({ directory, trust: document(key), expected: expected(key) });
  const healthy = await diagnoseWorker({ directory, platform: 'linux', nodeVersion: '24.21.0', environment: {} });
  assert.equal(healthy.configSha256, createHash('sha256').update(await readFile(join(directory, workerSetupFiles.config))).digest('hex'));
  assert.equal(healthy.checks.find(check => check.id === 'license-trust').status, 'ok');
  assert.equal(healthy.checks.some(check => check.id === 'license-lease'), false);
  // A lease is checked only where a configuration names one; this fixture writes such a configuration by hand.
  const credentials = JSON.parse(await readFile(join(directory, workerSetupFiles.credentials), 'utf8'));
  const leasePath = join(directory, 'lease.json'), now = Math.floor(Date.now() / 1000), workerId = randomUUID(), organizationId = randomUUID();
  const lease = async (claims = {}) => JSON.stringify(await new SignJWT({ schemaVersion: 1, workerId, organizationId, installationId: identity.installationId, projectId,
    jkt: await calculateJwkThumbprint({ kty: 'EC', crv: 'P-256', x: credentials.privateJwk.x, y: credentials.privateJwk.y }), revision: 1, decision: 'allowed',
    entitlementExpiresAt: now + 7200, ...claims }).setProtectedHeader({ alg: 'ES256', kid: 'license-a', typ: 'keepseam-worker-license+jwt' })
    .setIssuer(origin).setAudience('keepseam-worker-automation').setIssuedAt(claims.iat ?? now).setExpirationTime(claims.exp ?? now + 3600).sign(key.privateKey));
  const config = JSON.parse(await readFile(join(directory, workerSetupFiles.config), 'utf8'));
  await rm(join(directory, workerSetupFiles.config));
  await writeFile(join(directory, workerSetupFiles.config), JSON.stringify({ ...config,
    license: { credentialsPath: join(directory, workerSetupFiles.credentials), trustPath: join(directory, workerSetupFiles.trust), leasePath } }), { mode: 0o600 });
  const code = async () => (await diagnoseWorker({ directory, platform: 'linux', nodeVersion: '24.21.0', environment: {} })).checks.find(check => check.id === 'license-lease')?.code;
  const valid = await lease();
  await writeFile(leasePath, valid, { mode: 0o600 });
  assert.equal(await code(), 'LEASE_SIGNATURE_VALID');
  const report = JSON.stringify(await diagnoseWorker({ directory, platform: 'linux', nodeVersion: '24.21.0', environment: {} }));
  for (const value of [workerId, organizationId, JSON.parse(valid), credentials.privateJwk.d, clientSecret]) assert.ok(!report.includes(value));
  await rm(leasePath); await writeFile(leasePath, await lease({ iat: now - 7200, exp: now - 3600 }), { mode: 0o600 });
  assert.equal(await code(), 'LEASE_EXPIRED');
  await rm(leasePath); await writeFile(leasePath, await lease({ decision: 'suspended', entitlementExpiresAt: null }), { mode: 0o600 });
  assert.equal(await code(), 'LEASE_SUSPENDED');
  await rm(leasePath); await writeFile(leasePath, JSON.stringify(JSON.parse(valid).replace(/.$/u, 'A')), { mode: 0o600 });
  assert.equal(await code(), 'LEASE_INVALID');
  // A trust whose issuer no longer matches the credentials fails the doctor.
  await rm(join(directory, workerSetupFiles.trust));
  await writeFile(join(directory, workerSetupFiles.trust), JSON.stringify({ ...document(key), issuer: 'https://keepseam.example' }), { mode: 0o600 });
  assert.equal((await diagnoseWorker({ directory, platform: 'linux', nodeVersion: '24.21.0', environment: {} })).checks.find(check => check.id === 'license-trust').code, 'TRUST_INVALID');
});

test('the command line takes one distinct kid=sha256 per key and reads the public trust from a local file', async t => {
  const { root, directory } = await enrolled(t);
  const key = await licenseKey('license-a'), trustFile = join(root, 'trust.json');
  await writeFile(trustFile, JSON.stringify(document(key)));
  const out = [], err = [], io = { stdout: text => out.push(text), stderr: text => err.push(text), platform: 'linux' };
  assert.equal(await runWorkerSetupCli(['setup', 'trust', '--dir', directory, '--trust', trustFile], io), 2);
  assert.equal(await runWorkerSetupCli(['setup', 'trust', '--dir', directory, '--trust', trustFile, '--key', 'license-a=abc'], io), 2);
  const good = `license-a=${fingerprint(key.publicJwk)}`;
  assert.equal(await runWorkerSetupCli(['setup', 'trust', '--dir', directory, '--trust', trustFile, '--key', good, '--key', good], io), 2);
  assert.match(err.pop(), /distinct kid=sha256/u);
  assert.equal(await runWorkerSetupCli(['setup', 'trust', '--dir', directory, '--trust', trustFile, '--key', good], io), 0);
  assert.equal(JSON.parse(out.pop()).keys[0].publicKeySha256, fingerprint(key.publicJwk));
});
