import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { consumeApproval } from '../dist/approval-store.js';
import { approveJobValidation, prepareJobValidation, queueJobValidation } from '../dist/job-validation.js';
import { prepareJobPublicationCandidate } from '../dist/publication-plan.js';
import { persistValidationOutcome } from '../dist/validation-outcome.js';
import { observeOnce, registerLocalSubscription } from '../dist/worker.js';
import { openWorkerStore } from '../dist/worker-store.js';

const root = resolve(import.meta.dirname, '..');
const work = join(root, 'work/test-publication-plan');
const enginePath = join(root, 'work/tools/oasdiff', process.platform === 'win32' ? 'oasdiff.exe' : 'oasdiff');
const lookup = spawnSync(process.platform === 'win32' ? 'where.exe' : '/usr/bin/which', ['git'], {
  shell: false, windowsHide: true, encoding: 'utf8', timeout: 10_000,
});
assert.equal(lookup.status, 0, `Git is required for publication evidence tests: ${lookup.stderr}`);
const gitPath = realpathSync(lookup.stdout.trim().split(/\r?\n/u).find(path => isAbsolute(path)));
const hash = value => createHash('sha256').update(value).digest('hex');

function git(consumerRoot, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_COUNT: '0', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Controlled publication fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Controlled publication fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  });
  const result = spawnSync(gitPath, ['-c', 'core.autocrlf=false', '-c', 'commit.gpgSign=false',
    '-c', 'core.hooksPath=', '-C', consumerRoot, ...args], {
    env, shell: false, windowsHide: true, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.status, 0, `Fixture Git command failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function fixture(t, { beforeObservation } = {}) {
  await mkdir(work, { recursive: true });
  const directory = await mkdtemp(join(work, 'case-'));
  t.after(async () => {
    const owned = relative(work, directory);
    assert(!isAbsolute(owned) && owned.startsWith('case-') && !owned.includes('..'));
    await rm(directory, { recursive: true, force: true });
  });
  const consumerRoot = join(directory, 'consumer');
  await cp(join(root, 'fixtures/validation-consumer'), consumerRoot, { recursive: true });
  await writeFile(join(consumerRoot, 'package.json'), JSON.stringify({ name: 'controlled-publication-fixture', private: true, type: 'module' }));
  git(consumerRoot, ['init', '--object-format=sha1', '--initial-branch=main', '--template=']);
  git(consumerRoot, ['add', '--all']);
  git(consumerRoot, ['commit', '-m', 'Controlled API consumer fixture']);
  if (beforeObservation) await beforeObservation(consumerRoot);
  const sourcePath = join(directory, 'provider.json');
  await cp(join(root, 'fixtures/orders-v2.json'), sourcePath);
  const statePath = join(directory, 'state');
  await registerLocalSubscription({ statePath, sourcePath, baselinePath: join(root, 'fixtures/orders-v1.json'),
    consumerRoot, enginePath, providerBaseUrl: 'https://orders.example.invalid' });
  const jobId = (await observeOnce({ statePath, enginePath })).results[0].jobId;
  assert.ok(jobId);
  const recipe = JSON.parse(await readFile(join(root, 'fixtures/validation-recipe.json'), 'utf8'));
  const input = { statePath, jobId, enginePath, recipe, testPaths: ['orders.test.mjs'] };
  const request = await prepareJobValidation(input);
  const receipt = await approveJobValidation({ ...input, expectedRequestId: request.id, origin: 'explicit-sdk-caller' });
  const { intent } = await queueJobValidation({ ...input, receiptId: receipt.id });
  const publication = { statePath, intentId: intent.id, enginePath, gitPath,
    repository: 'fixture-owner/fixture-repository', baseBranch: 'main' };
  return { input, request, receipt, intent, consumerRoot, sourcePath, publication };
}

function simulatedResult(context, status) {
  // These artifacts exercise the publication gate only; they are not evidence of Docker or consumer execution.
  const phase = passed => ({ status: passed ? 'passed' : 'failed', exitCode: passed ? 0 : 1,
    cleanup: 'removed', stdout: 'Controlled simulated result; no consumer execution occurred.', stderr: '' });
  return { schemaVersion: 1, requestId: context.request.id, receiptId: context.receipt.id, status,
    baseline: status === 'blocked'
      ? { status: 'blocked', exitCode: null, cleanup: 'not-created', stdout: '', stderr: '', reason: 'Controlled missing runtime fixture' }
      : phase(status === 'passed' || status === 'regression'),
    ...(status === 'blocked' ? {} : { candidate: phase(status === 'passed' || status === 'improved') }),
    consumerModified: false, publication: 'not-authorized' };
}

async function completeSimulation(context, status = 'passed', executionState = 'completed') {
  const { request, receipt, intent, input, consumerRoot } = context;
  const { attemptPath } = await consumeApproval({ statePath: input.statePath, consumerRoot, receiptId: receipt.id,
    planId: request.plan.id, executionDigest: request.executionDigest, policyDigest: request.policyDigest });
  await writeFile(join(attemptPath, 'request.json'), JSON.stringify(request), { flag: 'wx', mode: 0o600 });
  const outcome = await persistValidationOutcome({ attemptPath, intentId: intent.id, result: simulatedResult(context, status) });
  const store = await openWorkerStore(input.statePath);
  try {
    if (executionState !== 'queued') {
      const claim = store.claimExecution(intent.id);
      assert.ok(claim);
      if (executionState === 'completed') store.completeExecution({ claim, outcome });
      else if (executionState === 'blocked') store.blockExecution({ claim, reason: 'execution-failed' });
      else if (executionState === 'interrupted') store.interruptExecution({ claim, reason: 'cleanup-unresolved' });
    }
  } finally { store.close(); }
  return { attemptPath, outcome };
}

async function treeContents(directory) {
  const result = {};
  async function visit(current, prefix) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(current, entry.name);
      const key = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(path, key);
      else { assert(entry.isFile(), 'The controlled repository contains only regular files'); result[key] = hash(await readFile(path)); }
    }
  }
  await visit(directory, '');
  return result;
}

function mutateRecipe(context, transform) {
  const db = new DatabaseSync(join(context.input.statePath, 'worker.sqlite3'));
  try {
    const value = JSON.parse(db.prepare('SELECT recipe_json FROM execution_intents WHERE id=?').get(context.intent.id).recipe_json);
    transform(value);
    db.prepare('UPDATE execution_intents SET recipe_json=? WHERE id=?').run(JSON.stringify(value), context.intent.id);
  } finally { db.close(); }
}

test('a simulated passing validation produces only a deterministic, unapproved local publication candidate', async t => {
  const context = await fixture(t);
  const { outcome } = await completeSimulation(context);
  const before = await treeContents(context.consumerRoot);
  const credential = 'controlled-secret-must-not-enter-publication-candidates';
  const previousToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = credential;
  t.after(() => {
    if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousToken;
  });
  let networkCalls = 0;
  t.mock.method(globalThis, 'fetch', () => { networkCalls += 1; throw new Error('Publication planning must not use the network'); });
  const candidate = await prepareJobPublicationCandidate(context.publication);
  assert.equal(candidate.schemaVersion, 1);
  assert.match(candidate.id, /^[a-f0-9]{64}$/u);
  assert.equal(candidate.status, 'requires-remote-verification');
  assert.equal(candidate.authorization, 'not-granted');
  assert.equal(candidate.publication, 'not-started');
  assert.equal(candidate.consumerModified, false);
  assert.deepEqual(candidate.validation, { intentId: context.intent.id, requestId: context.request.id,
    receiptId: context.receipt.id, status: 'passed' });
  assert.deepEqual(candidate.evidence, { planId: context.request.plan.id,
    executionDigest: context.request.executionDigest, policyDigest: context.request.policyDigest,
    outcomeDigest: hash(JSON.stringify(outcome)) });
  assert.deepEqual(candidate.destination, { host: 'github.com', owner: 'fixture-owner', name: 'fixture-repository', baseBranch: 'main', verified: false });
  assert.match(candidate.git.canonicalRootId, /^[a-f0-9]{64}$/u);
  const canonicalRoot = realpathSync(context.consumerRoot);
  assert.equal(candidate.git.canonicalRootId, hash(process.platform === 'win32' ? canonicalRoot.toLowerCase() : canonicalRoot));
  assert.equal(candidate.git.headSha, git(context.consumerRoot, ['rev-parse', 'HEAD']));
  assert.equal(candidate.git.treeSha, git(context.consumerRoot, ['rev-parse', 'HEAD^{tree}']));
  assert.equal(candidate.git.consumerDigest, context.request.plan.evidence.consumerDigest);
  assert.match(candidate.headBranch, /^feat\/api-[a-f0-9]{12}$/u);
  assert.equal(candidate.pullRequest.draft, true);
  assert.ok(candidate.pullRequest.title.trim());
  assert.ok(candidate.pullRequest.body.trim());
  assert.equal(candidate.files.length, 1);
  const file = candidate.files[0];
  assert.equal(file.path, 'orders.mjs');
  assert.equal(file.mode, '100644');
  assert.equal(file.gitBlobId, git(context.consumerRoot, ['rev-parse', 'HEAD:orders.mjs']));
  assert.equal(file.before, context.request.plan.files[0].before);
  assert.equal(file.after, context.request.plan.files[0].after);
  assert.equal(file.beforeSha256, hash(file.before));
  assert.equal(file.afterSha256, hash(file.after));
  assert.deepEqual(await prepareJobPublicationCandidate(context.publication), candidate);
  assert.equal(JSON.stringify(candidate).includes(credential), false);
  assert.deepEqual(await treeContents(context.consumerRoot), before, 'The checkout and all Git files, including the index, remain unchanged');
  assert.equal(networkCalls, 0);
});

test('a simulated improved outcome retains the baseline failure in the proposed PR', async t => {
  const context = await fixture(t);
  await completeSimulation(context, 'improved');
  const candidate = await prepareJobPublicationCandidate(context.publication);
  assert.equal(candidate.validation.status, 'improved');
  assert.match(candidate.pullRequest.body, /improved|baseline[^\n]{0,100}fail/iu);
  assert.equal(candidate.authorization, 'not-granted');
});

test('repository and base branch are bound to candidate identity', async t => {
  const context = await fixture(t);
  await completeSimulation(context);
  const original = await prepareJobPublicationCandidate(context.publication);
  const repository = await prepareJobPublicationCandidate({ ...context.publication, repository: 'fixture-owner/another-repository' });
  const branch = await prepareJobPublicationCandidate({ ...context.publication, baseBranch: 'release' });
  assert.notEqual(repository.id, original.id);
  assert.notEqual(branch.id, original.id);
  assert.equal(repository.destination.verified, false);
  assert.equal(branch.destination.verified, false);
});

for (const status of ['failed', 'regression', 'blocked']) {
  test(`a completed ${status} outcome cannot establish publishable validation`, async t => {
    const context = await fixture(t);
    await completeSimulation(context, status);
    await assert.rejects(prepareJobPublicationCandidate(context.publication), { code: 'INVALID_INPUT' });
  });
}

for (const status of ['queued', 'running', 'blocked', 'interrupted']) {
  test(`a ${status} job with simulated passing files still lacks completed execution`, async t => {
    const context = await fixture(t);
    await completeSimulation(context, 'passed', status);
    await assert.rejects(prepareJobPublicationCandidate(context.publication), { code: 'INVALID_INPUT' });
  });
}

for (const artifact of ['missing-result', 'malformed-outcome', 'contradictory-outcome', 'cross-request', 'cross-receipt']) {
  test(`publication rejects ${artifact} validation artifacts`, async t => {
    const context = await fixture(t);
    const { attemptPath } = await completeSimulation(context);
    const outcomePath = join(attemptPath, 'outcome.json');
    if (artifact === 'missing-result') await rm(join(attemptPath, 'result.json'));
    else if (artifact === 'malformed-outcome') await writeFile(outcomePath, '{');
    else {
      const outcome = JSON.parse(await readFile(outcomePath, 'utf8'));
      if (artifact === 'contradictory-outcome') outcome.status = 'failed';
      if (artifact === 'cross-request') outcome.requestId = 'a'.repeat(64);
      if (artifact === 'cross-receipt') outcome.receiptId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      await writeFile(outcomePath, JSON.stringify(outcome));
    }
    await assert.rejects(prepareJobPublicationCandidate(context.publication), { code: 'INVALID_INPUT' });
  });
}

test('a different valid durable outcome cannot silently replace the recorded database evidence', async t => {
  const context = await fixture(t);
  const { attemptPath } = await completeSimulation(context);
  const result = simulatedResult(context, 'improved');
  const outcomePath = join(attemptPath, 'outcome.json');
  const outcome = JSON.parse(await readFile(outcomePath, 'utf8'));
  outcome.status = 'improved';
  outcome.baseline = { status: 'failed', exitCode: 1, cleanup: 'removed' };
  await writeFile(join(attemptPath, 'result.json'), JSON.stringify(result));
  await writeFile(outcomePath, JSON.stringify(outcome));
  await assert.rejects(prepareJobPublicationCandidate(context.publication), { code: 'INVALID_INPUT' });
});

test('provider evidence changed since validation cannot be published as current', async t => {
  const context = await fixture(t);
  await completeSimulation(context);
  await cp(join(root, 'fixtures/orders-v1.json'), context.sourcePath);
  await assert.rejects(prepareJobPublicationCandidate(context.publication), { code: 'INVALID_INPUT' });
});

test('source changes after validation are preserved and invalidate publication preparation', async t => {
  const context = await fixture(t);
  await completeSimulation(context);
  const path = join(context.consumerRoot, 'orders.mjs');
  const changed = `${await readFile(path, 'utf8')}\n// Human edit after the simulated validation.\n`;
  await writeFile(path, changed);
  const before = await treeContents(context.consumerRoot);
  await assert.rejects(prepareJobPublicationCandidate(context.publication), { code: 'INVALID_INPUT' });
  assert.equal(await readFile(path, 'utf8'), changed);
  assert.deepEqual(await treeContents(context.consumerRoot), before);
});

for (const state of ['dirty', 'staged', 'untracked']) {
  test(`fresh validation over ${state} source cannot claim the committed base was tested`, async t => {
    const context = await fixture(t, { beforeObservation: async consumerRoot => {
      const path = join(consumerRoot, state === 'untracked' ? 'untracked.mjs' : 'orders.test.mjs');
      await writeFile(path, state === 'untracked' ? 'export const untracked = true;\n' : `${await readFile(path, 'utf8')}\n// Not in the Git base.\n`);
      if (state === 'staged') git(consumerRoot, ['add', '--', 'orders.test.mjs']);
    } });
    await completeSimulation(context);
    const before = await treeContents(context.consumerRoot);
    await assert.rejects(prepareJobPublicationCandidate(context.publication), { code: 'INVALID_INPUT' });
    assert.deepEqual(await treeContents(context.consumerRoot), before);
  });
}

test('an uncommitted package manifest is part of the validation-to-Git binding', async t => {
  const context = await fixture(t, { beforeObservation: async consumerRoot => {
    await writeFile(join(consumerRoot, 'package.json'), JSON.stringify({ name: 'controlled-publication-fixture', private: true, type: 'module', version: 'uncommitted' }));
  } });
  await completeSimulation(context);
  await assert.rejects(prepareJobPublicationCandidate(context.publication), { code: 'INVALID_INPUT' });
});

test('GitHub destination metadata rejects ambiguous repositories and unsafe base refs', async t => {
  const context = await fixture(t);
  await completeSimulation(context);
  for (const repository of ['fixture-owner', 'fixture-owner/repository/more', 'https://github.com/fixture-owner/repository',
    '../repository', 'fixture-owner\\repository', 'fixture-owner/repository\n', 'fixture-owner/repository?token=secret', '/repository', 'fixture-owner/']) {
    await assert.rejects(prepareJobPublicationCandidate({ ...context.publication, repository }), { code: 'INVALID_INPUT' });
  }
  for (const baseBranch of ['', '../main', '-main', 'main..old', 'main\n', 'main.lock', 'feat//wrong', '@{main}', 'main:other']) {
    await assert.rejects(prepareJobPublicationCandidate({ ...context.publication, baseBranch }), { code: 'INVALID_INPUT' });
  }
});

for (const path of ['../outside.mjs', '.git/config.mjs', '.github/workflows/owned.mjs']) {
  test(`a tampered recipe cannot introduce publication path ${path}`, async t => {
    const context = await fixture(t);
    await completeSimulation(context);
    mutateRecipe(context, recipe => { recipe.files[0].path = path; });
    const before = await treeContents(context.consumerRoot);
    await assert.rejects(prepareJobPublicationCandidate(context.publication), { code: 'INVALID_INPUT' });
    assert.deepEqual(await treeContents(context.consumerRoot), before);
  });
}
