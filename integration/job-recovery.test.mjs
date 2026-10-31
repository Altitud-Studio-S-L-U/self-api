import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { before, test } from 'node:test';
import { inspectApproval } from '../dist/approval-store.js';
import { DOCKER_PROFILE } from '../dist/docker-runner.js';
import { approveJobValidation, listJobExecutions, prepareJobValidation, queueJobValidation,
  recoverApprovedJobs, runApprovedJobsOnce } from '../dist/job-validation.js';
import { readValidationOutcome } from '../dist/validation-outcome.js';
import { observeOnce, registerLocalSubscription } from '../dist/worker.js';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const fixtureRoot = join(root, 'fixtures/validation-consumer');
const recipe = JSON.parse(await readFile(join(root, 'fixtures/validation-recipe.json'), 'utf8'));
const enginePath = join(root, 'work/tools/oasdiff/oasdiff');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const dockerOptions = { shell: false, windowsHide: true, timeout: 5_000, maxBuffer: 128 * 1024, encoding: 'utf8' };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

before(async () => {
  assert.equal(process.platform, 'linux', 'Run these real recovery tests in the dedicated Linux Docker job.');
  await execute('docker', ['info', '--format', '{{.OSType}}'], dockerOptions);
  // CI provisions the pinned image explicitly; neither this suite nor the adapter pulls it.
  await execute('docker', ['image', 'inspect', DOCKER_PROFILE.image], dockerOptions);
});

async function directoryDigest(directory) {
  const digest = createHash('sha256');
  async function visit(current, prefix) {
    const entries = (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      const path = join(current, entry.name);
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await visit(path, `${name}/`);
      else {
        assert.ok(entry.isFile(), 'Controlled consumer fixtures contain regular files only.');
        digest.update(name).update('\0').update(await readFile(path)).update('\0');
      }
    }
  }
  await visit(directory, '');
  return digest.digest('hex');
}

async function optionalJson(path, allowIncomplete = false) {
  let text;
  try { text = await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try { return JSON.parse(text); }
  catch (error) { if (allowIncomplete && error instanceof SyntaxError) return null; throw error; }
}

async function inspectContainer(identity) {
  try {
    const { stdout } = await execute('docker', ['container', 'inspect', '--format', '{{json .}}', identity], dockerOptions);
    return JSON.parse(stdout);
  } catch (error) {
    if (error.code === 1 && /No such (?:object|container)/iu.test(error.stderr ?? '')) return null;
    throw error;
  }
}

function assertOwnedContainer(container, journal, intent, created) {
  assert.match(journal.owner, uuid);
  assert.equal(journal.containerName, `self-managed-api-validation-${journal.owner}`);
  assert.equal(journal.intentId, intent.id);
  assert.equal(journal.receiptId, intent.receiptId);
  assert.equal(journal.requestId, intent.requestId);
  assert.equal(container.Name, `/${journal.containerName}`);
  assert.match(container.Id, /^[a-f0-9]{64}$/u);
  if (created) assert.equal(container.Id, created.containerId);
  const prefix = DOCKER_PROFILE.journal.labelPrefix;
  const labels = container.Config.Labels;
  assert.equal(labels[DOCKER_PROFILE.ownershipLabel], journal.owner);
  assert.equal(labels[`${prefix}intent`], intent.id);
  assert.equal(labels[`${prefix}receipt`], intent.receiptId);
  assert.equal(labels[`${prefix}request`], intent.requestId);
  assert.equal(labels[`${prefix}journal`], hash(JSON.stringify(journal)));
  assert.equal(labels[`${prefix}phase`], journal.phase);
  assert.equal(labels[`${prefix}profile`], journal.profileSha256);
}

async function stopChild(child) {
  if (!child || child.exit !== null) return;
  assert.equal(child.process.kill('SIGKILL'), true);
  await Promise.race([child.finished, delay(5_000, undefined, { ref: false }).then(() => {
    assert.fail('The controlled worker did not exit after SIGKILL.');
  })]);
}

async function cleanupOwnedContainers(context) {
  if (!context.intent) return;
  const directory = join(context.input.statePath, 'attempts', context.intent.receiptId, DOCKER_PROFILE.journal.directory);
  for (const phase of ['baseline', 'candidate']) {
    const journal = await optionalJson(join(directory, `${phase}.intent.json`));
    if (!journal) continue;
    assert.equal(journal.phase, phase);
    const created = await optionalJson(join(directory, `${phase}.created.json`));
    const container = await inspectContainer(created?.containerId ?? journal.containerName);
    if (!container) continue;
    // The failure cleanup may remove only a container proven to belong to this fixture's receipt.
    assertOwnedContainer(container, journal, context.intent, created);
    await execute('docker', ['rm', '--force', '--volumes', container.Id], dockerOptions);
    assert.equal(await inspectContainer(container.Id), null);
  }
}

async function fixture(t, testPaths) {
  const parent = resolve(root, 'work/job-recovery-integration');
  await mkdir(parent, { recursive: true });
  const realParent = await realpath(parent);
  const directory = await mkdtemp(join(realParent, 'case-'));
  const context = { child: null, intent: null, input: { statePath: join(directory, 'state') } };
  t.after(async () => {
    await stopChild(context.child);
    await cleanupOwnedContainers(context);
    const target = await realpath(directory);
    assert.equal(dirname(target), realParent);
    assert.ok(basename(target).startsWith('case-'));
    await rm(target, { recursive: true, force: false });
  });
  const consumerRoot = join(directory, 'consumer');
  const sourcePath = join(directory, 'provider.json');
  await cp(fixtureRoot, consumerRoot, { recursive: true });
  await cp(join(root, 'fixtures/orders-v2.json'), sourcePath);
  const { statePath } = context.input;
  const subscription = await registerLocalSubscription({ statePath, sourcePath,
    baselinePath: join(root, 'fixtures/orders-v1.json'), consumerRoot,
    providerBaseUrl: 'https://orders.example.invalid', enginePath });
  const observed = await observeOnce({ statePath, enginePath, subscriptionId: subscription.id });
  assert.equal(observed.results[0].status, 'observed');
  const jobId = observed.results[0].jobId;
  assert.match(jobId, /^[a-f0-9]{64}$/u);
  context.input = { statePath, enginePath, jobId, recipe, testPaths };
  context.consumerRoot = consumerRoot;
  context.originalDigest = await directoryDigest(consumerRoot);
  const request = await prepareJobValidation(context.input);
  assert.equal(request.plan.authorization, 'not-granted');
  const receipt = await approveJobValidation({ ...context.input, expectedRequestId: request.id, origin: 'explicit-sdk-caller' });
  const queued = await queueJobValidation({ ...context.input, receiptId: receipt.id });
  assert.equal(queued.created, true);
  assert.equal(queued.intent.status, 'queued');
  context.intent = queued.intent;
  context.request = request;
  context.receipt = receipt;
  context.attemptPath = join(statePath, 'attempts', receipt.id);
  context.journalPath = join(context.attemptPath, DOCKER_PROFILE.journal.directory);
  context.receiptBytes = await readFile(join(statePath, 'receipts', `${receipt.id}.json`));
  return context;
}

function approvalBindings(context) {
  return { statePath: context.input.statePath, consumerRoot: context.consumerRoot, receiptId: context.receipt.id,
    planId: context.request.plan.id, executionDigest: context.request.executionDigest, policyDigest: context.request.policyDigest };
}

function startWorker(input) {
  const moduleUrl = new URL('../dist/job-validation.js', import.meta.url).href;
  const script = 'const { runApprovedJobsOnce } = await import(process.argv[1]); const result = await runApprovedJobsOnce(JSON.parse(process.argv[2])); process.stdout.write(JSON.stringify(result));';
  const processHandle = spawn(process.execPath, ['--input-type=module', '--eval', script, moduleUrl, JSON.stringify(input)], {
    cwd: root, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const child = { process: processHandle, exit: null, output: '', finished: null };
  for (const stream of [processHandle.stdout, processHandle.stderr]) {
    stream.on('data', bytes => { child.output = (child.output + bytes.toString('utf8')).slice(-16 * 1024); });
  }
  child.finished = new Promise(resolveExit => {
    processHandle.once('error', error => { child.exit = { error }; resolveExit(child.exit); });
    processHandle.once('exit', (code, signal) => { child.exit = { code, signal }; resolveExit(child.exit); });
  });
  return child;
}

async function waitForRunningBaseline(context) {
  const deadline = performance.now() + 25_000;
  while (performance.now() < deadline) {
    assert.equal(context.child.exit, null, `Worker exited before the controlled interruption: ${context.child.output}`);
    // Journal files can be observed between exclusive creation and fsync; only complete records count.
    const journal = await optionalJson(join(context.journalPath, 'baseline.intent.json'), true);
    const created = await optionalJson(join(context.journalPath, 'baseline.created.json'), true);
    if (journal && created) {
      const container = await inspectContainer(created.containerId);
      if (container) {
        assertOwnedContainer(container, journal, context.intent, created);
        if (container.State.Running === true) return { journal, created, container };
      }
    }
    // Bounded observation polling, not a delay used to make an assertion eventually pass.
    await delay(Math.min(100, Math.max(1, deadline - performance.now())));
  }
  assert.fail(`Baseline did not reach a running container within its observation deadline: ${context.child.output}`);
}

function expireExecution(context) {
  const database = new DatabaseSync(join(context.input.statePath, 'worker.sqlite3'));
  try {
    const before = database.prepare('SELECT status,receipt_id,generation FROM execution_intents WHERE id=?').get(context.intent.id);
    assert.equal(before.status, 'running');
    assert.equal(before.receipt_id, context.receipt.id);
    const changed = database.prepare("UPDATE execution_intents SET expires_at=? WHERE id=? AND status='running'")
      .run(Date.now() - 1, context.intent.id);
    assert.equal(changed.changes, 1);
    return before.generation;
  } finally { database.close(); }
}

test('an approved worker job validates the candidate and persists evidence without changing its consumer', { timeout: 120_000 }, async t => {
  const context = await fixture(t, ['orders.test.mjs']);
  const cycle = await runApprovedJobsOnce({ statePath: context.input.statePath, enginePath, intentId: context.intent.id });
  assert.equal(cycle.results.length, 1);
  assert.equal(cycle.results[0].status, 'completed', JSON.stringify(cycle));
  const outcome = cycle.results[0].outcome;
  assert.equal(outcome.status, 'improved');
  assert.equal(outcome.baseline.status, 'failed');
  assert.equal(outcome.candidate.status, 'passed');
  assert.equal(outcome.consumerModified, false);
  assert.equal(outcome.publication, 'not-authorized');
  assert.equal(await directoryDigest(context.consumerRoot), context.originalDigest);
  assert.deepEqual(await readValidationOutcome({ attemptPath: context.attemptPath, intentId: context.intent.id,
    requestId: context.request.id, receiptId: context.receipt.id }), outcome);
  const full = JSON.parse(await readFile(join(context.attemptPath, 'result.json'), 'utf8'));
  assert.equal(full.status, 'improved');
  for (const phase of ['baseline', 'candidate']) {
    const journal = await optionalJson(join(context.journalPath, `${phase}.intent.json`));
    const created = await optionalJson(join(context.journalPath, `${phase}.created.json`));
    const cleaned = await optionalJson(join(context.journalPath, `${phase}.cleanup.json`));
    assert.equal(journal.intentId, context.intent.id);
    assert.equal(journal.receiptId, context.receipt.id);
    assert.equal(journal.requestId, context.request.id);
    assert.equal(created.intentSha256, hash(JSON.stringify(journal)));
    assert.equal(cleaned.intentSha256, created.intentSha256);
    assert.equal(cleaned.containerId, created.containerId);
    assert.equal(outcome[phase].cleanup, 'removed');
    assert.equal(outcome[phase].containerName, journal.containerName);
    assert.equal(await inspectContainer(created.containerId), null);
    assert.equal(await inspectContainer(journal.containerName), null);
  }
  const stored = (await listJobExecutions({ statePath: context.input.statePath }))[0];
  assert.equal(stored.status, 'completed');
  assert.deepEqual(stored.outcome, outcome);
  assert.deepEqual((await runApprovedJobsOnce({ statePath: context.input.statePath, enginePath })).results, []);
  assert.deepEqual((await recoverApprovedJobs({ statePath: context.input.statePath })).results, []);
  await assert.rejects(inspectApproval(approvalBindings(context)), /already has an execution attempt/);
});

test('a killed worker is recovered by removing its exact live container without repeating approved work', { timeout: 120_000 }, async t => {
  const context = await fixture(t, ['timeout.test.mjs']);
  context.child = startWorker({ statePath: context.input.statePath, enginePath, intentId: context.intent.id });
  const { journal, created, container } = await waitForRunningBaseline(context);
  const baselineRecord = await readFile(join(context.journalPath, 'baseline.created.json'));
  await stopChild(context.child);
  assert.equal(context.child.exit.signal, 'SIGKILL');
  assert.equal((await inspectContainer(container.Id)).State.Running, true, 'The controlled crash must leave a live container to recover.');
  assert.equal(await optionalJson(join(context.attemptPath, 'outcome.json')), null);
  assert.equal(await optionalJson(join(context.journalPath, 'candidate.intent.json')), null);
  const generation = expireExecution(context);
  const recovery = await recoverApprovedJobs({ statePath: context.input.statePath });
  assert.deepEqual(recovery.results, [{ intentId: context.intent.id, status: 'interrupted', reason: 'execution-interrupted' }]);
  assert.equal(await inspectContainer(container.Id), null);
  assert.equal(await inspectContainer(journal.containerName), null);
  const cleaned = await optionalJson(join(context.journalPath, 'baseline.cleanup.json'));
  assert.equal(cleaned.containerId, created.containerId);
  assert.equal(cleaned.intentSha256, created.intentSha256);
  assert.deepEqual(await readFile(join(context.journalPath, 'baseline.created.json')), baselineRecord);
  const stored = (await listJobExecutions({ statePath: context.input.statePath }))[0];
  assert.equal(stored.status, 'interrupted');
  assert.equal(stored.reason, 'execution-interrupted');
  assert.equal(stored.generation, generation + 1);
  assert.equal(stored.outcome, null);
  assert.equal(stored.owner, null);
  assert.deepEqual((await runApprovedJobsOnce({ statePath: context.input.statePath, enginePath })).results, []);
  assert.deepEqual((await recoverApprovedJobs({ statePath: context.input.statePath })).results, []);
  await assert.rejects(queueJobValidation({ ...context.input, receiptId: context.receipt.id }), /already has an execution attempt/);
  await assert.rejects(inspectApproval(approvalBindings(context)), /already has an execution attempt/);
  assert.deepEqual(await readFile(join(context.input.statePath, 'receipts', `${context.receipt.id}.json`)), context.receiptBytes);
  assert.deepEqual(await readdir(join(context.input.statePath, 'attempts')), [context.receipt.id]);
  assert.equal(await optionalJson(join(context.journalPath, 'candidate.intent.json')), null);
  assert.equal(await optionalJson(join(context.attemptPath, 'result.json')), null);
  assert.equal(await optionalJson(join(context.attemptPath, 'outcome.json')), null);
  assert.equal(await directoryDigest(context.consumerRoot), context.originalDigest);
});
