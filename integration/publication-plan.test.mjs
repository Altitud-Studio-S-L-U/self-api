import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { before, test } from 'node:test';
import { inspectApproval } from '../dist/approval-store.js';
import { DOCKER_PROFILE } from '../dist/docker-runner.js';
import { approveJobValidation, listJobExecutions, prepareJobValidation, queueJobValidation, runApprovedJobsOnce } from '../dist/job-validation.js';
import { prepareJobPublicationCandidate } from '../dist/publication-plan.js';
import { readValidationOutcome } from '../dist/validation-outcome.js';
import { observeOnce, registerLocalSubscription } from '../dist/worker.js';

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const enginePath = join(root, 'work/tools/oasdiff/oasdiff');
const hash = value => createHash('sha256').update(value).digest('hex');
const commandOptions = { shell: false, windowsHide: true, timeout: 15_000, maxBuffer: 128 * 1024, encoding: 'utf8' };
let gitPath;

async function docker(args) {
  return execute(DOCKER_PROFILE.executable, ['--host', DOCKER_PROFILE.endpoint, ...args], commandOptions);
}

before(async () => {
  assert.equal(process.platform, 'linux', 'Run this real publication integration test in the dedicated Linux Docker job.');
  gitPath = await realpath('/usr/bin/git');
  assert.equal((await docker(['info', '--format', '{{.OSType}}'])).stdout.trim(), 'linux');
  // CI explicitly provisions the pinned image. This test never pulls an image or substitutes a fake runtime.
  await docker(['image', 'inspect', DOCKER_PROFILE.image]);
});

async function git(consumerRoot, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Controlled publication integration fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Controlled publication integration fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  });
  const result = await execute(gitPath, ['-c', 'core.autocrlf=false', '-c', 'commit.gpgSign=false',
    '-c', 'core.hooksPath=', '-C', consumerRoot, ...args], { ...commandOptions, env });
  return result.stdout.trim();
}

async function treeContents(directory) {
  const result = {};
  async function visit(current, prefix) {
    const entries = (await readdir(current, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const path = join(current, entry.name);
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await visit(path, `${name}/`);
      else {
        assert.ok(entry.isFile(), 'The controlled Git fixture contains regular files only.');
        result[name] = { sha256: hash(await readFile(path)), mode: (await lstat(path)).mode };
      }
    }
  }
  await visit(directory, '');
  return result;
}

async function optionalJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function inspectContainer(identity) {
  try { return JSON.parse((await docker(['container', 'inspect', '--format', '{{json .}}', identity])).stdout); }
  catch (error) {
    if (error.code === 1 && /No such (?:object|container)/iu.test(error.stderr ?? '')) return null;
    throw error;
  }
}

async function cleanupOwnedContainers(context) {
  if (!context.intent) return;
  const attemptPath = join(context.statePath, 'attempts', context.intent.receiptId);
  for (const phase of ['baseline', 'candidate']) {
    const journalPath = join(attemptPath, DOCKER_PROFILE.journal.directory);
    const journal = await optionalJson(join(journalPath, `${phase}.intent.json`));
    if (!journal) continue;
    const created = await optionalJson(join(journalPath, `${phase}.created.json`));
    const container = await inspectContainer(created?.containerId ?? journal.containerName);
    if (!container) continue;
    // Failure cleanup removes only a container whose receipt, request, journal and source mount belong to this fixture.
    assert.match(journal.owner, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
    assert.equal(journal.containerName, `plumber-validation-${journal.owner}`);
    assert.equal(container.Name, `/${journal.containerName}`);
    assert.match(container.Id, /^[a-f0-9]{64}$/u);
    if (created) assert.equal(container.Id, created.containerId);
    assert.equal(journal.intentId, context.intent.id);
    assert.equal(journal.receiptId, context.intent.receiptId);
    assert.equal(journal.requestId, context.intent.requestId);
    assert.equal(journal.phase, phase);
    assert.equal(container.Config.Image, DOCKER_PROFILE.image);
    const prefix = DOCKER_PROFILE.journal.labelPrefix;
    const labels = container.Config.Labels;
    assert.equal(labels[DOCKER_PROFILE.ownershipLabel], journal.owner);
    assert.equal(labels[`${prefix}intent`], context.intent.id);
    assert.equal(labels[`${prefix}receipt`], context.intent.receiptId);
    assert.equal(labels[`${prefix}request`], context.intent.requestId);
    assert.equal(labels[`${prefix}journal`], hash(JSON.stringify(journal)));
    assert.equal(labels[`${prefix}phase`], phase);
    assert.equal(labels[`${prefix}profile`], journal.profileSha256);
    const mount = container.Mounts.find(item => item.Destination === DOCKER_PROFILE.mountTarget);
    assert.equal(mount?.Source, await realpath(join(attemptPath, phase)));
    assert.equal(mount?.RW, false);
    await docker(['rm', '--force', '--volumes', container.Id]);
    assert.equal(await inspectContainer(container.Id), null);
  }
}

async function fixture(t) {
  const parent = resolve(root, 'work/publication-integration');
  await mkdir(parent, { recursive: true });
  const realParent = await realpath(parent);
  const directory = await mkdtemp(join(realParent, 'case-'));
  const context = { statePath: join(directory, 'state'), intent: null };
  t.after(async () => {
    await cleanupOwnedContainers(context);
    const target = await realpath(directory);
    assert.equal(dirname(target), realParent);
    assert.ok(basename(target).startsWith('case-'));
    await rm(target, { recursive: true, force: false });
  });
  const consumerRoot = join(directory, 'consumer');
  await cp(join(root, 'fixtures/validation-consumer'), consumerRoot, { recursive: true });
  await writeFile(join(consumerRoot, 'package.json'), JSON.stringify({ name: 'controlled-publication-integration', private: true, type: 'module' }));
  await chmod(join(consumerRoot, 'orders.mjs'), 0o755);
  await git(consumerRoot, ['init', '--object-format=sha1', '--initial-branch=main', '--template=']);
  await git(consumerRoot, ['add', '--all']);
  await git(consumerRoot, ['commit', '-m', 'Controlled API consumer fixture']);
  const headSha = await git(consumerRoot, ['rev-parse', 'HEAD']);
  const treeSha = await git(consumerRoot, ['rev-parse', 'HEAD^{tree}']);
  const original = await treeContents(consumerRoot);
  const sourcePath = join(directory, 'provider.json');
  await cp(join(root, 'fixtures/orders-v2.json'), sourcePath);
  const { statePath } = context;
  const subscription = await registerLocalSubscription({ statePath, sourcePath, consumerRoot, enginePath,
    baselinePath: join(root, 'fixtures/orders-v1.json'), providerBaseUrl: 'https://orders.example.invalid' });
  const observation = await observeOnce({ statePath, enginePath, subscriptionId: subscription.id });
  assert.equal(observation.results.length, 1);
  assert.equal(observation.results[0].status, 'observed');
  const jobId = observation.results[0].jobId;
  assert.match(jobId, /^[a-f0-9]{64}$/u);
  const recipe = JSON.parse(await readFile(join(root, 'fixtures/validation-recipe.json'), 'utf8'));
  const input = { statePath, jobId, enginePath, recipe, testPaths: ['orders.test.mjs'] };
  const request = await prepareJobValidation(input);
  assert.equal(request.plan.authorization, 'not-granted');
  const receipt = await approveJobValidation({ ...input, expectedRequestId: request.id, origin: 'explicit-sdk-caller' });
  const queued = await queueJobValidation({ ...input, receiptId: receipt.id });
  assert.equal(queued.created, true);
  assert.equal(queued.intent.status, 'queued');
  context.intent = queued.intent;
  return { ...context, consumerRoot, headSha, treeSha, original, request, receipt };
}

test('real approved Docker validation binds an unapproved publication candidate to the committed Git blobs without modifying the consumer', { timeout: 120_000 }, async t => {
  const context = await fixture(t);
  const { statePath, intent, request, receipt, consumerRoot } = context;
  const cycle = await runApprovedJobsOnce({ statePath, enginePath, intentId: intent.id });
  assert.equal(cycle.results.length, 1);
  assert.equal(cycle.results[0].status, 'completed', JSON.stringify(cycle));
  const outcome = cycle.results[0].outcome;
  assert.equal(outcome.status, 'improved');
  assert.equal(outcome.baseline.status, 'failed');
  assert.equal(outcome.baseline.exitCode, 1);
  assert.equal(outcome.candidate.status, 'passed');
  assert.equal(outcome.candidate.exitCode, 0);
  assert.equal(outcome.consumerModified, false);
  assert.equal(outcome.publication, 'not-authorized');
  const attemptPath = join(statePath, 'attempts', receipt.id);
  assert.deepEqual(await readValidationOutcome({ attemptPath, intentId: intent.id, requestId: request.id, receiptId: receipt.id }), outcome);
  for (const phase of ['baseline', 'candidate']) {
    const journalPath = join(attemptPath, DOCKER_PROFILE.journal.directory);
    const journal = await optionalJson(join(journalPath, `${phase}.intent.json`));
    const created = await optionalJson(join(journalPath, `${phase}.created.json`));
    const cleaned = await optionalJson(join(journalPath, `${phase}.cleanup.json`));
    assert.equal(journal.intentId, intent.id);
    assert.equal(journal.receiptId, receipt.id);
    assert.equal(journal.requestId, request.id);
    assert.match(created.containerId, /^[a-f0-9]{64}$/u);
    assert.equal(created.intentSha256, hash(JSON.stringify(journal)));
    assert.equal(cleaned.intentSha256, created.intentSha256);
    assert.equal(cleaned.containerId, created.containerId);
    assert.equal(outcome[phase].cleanup, 'removed');
    assert.equal(await inspectContainer(created.containerId), null);
    assert.equal(await inspectContainer(journal.containerName), null);
  }
  const approvalsBefore = await treeContents(join(statePath, 'receipts'));
  const attemptsBefore = await readdir(join(statePath, 'attempts'));
  const executionsBefore = await listJobExecutions({ statePath });
  const candidate = await prepareJobPublicationCandidate({ statePath, intentId: intent.id, enginePath, gitPath,
    repository: 'fixture-owner/fixture-repository', baseBranch: 'main' });
  assert.equal(candidate.status, 'requires-remote-verification');
  assert.equal(candidate.authorization, 'not-granted');
  assert.equal(candidate.publication, 'not-started');
  assert.equal(candidate.consumerModified, false);
  assert.equal(candidate.destination.verified, false);
  assert.deepEqual(candidate.validation, { intentId: intent.id, requestId: request.id, receiptId: receipt.id, status: 'improved' });
  assert.deepEqual(candidate.evidence, { planId: request.plan.id, executionDigest: request.executionDigest,
    policyDigest: request.policyDigest, outcomeDigest: hash(JSON.stringify(outcome)) });
  assert.equal(candidate.git.headSha, context.headSha);
  assert.equal(candidate.git.treeSha, context.treeSha);
  assert.equal(candidate.git.consumerDigest, request.plan.evidence.consumerDigest);
  assert.equal(candidate.git.canonicalRootId, hash(await realpath(consumerRoot)));
  assert.match(candidate.headBranch, /^feat\/api-[a-f0-9]{12}$/u);
  assert.equal(candidate.pullRequest.draft, true);
  assert.match(candidate.pullRequest.body, /baseline tests failed and candidate tests passed/u);
  assert.equal(candidate.files.length, 1);
  const file = candidate.files[0];
  assert.equal(file.path, 'orders.mjs');
  assert.equal(file.mode, '100755');
  assert.equal(file.gitBlobId, await git(consumerRoot, ['rev-parse', 'HEAD:orders.mjs']));
  assert.equal(file.before, request.plan.files[0].before);
  assert.equal(file.after, request.plan.files[0].after);
  assert.equal(file.beforeSha256, hash(file.before));
  assert.equal(file.afterSha256, hash(file.after));
  assert.equal(await git(consumerRoot, ['ls-tree', 'HEAD', '--', 'orders.mjs']), `100755 blob ${file.gitBlobId}\torders.mjs`);
  assert.deepEqual(await treeContents(consumerRoot), context.original, 'Validation and preparation preserve every checkout and Git file, including the index.');
  assert.deepEqual(await treeContents(join(statePath, 'receipts')), approvalsBefore, 'Preparation cannot issue or change an approval.');
  assert.deepEqual(await readdir(join(statePath, 'attempts')), attemptsBefore);
  assert.deepEqual(await listJobExecutions({ statePath }), executionsBefore);
  await assert.rejects(inspectApproval({ statePath, consumerRoot, receiptId: receipt.id, planId: request.plan.id,
    executionDigest: request.executionDigest, policyDigest: request.policyDigest }), /already has an execution attempt/u);
});
