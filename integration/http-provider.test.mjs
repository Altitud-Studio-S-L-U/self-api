import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { before, test } from 'node:test';
import { promisify } from 'node:util';
import { DOCKER_PROFILE, runDockerValidation } from '../dist/docker-runner.js';

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const commandOptions = { shell: false, windowsHide: true, timeout: 15000, maxBuffer: 128 * 1024, encoding: 'utf8',
  env: { ...DOCKER_PROFILE.environment } };
const openssl = '/usr/bin/openssl';
const docker = args => execute(DOCKER_PROFILE.executable, ['--host', DOCKER_PROFILE.endpoint, ...args], commandOptions);

before(async () => {
  assert.equal(process.platform, 'linux', 'Run real HTTPS capture in the dedicated Linux Docker job.');
  assert.equal((await docker(['info', '--format', '{{.OSType}}'])).stdout.trim(), 'linux');
  // CI explicitly provisions the pinned image. This suite never pulls images or installs prerequisites.
  await docker(['image', 'inspect', DOCKER_PROFILE.image]);
  assert.match((await execute(openssl, ['version'], commandOptions)).stdout, /^OpenSSL /u);
});

async function filesDigest(directory) {
  const digest = createHash('sha256');
  for (const name of (await readdir(directory)).sort()) digest.update(name).update('\0').update(await readFile(join(directory, name))).update('\0');
  return digest.digest('hex');
}

test('isolated real HTTPS capture covers conditional polling, TLS failures, bounded bodies and cancellation', { timeout: 60000 }, async t => {
  const parent = resolve(root, 'work', 'http-provider-integration');
  await mkdir(parent, { recursive: true });
  const realParent = await realpath(parent);
  const directory = await mkdtemp(join(realParent, 'case-'));
  t.after(async () => {
    const target = await realpath(directory);
    assert.equal(dirname(target), realParent);
    assert.ok(basename(target).startsWith('case-'));
    await rm(target, { recursive: true, force: false });
  });
  const snapshotPath = join(directory, 'snapshot');
  const statePath = join(directory, 'state');
  await mkdir(snapshotPath, { mode: 0o755 });
  await mkdir(statePath, { mode: 0o700 });
  await copyFile(join(root, 'fixtures/http-provider/capture.test.mjs'), join(snapshotPath, 'capture.test.mjs'));
  for (const file of ['http-source.js', 'public-network.js', 'errors.js']) await copyFile(join(root, 'dist', file), join(snapshotPath, file));
  await writeFile(join(snapshotPath, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  // This one-day key is ephemeral fixture data, readable only within the controlled snapshot and never committed.
  await execute(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1',
    '-subj', '/CN=payments.plumber.test', '-addext', 'subjectAltName=DNS:payments.plumber.test',
    '-keyout', join(snapshotPath, 'server.key'), '-out', join(snapshotPath, 'server.crt')], commandOptions);
  await chmod(snapshotPath, 0o755);
  for (const name of await readdir(snapshotPath)) await chmod(join(snapshotPath, name), 0o644);
  const beforeDigest = await filesDigest(snapshotPath);
  const result = await runDockerValidation({ snapshotPath, statePath, testPaths: ['capture.test.mjs'] });
  assert.equal(result.cleanup, 'removed', `${result.status}: ${result.reason ?? result.stderr}`);
  assert.match(result.containerName, /^self-managed-api-validation-[a-f0-9-]+$/u);
  await assert.rejects(docker(['container', 'inspect', result.containerName]), error => error.code === 1 && /No such (?:object|container)/iu.test(error.stderr));
  assert.equal(await filesDigest(snapshotPath), beforeDigest, 'HTTPS tests modified the captured fixture or its test certificate.');
  assert.equal(result.status, 'passed', `${result.stdout}\n${result.stderr}`);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /# tests 7\b/u);
  assert.match(result.stdout, /# pass 7\b/u);
  assert.match(result.stdout, /# fail 0\b/u);
});
