import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportJWK, generateKeyPair } from 'jose';
import { completeWorkerSetup, diagnoseWorker, enableWorkerLicense, initWorkerSetup, installWorkerLicenseTrust, normalizeWorkerServiceConfig,
  runWorkerSetupCli, workerSetupFiles } from '../dist/index.js';

const posix = process.platform !== 'win32', origin = 'https://keepseam.com';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const leftover = `${workerSetupFiles.config}.0f8b2c1e-6d4a-4c3b-9a2e-1b2c3d4e5f60.tmp`;
async function ready(t, { trust = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'keepseam-config-'));
  if (posix) await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'worker'), identity = await initWorkerSetup({ directory });
  await completeWorkerSetup({ directory, intervalMs: 5000, enrollment: { baseUrl: origin, installationId: identity.installationId, projectId: 'b'.repeat(64), clientSecret: 'c'.repeat(64) } });
  if (trust) {
    const { kty, crv, x, y } = await exportJWK((await generateKeyPair('ES256', { extractable: true })).publicKey);
    const key = { kty, crv, kid: 'license-a', x, y };
    await installWorkerLicenseTrust({ directory, trust: { schemaVersion: 1, issuer: origin, keys: [key] },
      expected: { 'license-a': createHash('sha256').update(JSON.stringify({ crv, kty, x, y })).digest('hex') } });
  }
  const configPath = join(directory, workerSetupFiles.config);
  return { directory, configPath, previousPath: join(directory, workerSetupFiles.previous), original: await readFile(configPath) };
}

test('the license section is added to the named revision, keeping every other option and the exact replaced bytes', async t => {
  const { directory, configPath, previousPath, original } = await ready(t);
  const result = await enableWorkerLicense({ directory, expectedSha256: sha(original) });
  assert.equal(result.changed, true);
  const updated = await readFile(configPath);
  assert.equal(result.configSha256, sha(updated));
  assert.deepEqual(await readFile(previousPath), original);
  const before = normalizeWorkerServiceConfig(JSON.parse(original)), after = normalizeWorkerServiceConfig(JSON.parse(updated));
  assert.deepEqual({ ...after, license: undefined }, { ...before, license: undefined });
  assert.equal(after.sources.intervalMs, 5000);
  assert.deepEqual(after.license, { credentialsPath: join(directory, workerSetupFiles.credentials), trustPath: join(directory, workerSetupFiles.trust) });
  assert.equal('leasePath' in after.license, false);
  assert.equal((await readdir(directory)).some(name => name.endsWith('.tmp')), false);
  const report = await diagnoseWorker({ directory, platform: 'linux', nodeVersion: '24.21.0', environment: {} });
  assert.equal(report.configSha256, result.configSha256); assert.equal(report.checks.find(check => check.id === 'license-trust').status, 'ok');
  // Repeating it on the new revision is a defined no-op.
  const again = await enableWorkerLicense({ directory, expectedSha256: result.configSha256 });
  assert.deepEqual([again.changed, again.configSha256], [false, result.configSha256]);
  assert.deepEqual(await readFile(previousPath), original);
});

test('a stale hash, a different previous revision or a different license section change nothing', async t => {
  const { directory, configPath, previousPath, original } = await ready(t);
  await assert.rejects(enableWorkerLicense({ directory, expectedSha256: 'f'.repeat(64) }), /EXPECT_MISMATCH/u);
  await assert.rejects(enableWorkerLicense({ directory, expectedSha256: 'not-a-hash' }), /config-sha256/u);
  assert.deepEqual(await readFile(configPath), original); assert.equal(existsSync(previousPath), false);
  await writeFile(previousPath, '{"schemaVersion":1}\n', { mode: 0o600 });
  await assert.rejects(enableWorkerLicense({ directory, expectedSha256: sha(original) }), /PREVIOUS_CONFLICT/u);
  assert.deepEqual(await readFile(configPath), original); assert.equal(await readFile(previousPath, 'utf8'), '{"schemaVersion":1}\n');
  await rm(previousPath);
  const config = JSON.parse(original);
  const foreign = Buffer.from(JSON.stringify({ ...config, license: { credentialsPath: join(directory, workerSetupFiles.credentials), trustPath: join(directory, 'other-trust.json') } }));
  await rm(configPath); await writeFile(configPath, foreign, { mode: 0o600 });
  await assert.rejects(enableWorkerLicense({ directory, expectedSha256: sha(foreign) }), /LICENSE_CONFLICT/u);
  assert.deepEqual(await readFile(configPath), foreign); assert.equal(existsSync(previousPath), false);
});

test('without installed trust nothing is changed', async t => {
  const { directory, configPath, previousPath, original } = await ready(t, { trust: false });
  await assert.rejects(enableWorkerLicense({ directory, expectedSha256: sha(original) }), /setup trust first/u);
  assert.deepEqual(await readFile(configPath), original); assert.equal(existsSync(previousPath), false);
});

test('a second cooperating writer with the same hash fails and the first revision stands', async t => {
  const { directory, configPath, previousPath, original } = await ready(t);
  const results = await Promise.allSettled([1, 2].map(() => enableWorkerLicense({ directory, expectedSha256: sha(original) })));
  assert.equal(results.filter(result => result.status === 'fulfilled' && result.value.changed).length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.match(String(results.find(result => result.status === 'rejected').reason.message), /setup\.lock|EXPECT_MISMATCH/u);
  assert.ok(normalizeWorkerServiceConfig(JSON.parse(await readFile(configPath))).license);
  assert.deepEqual(await readFile(previousPath), original);
});

test('a run interrupted after the backup or after staging is completed by a re-run, and the orphaned stage is kept', async t => {
  const { directory, configPath, previousPath, original } = await ready(t);
  // Interrupted after the backup: the previous revision equals the current one, so the re-run accepts it.
  await writeFile(previousPath, original, { mode: 0o600 });
  // Interrupted after staging: a staged configuration is left next to an unchanged worker.json.
  await writeFile(join(directory, leftover), 'staged by an interrupted run\n', { mode: 0o600 });
  const result = await enableWorkerLicense({ directory, expectedSha256: sha(original) });
  assert.equal(result.changed, true); assert.deepEqual(await readFile(previousPath), original);
  assert.equal(existsSync(join(directory, leftover)), true);
  const report = await diagnoseWorker({ directory, platform: 'linux', nodeVersion: '24.21.0', environment: {} });
  assert.equal(report.checks.find(check => check.id === 'temporary-only-copies').code, 'TEMPORARY_ONLY_COPY');
  assert.equal(sha(await readFile(configPath)), result.configSha256);
});

test('the command line requires the explicit license change and the expected hash', async t => {
  const { directory, original } = await ready(t);
  const out = [], err = [], io = { stdout: text => out.push(text), stderr: text => err.push(text), platform: 'linux' };
  assert.equal(await runWorkerSetupCli(['setup', 'config', '--dir', directory, '--expect', sha(original)], io), 2);
  assert.equal(await runWorkerSetupCli(['setup', 'config', '--dir', directory, '--license'], io), 2);
  assert.equal(await runWorkerSetupCli(['setup', 'config', '--dir', directory, '--license', '--expect', sha(original)], io), 0);
  assert.equal(JSON.parse(out.pop()).changed, true); assert.match(err.pop(), /next service start/u);
});
