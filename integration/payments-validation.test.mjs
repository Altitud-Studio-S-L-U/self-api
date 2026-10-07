import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { before, test } from 'node:test';
import { DOCKER_PROFILE, runDockerValidation } from '../dist/docker-runner.js';
import { registerLocalSubscription, observeOnce, prepareJobValidation, approveJobValidation,
  queueJobValidation, runApprovedJobsOnce, listJobExecutions } from '../dist/index.js';

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const fixtureRoot = join(root, 'fixtures/payments');
const enginePath = join(root, 'work/tools/oasdiff/oasdiff');
const dockerOptions = { shell: false, windowsHide: true, timeout: 15_000, maxBuffer: 128 * 1024, encoding: 'utf8' };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

before(async () => {
  assert.equal(process.platform, 'linux', 'Run payment migration integration in the dedicated Linux Docker job.');
  await execute('docker', ['info', '--format', '{{.OSType}}'], dockerOptions);
  await execute('docker', ['image', 'inspect', DOCKER_PROFILE.image], dockerOptions);
});

async function fixture(t) {
  const work = join(root, 'work/payments-integration');
  await mkdir(work, { recursive: true });
  const parent = await realpath(work), directory = await mkdtemp(join(parent, 'payments-'));
  t.after(async () => {
    const actual = await realpath(directory);
    assert.equal(dirname(actual), parent);
    assert.ok(basename(actual).startsWith('payments-'));
    await rm(actual, { recursive: true, force: false });
  });
  const consumerRoot = join(directory, 'consumer'), statePath = join(directory, 'state');
  await cp(join(fixtureRoot, 'consumer'), consumerRoot, { recursive: true });
  await mkdir(statePath, { mode: 0o700 });
  const recipe = JSON.parse(await readFile(join(fixtureRoot, 'payment-recipe.json'), 'utf8'));
  return { directory, consumerRoot, statePath, recipe };
}

async function sourceDigests(directory) {
  const names = (await readdir(directory)).sort();
  return Object.fromEntries(await Promise.all(names.map(async name => [name, hash(await readFile(join(directory, name)))])));
}

async function assertRemoved(result) {
  assert.equal(result.cleanup, 'removed', result.stderr);
  assert.match(result.containerName, /^plumber-validation-[a-f0-9-]+$/u);
  await assert.rejects(execute('docker', ['container', 'inspect', result.containerName], dockerOptions), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /No such (?:object|container)/iu);
    return true;
  });
}

test('a real payments server proves A success and an approved worker migration repairs B without changing its tests', { timeout: 150_000 }, async t => {
  const context = await fixture(t);
  const original = await sourceDigests(context.consumerRoot);
  const versionA = await runDockerValidation({ snapshotPath: context.consumerRoot, statePath: context.statePath,
    testPaths: ['payments-v1.test.mjs'] });
  assert.equal(versionA.status, 'passed', `${versionA.stdout}\n${versionA.stderr}`);
  assert.equal(versionA.exitCode, 0);
  assert.match(versionA.stdout, /# tests 3\b/u);
  assert.match(versionA.stdout, /# fail 0\b/u);
  await assertRemoved(versionA);

  const subscription = await registerLocalSubscription({ statePath: context.statePath, consumerRoot: context.consumerRoot,
    sourcePath: join(fixtureRoot, 'payments-v2.json'), baselinePath: join(fixtureRoot, 'payments-v1.json'),
    providerBaseUrl: 'http://127.0.0.1:43127', enginePath });
  const observed = await observeOnce({ statePath: context.statePath, enginePath, subscriptionId: subscription.id });
  const jobId = observed.results[0].jobId;
  assert.match(jobId, /^[a-f0-9]{64}$/u);
  const again = await observeOnce({ statePath: context.statePath, enginePath, subscriptionId: subscription.id });
  assert.equal(again.results[0].created, false);
  assert.equal(again.results[0].jobId, jobId);
  const input = { statePath: context.statePath, enginePath, jobId, recipe: context.recipe, testPaths: ['payments-v2.test.mjs'] };
  const request = await prepareJobValidation(input);
  assert.equal(request.plan.authorization, 'not-granted');
  assert.equal(request.plan.impact.comparison.status, 'breaking-changes');
  const affectedCalls = new Set(request.plan.impact.matches.flatMap(match => match.callIds));
  assert.ok(request.plan.impact.inventory.calls.some(call => call.location.file === 'payments.mjs' && affectedCalls.has(call.id)),
    'The actual consumer payment call, not just a test control, must be associated with changed operations.');
  assert.deepEqual(request.plan.files.map(file => file.path), ['payments.mjs']);
  assert.deepEqual(request.spec.testPaths, ['payments-v2.test.mjs']);
  assert.ok(request.spec.profile.isolationArgs.includes('--network=none'));

  const receipt = await approveJobValidation({ ...input, expectedRequestId: request.id, origin: 'explicit-sdk-caller' });
  const queued = await queueJobValidation({ ...input, receiptId: receipt.id });
  const cycle = await runApprovedJobsOnce({ statePath: context.statePath, enginePath, intentId: queued.intent.id });
  assert.equal(cycle.results[0].status, 'completed', JSON.stringify(cycle));
  const outcome = cycle.results[0].outcome;
  assert.equal(outcome.intentId, queued.intent.id);
  assert.equal(outcome.requestId, request.id);
  assert.equal(outcome.receiptId, receipt.id);
  assert.equal(outcome.status, 'improved');
  assert.equal(outcome.baseline.status, 'failed');
  assert.equal(outcome.candidate.status, 'passed');
  assert.equal(outcome.consumerModified, false);
  assert.equal(outcome.publication, 'not-authorized');
  const attempt = join(context.statePath, 'attempts', receipt.id);
  const result = JSON.parse(await readFile(join(attempt, 'result.json'), 'utf8'));
  assert.equal(result.requestId, request.id);
  assert.equal(result.receiptId, receipt.id);
  assert.equal(result.baseline.exitCode, 1);
  assert.match(result.baseline.stdout, /not ok \d+ - the migrated request/u);
  assert.match(result.baseline.stdout, /not ok \d+ - the parser independently/u);
  assert.doesNotMatch(result.baseline.stdout, /EADDRINUSE|testTimeoutFailure/u);
  assert.equal(result.candidate.exitCode, 0);
  assert.match(result.candidate.stdout, /# tests 25\b/u);
  assert.match(result.candidate.stdout, /# pass 25\b/u);
  assert.match(result.candidate.stdout, /# fail 0\b/u);
  await assertRemoved(result.baseline);
  await assertRemoved(result.candidate);

  assert.deepEqual(await sourceDigests(join(attempt, 'baseline')), original);
  assert.deepEqual(await sourceDigests(join(attempt, 'candidate')), {
    ...original, 'payments.mjs': request.plan.files[0].afterSha256,
  });
  assert.deepEqual(await sourceDigests(context.consumerRoot), original);
  const stored = (await listJobExecutions({ statePath: context.statePath }))[0];
  assert.equal(stored.status, 'completed');
  assert.deepEqual(stored.outcome, outcome);
  assert.deepEqual((await runApprovedJobsOnce({ statePath: context.statePath, enginePath })).results, []);
  await assert.rejects(queueJobValidation({ ...input, receiptId: receipt.id }), { code: 'INVALID_INPUT' });
});
