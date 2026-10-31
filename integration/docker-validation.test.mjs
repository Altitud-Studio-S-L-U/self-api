import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { before, test } from 'node:test';
import { DOCKER_PROFILE, runDockerValidation } from '../dist/docker-runner.js';
import { previewRecipe } from '../dist/migration-recipe.js';
import { approveMigrationValidation, executeMigrationValidation, prepareMigrationValidation } from '../dist/migration-validation.js';

const execute = promisify(execFile);
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const fixtureRoot = join(projectRoot, 'fixtures', 'validation-consumer');
const recipe = JSON.parse(await readFile(new URL('../fixtures/validation-recipe.json', import.meta.url), 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
const dockerOptions = { shell: false, windowsHide: true, timeout: 15_000, maxBuffer: 128 * 1024, encoding: 'utf8' };

before(async () => {
  assert.equal(process.platform, 'linux', 'Run this integration suite in the dedicated Linux Docker job.');
  await execute('docker', ['info', '--format', '{{.OSType}}'], dockerOptions);
  // The CI setup must pull this exact image explicitly. The tests and adapter never pull it.
  await execute('docker', ['image', 'inspect', DOCKER_PROFILE.image], dockerOptions);
});

async function directoryDigest(directory) {
  const digest = createHash('sha256');
  async function visit(current, prefix) {
    const entries = (await readdir(current, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const path = join(current, entry.name);
      const relative = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await visit(path, `${relative}/`);
      else {
        assert.ok(entry.isFile(), 'The controlled fixture must contain regular files only.');
        digest.update(relative).update('\0').update(await readFile(path)).update('\0');
      }
    }
  }
  await visit(directory, '');
  return digest.digest('hex');
}

async function makeCase(t) {
  const parent = resolve(projectRoot, 'work', 'docker-integration');
  await mkdir(parent, { recursive: true });
  const realParent = await realpath(parent);
  const directory = await mkdtemp(join(realParent, 'case-'));
  t.after(async () => {
    const target = await realpath(directory);
    assert.equal(dirname(target), realParent);
    assert.ok(basename(target).startsWith('case-'));
    await rm(target, { recursive: true, force: false });
  });
  const snapshotPath = join(directory, 'consumer');
  const statePath = join(directory, 'state');
  await cp(fixtureRoot, snapshotPath, { recursive: true });
  await mkdir(statePath, { mode: 0o700 });
  return { snapshotPath, statePath };
}

async function assertRemoved(result) {
  assert.equal(result.cleanup, 'removed', `${result.status}: ${result.reason ?? result.stderr}`);
  assert.match(result.containerName, /^self-managed-api-validation-[a-f0-9-]+$/u);
  await assert.rejects(execute('docker', ['container', 'inspect', result.containerName], dockerOptions), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /No such (?:object|container)/iu);
    return true;
  });
}

async function validate(context, testPaths) {
  const original = await directoryDigest(context.snapshotPath);
  const fixtureBefore = await directoryDigest(fixtureRoot);
  const result = await runDockerValidation({ ...context, testPaths });
  assert.equal(await directoryDigest(context.snapshotPath), original, 'Validation changed its input snapshot.');
  assert.equal(await directoryDigest(fixtureRoot), fixtureBefore, 'Validation changed the original fixture.');
  await assertRemoved(result);
  return result;
}

test('real Docker proves original A success, original B failure, and candidate B success', { timeout: 90_000 }, async t => {
  const original = await makeCase(t);
  const baselineA = await validate(original, ['orders-v1.test.mjs']);
  assert.equal(baselineA.status, 'passed', baselineA.stderr);
  assert.equal(baselineA.exitCode, 0);
  const baselineB = await validate(original, ['orders.test.mjs']);
  assert.equal(baselineB.status, 'failed', baselineB.stderr);
  assert.notEqual(baselineB.exitCode, 0);
  assert.match(baselineB.stdout, /not ok.*existing region/su);
  assert.match(baselineB.stdout, /not ok.*parser preserves/su);

  const candidate = await makeCase(t);
  const text = await readFile(join(candidate.snapshotPath, 'orders.mjs'), 'utf8');
  const preview = previewRecipe(recipe, [{ path: 'orders.mjs', text, sha256: hash(text) }]);
  assert.equal(preview.status, 'ready-for-review');
  for (const file of preview.files) await writeFile(join(candidate.snapshotPath, file.path), file.after);
  const candidateB = await validate(candidate, ['orders.test.mjs']);
  assert.equal(candidateB.status, 'passed', candidateB.stderr);
  assert.equal(candidateB.exitCode, 0);
});

test('the real container enforces filesystem, network, identity, and host-secret isolation', { timeout: 60_000 }, async t => {
  const context = await makeCase(t);
  const previous = process.env.PLUMBER_HOST_SECRET;
  const sentinel = 'controlled-host-secret-must-not-enter-the-container';
  process.env.PLUMBER_HOST_SECRET = sentinel;
  t.after(() => {
    if (previous === undefined) delete process.env.PLUMBER_HOST_SECRET;
    else process.env.PLUMBER_HOST_SECRET = previous;
  });
  const result = await validate(context, ['isolation.test.mjs']);
  assert.equal(result.status, 'passed', `${result.stdout}\n${result.stderr}`);
  assert.equal(result.exitCode, 0);
  assert.ok(!result.stdout.includes(sentinel) && !result.stderr.includes(sentinel));
});

test('excess output is bounded and the container is removed', { timeout: 60_000 }, async t => {
  const result = await validate(await makeCase(t), ['output-limit.test.mjs']);
  assert.equal(result.status, 'output-limit');
  assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= DOCKER_PROFILE.maxOutputBytes);
});

test('stalled tests reach the fixed time budget and leave no running container', { timeout: 90_000 }, async t => {
  const context = await makeCase(t);
  const started = performance.now();
  const result = await validate(context, ['timeout.test.mjs']);
  const elapsed = performance.now() - started;
  assert.equal(result.status, 'timed-out');
  assert.ok(elapsed >= DOCKER_PROFILE.timeoutMs * 0.9, 'The workload stopped before the declared timeout.');
  assert.ok(elapsed < DOCKER_PROFILE.timeoutMs + 45_000, 'Validation did not finish within its timeout and cleanup allowance.');
});

test('an explicitly approved migration works with umask 077 without mutating or publishing the consumer', { timeout: 90_000 }, async t => {
  const context = await makeCase(t);
  const previousMask = process.umask(0o077);
  t.after(() => { process.umask(previousMask); });
  const beforeDigest = await directoryDigest(context.snapshotPath);
  const options = {
    consumerRoot: context.snapshotPath,
    providerBaseUrl: 'https://orders.example.invalid',
    basePath: join(projectRoot, 'fixtures', 'orders-v1.json'),
    revisionPath: join(projectRoot, 'fixtures', 'orders-v2.json'),
    enginePath: join(projectRoot, 'work', 'tools', 'oasdiff', 'oasdiff'),
    recipe,
    testPaths: ['orders.test.mjs'],
  };
  const request = await prepareMigrationValidation(options);
  assert.equal(request.plan.authorization, 'not-granted');
  const receipt = await approveMigrationValidation({
    options,
    expectedRequestId: request.id,
    statePath: context.statePath,
    origin: 'explicit-sdk-caller',
  });
  const result = await executeMigrationValidation({ options, statePath: context.statePath, receiptId: receipt.id });
  assert.equal(result.status, 'improved');
  assert.equal(result.baseline.status, 'failed');
  assert.equal(result.candidate?.status, 'passed');
  assert.equal(result.consumerModified, false);
  assert.equal(result.publication, 'not-authorized');
  assert.equal(await directoryDigest(context.snapshotPath), beforeDigest);
  await assertRemoved(result.baseline);
  await assertRemoved(result.candidate);
  await assert.rejects(executeMigrationValidation({ options, statePath: context.statePath, receiptId: receipt.id }), {
    code: 'INVALID_INPUT',
    message: 'This approval already has an execution attempt.',
  });
});
