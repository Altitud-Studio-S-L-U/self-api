import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { preparePublicationRequest } from '../dist/publication-runner.js';
import { runPublicationCommandCli } from '../dist/publication-command-cli.js';
import { PlumberError } from '../dist/errors.js';

const work = resolve(import.meta.dirname, '../work/test-publication-command-cli');
const digest = value => createHash('sha256').update(value).digest('hex');
const hash = '1'.repeat(64);
const baseSha = 'a'.repeat(40);
const treeSha = 'b'.repeat(40);

async function fixture(t) {
  await mkdir(work, { recursive: true });
  const directory = await mkdtemp(join(work, 'case-'));
  t.after(async () => {
    const owned = relative(work, directory);
    assert(!isAbsolute(owned) && owned.startsWith('case-') && !owned.includes('..'));
    await rm(directory, { recursive: true, force: true });
  });
  const before = 'export const privateOriginal = order => order.total;\n';
  const after = 'export const privateOriginal = order => order.amount;\n';
  const content = {
    schemaVersion: 1, status: 'requires-remote-verification', authorization: 'not-granted', publication: 'not-started',
    validation: { intentId: hash, requestId: hash, receiptId: randomUUID(), status: 'passed' },
    evidence: { planId: hash, executionDigest: hash, policyDigest: hash, outcomeDigest: hash },
    git: { canonicalRootId: hash, headSha: baseSha, treeSha, consumerDigest: hash },
    destination: { host: 'github.com', owner: 'fixture-owner', name: 'fixture-repo', baseBranch: 'main', verified: false },
    files: [{ path: 'orders.mjs', beforeSha256: digest(before), afterSha256: digest(after), before, after, mode: '100644',
      gitBlobId: createHash('sha1').update(`blob ${Buffer.byteLength(before)}\0`).update(before).digest('hex') }],
    pullRequest: { title: 'Fixture draft', body: 'Private reviewed description\u001b[2J\u202e.', draft: true }, consumerModified: false,
  };
  const id = digest(JSON.stringify(content));
  const candidate = { ...content, id, headBranch: `feat/api-${id.slice(0, 12)}` };
  let adapterCalls = 0;
  const unreachable = async () => { throw new Error('An unconfigured fixture operation ran.'); };
  const provider = {
    id: 'fixture-provider', host: 'github.com', mode: 'simulation',
    readSnapshot: async () => ({ repositoryId: '123', owner: 'fixture-owner', name: 'fixture-repo', private: true, baseBranch: 'main', headSha: baseSha, treeSha }),
    createCommit: unreachable, createBranch: unreachable, createDraftPullRequest: unreachable, readBranch: unreachable, findPullRequests: unreachable,
  };
  const request = await preparePublicationRequest({ candidate, adapter: provider, author: { name: 'Fixture Author', email: 'fixture@example.invalid' }, timestamp: '2026-10-07T12:00:00.000Z' });
  const candidatePath = join(directory, 'candidate.json');
  const requestPath = join(directory, 'request.json');
  await writeFile(candidatePath, JSON.stringify(candidate));
  await writeFile(requestPath, JSON.stringify(request));
  const receiptId = randomUUID();
  const statePath = join(directory, 'state');
  const consumerRoot = join(directory, 'consumer');
  const review = ['publication-review', '--candidate', candidatePath, '--author-name', 'Fixture Author', '--author-email', 'fixture@example.invalid', '--github'];
  const approve = ['publication-approve', '--request', requestPath, '--state', statePath, '--consumer', consumerRoot];
  const publish = ['publication-publish', '--request', requestPath, '--state', statePath, '--consumer', consumerRoot, '--approval', receiptId, '--github'];
  const result = { schemaVersion: 1, requestId: request.id, receiptId, mode: 'simulation', status: 'published', reason: 'Simulated fixture confirmed.', consumerModified: false };
  const run = async (args, overrides = {}) => {
    let stdout = '';
    let stderr = '';
    const code = await runPublicationCommandCli(args, {
      adapter: () => { adapterCalls += 1; return provider; },
      stdout: value => { stdout += value; }, stderr: value => { stderr += value; },
      ...overrides,
    });
    return { code, stdout, stderr };
  };
  return { directory, candidate, request, candidatePath, requestPath, receiptId, statePath, consumerRoot,
    review, approve, publish, result, run, adapterCalls: () => adapterCalls };
}

test('review requires explicit GitHub reads, exposes the exact destination and omits private source by default', async t => {
  const context = await fixture(t);
  let input;
  const result = await context.run(context.review, { prepare: async value => { input = value; return context.request; } });
  assert.equal(result.code, 0);
  assert.equal(context.adapterCalls(), 1);
  assert.deepEqual(input.candidate, context.candidate);
  assert.deepEqual(input.author, { name: 'Fixture Author', email: 'fixture@example.invalid' });
  assert.match(result.stdout, /github\.com\/fixture-owner\/fixture-repo/u);
  assert.match(result.stdout, /repository ID 123/u);
  assert.match(result.stdout, /Mode: simulation/u);
  assert.match(result.stdout, /Plumber Cloud receives nothing/u);
  assert.match(result.stdout, /one attempt and expires after 15 minutes/u);
  assert(!result.stdout.includes(context.candidate.files[0].before));
  assert(!result.stdout.includes(context.candidate.files[0].after));
  assert(!result.stdout.includes(context.candidate.pullRequest.body));
  const json = await context.run([...context.review, '--json'], { prepare: async () => context.request });
  assert.equal(json.code, 0);
  assert.deepEqual(JSON.parse(json.stdout), context.request);
  assert.doesNotMatch(json.stdout, /[\u001b\u202e]/u);
});

test('approval displays full changes before exact confirmation, invokes no adapter and creates only publication consent', async t => {
  const context = await fixture(t);
  let displayed = '';
  let confirmed;
  let approved;
  const result = await context.run(context.approve, {
    stdout: value => { displayed += value; },
    confirm: async id => {
      confirmed = id;
      assert(displayed.includes(context.candidate.files[0].before.trim()));
      assert(displayed.includes(context.candidate.files[0].after.trim()));
      assert(displayed.includes('Draft body:'));
      return true;
    },
    approve: async input => {
      approved = input;
      return { schemaVersion: 1, id: context.receiptId, action: 'publish-draft-pr', requestId: context.request.id, expiresAt: '2026-10-07T12:15:00.000Z' };
    },
  });
  assert.equal(result.code, 0);
  assert.equal(context.adapterCalls(), 0);
  assert.equal(confirmed, context.request.id);
  assert.deepEqual(approved, { request: context.request, expectedRequestId: context.request.id, statePath: context.statePath, consumerRoot: context.consumerRoot, origin: 'local-cli' });
  assert.match(displayed, /Publishing remains a separate explicit command/u);
  assert.doesNotMatch(displayed, /[\u001b\u202e]/u);
});

test('cancelled or noninteractive approval never issues consent or touches credentials', async t => {
  const context = await fixture(t);
  let called = false;
  const cancelled = await context.run(context.approve, { confirm: async () => false, approve: async () => { called = true; } });
  assert.equal(cancelled.code, 1);
  assert.equal(called, false);
  assert.match(cancelled.stdout, /cancelled/u);
  const noninteractive = await context.run(context.approve, { confirm: async () => { throw new PlumberError('INVALID_INPUT', 'Approval requires an interactive terminal.'); }, approve: async () => { called = true; } });
  assert.equal(noninteractive.code, 2);
  assert.equal(called, false);
  assert.equal(context.adapterCalls(), 0);
});

test('invalid, duplicate, extra and missing opt-in arguments are rejected before loading state or constructing an adapter', async t => {
  const context = await fixture(t);
  for (const args of [
    [], ['publication-review'], context.review.filter(arg => arg !== '--github'), context.publish.filter(arg => arg !== '--github'),
    [...context.review, '--github'], [...context.review, '--json', '--json'], [...context.review, '--candidate', context.candidatePath],
    [...context.review, 'extra'], [...context.review, '--yes'], [...context.approve, '--json'], [...context.approve, '--github'],
    [...context.approve, '--approval', context.receiptId], [...context.publish, '--force'], [...context.publish, '--merge'],
    ['publication-reconcile', '--request', context.requestPath, '--state', context.statePath, '--consumer', context.consumerRoot],
  ]) {
    const before = context.adapterCalls();
    const result = await context.run(args);
    assert.equal(result.code, 2, JSON.stringify(args));
    assert.equal(JSON.parse(result.stderr).error.code, 'INVALID_INPUT');
    assert.equal(context.adapterCalls(), before);
  }
});

test('publishing and reconciliation dispatch separately with the exact approved request and receipt', async t => {
  const context = await fixture(t);
  let published;
  let reconciled;
  const first = await context.run([...context.publish, '--json'], { publish: async input => { published = input; return context.result; } });
  assert.equal(first.code, 0);
  assert.deepEqual(JSON.parse(first.stdout), context.result);
  assert.deepEqual(published.request, context.request);
  assert.equal(published.receiptId, context.receiptId);
  assert.equal(published.statePath, context.statePath);
  const second = await context.run(['publication-reconcile', ...context.publish.slice(1)], { reconcile: async input => { reconciled = input; return context.result; } });
  assert.equal(second.code, 0);
  assert.equal(reconciled.receiptId, context.receiptId);
  assert.match(second.stdout, /Adoption, merge and deployment are not established/u);
});

test('uncertain and conflict outcomes remain distinct failures without automatic retries', async t => {
  const context = await fixture(t);
  for (const [status, code] of [['uncertain', 2], ['conflict', 1]]) {
    let calls = 0;
    const result = await context.run(context.publish, { publish: async () => { calls += 1; return { ...context.result, status }; } });
    assert.equal(result.code, code);
    assert.equal(calls, 1);
    assert.match(result.stdout, new RegExp(`Publication: ${status}`, 'u'));
    if (status === 'uncertain') assert.match(result.stdout, /No automatic retry was made/u);
  }
});

test('tampered local requests fail before confirmation or adapter construction', async t => {
  const context = await fixture(t);
  await writeFile(context.requestPath, JSON.stringify({ ...context.request, pullRequest: { ...context.request.pullRequest, draft: false } }));
  let confirmed = false;
  const result = await context.run(context.approve, { confirm: async () => { confirmed = true; return true; } });
  assert.equal(result.code, 2);
  assert.equal(confirmed, false);
  assert.equal(context.adapterCalls(), 0);
  assert.equal((await context.run(context.publish)).code, 2);
  assert.equal(context.adapterCalls(), 0);
});

test('local JSON input is bounded to 4 MiB and URL inputs are rejected without adapter access', async t => {
  const context = await fixture(t);
  await writeFile(context.candidatePath, JSON.stringify({ excessive: 'x'.repeat(4 * 1024 * 1024) }));
  assert.equal((await context.run(context.review)).code, 2);
  const remote = context.review.map(arg => arg === context.candidatePath ? 'https://example.invalid/candidate.json' : arg);
  assert.equal((await context.run(remote)).code, 2);
  assert.equal(context.adapterCalls(), 0);
});

test('unexpected adapter errors cannot expose tokens or raw response details', async t => {
  const context = await fixture(t);
  const result = await context.run(context.review, { prepare: async () => { throw new Error('GH_TOKEN=fixture-secret\u001b[2J'); } });
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.doesNotMatch(result.stderr, /GH_TOKEN|fixture-secret|\u001b/u);
  assert.equal(JSON.parse(result.stderr).error.code, 'ENGINE_FAILED');
});
