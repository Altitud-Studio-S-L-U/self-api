import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { captureConsumer } from '../dist/consumer-files.js';
import { issueApproval } from '../dist/approval-store.js';
import { createGitHubPublicationAdapter } from '../dist/github-publication.js';
import { approvePublicationRequest, preparePublicationRequest, publishPublication, reconcilePublication } from '../dist/publication-runner.js';

const root = resolve(import.meta.dirname, '..');
const work = join(root, 'work/test-publication-runner');
const digest = value => createHash('sha256').update(value).digest('hex');
const hash = digit => digit.repeat(64);
const oid = digit => digit.repeat(40);
const invalid = error => error.code === 'INVALID_INPUT';

async function fixture(t, overrides = {}, source = {}) {
  await mkdir(work, { recursive: true });
  const directory = await mkdtemp(join(work, 'case-'));
  t.after(async () => {
    const owned = relative(work, directory);
    assert(!isAbsolute(owned) && owned.startsWith('case-') && !owned.includes('..'));
    await rm(directory, { recursive: true, force: true });
  });
  const consumerRoot = join(directory, 'consumer');
  const statePath = join(directory, 'state');
  await mkdir(consumerRoot);
  const path = source.path ?? 'orders.mjs';
  const before = source.before ?? 'export const total = order => order.total;\n';
  const after = source.after ?? 'export const total = order => order.amount;\n';
  await writeFile(join(consumerRoot, path), before);
  const canonical = await realpath(consumerRoot);
  const candidateContent = {
    schemaVersion: 1, status: 'requires-remote-verification', authorization: 'not-granted', publication: 'not-started',
    // Simulated validation evidence: these tests exercise publication state, not Docker or a real provider.
    validation: { intentId: hash('1'), requestId: hash('2'), receiptId: randomUUID(), status: 'passed' },
    evidence: { planId: hash('3'), executionDigest: hash('4'), policyDigest: hash('5'), outcomeDigest: hash('6') },
    git: { canonicalRootId: digest(process.platform === 'win32' ? canonical.toLowerCase() : canonical), headSha: oid('a'), treeSha: oid('b'), consumerDigest: (await captureConsumer(consumerRoot)).digest },
    destination: { host: 'github.com', owner: 'fixture-owner', name: 'fixture-repo', baseBranch: 'main', verified: false },
    files: [{ path, beforeSha256: digest(before), afterSha256: digest(after), before, after, mode: '100644',
      gitBlobId: createHash('sha1').update(`blob ${Buffer.byteLength(before)}\0`).update(before).digest('hex') }],
    pullRequest: { title: 'Update API integration', body: 'Fixture migration from a simulated passed validation.', draft: true }, consumerModified: false,
  };
  const id = digest(JSON.stringify(candidateContent));
  const candidate = { ...candidateContent, id, headBranch: `feat/api-${id.slice(0, 12)}` };
  const remote = {
    repositoryId: 'fixture-repository-123', owner: 'fixture-owner', name: 'fixture-repo', private: true,
    baseBranch: 'main', headSha: oid('a'), treeSha: oid('b'),
  };
  const memory = { branch: null, prs: [], remote, calls: [], commitSha: oid('c'), treeSha: oid('d') };
  const provider = {
    id: 'fixture-provider', host: 'github.com', mode: 'simulation',
    readSnapshot: async () => { memory.calls.push('readSnapshot'); return structuredClone(memory.remote); },
    readBranch: async () => { memory.calls.push('readBranch'); return structuredClone(memory.branch); },
    findPullRequests: async () => { memory.calls.push('findPullRequests'); return structuredClone(memory.prs); },
    createCommit: async input => {
      memory.calls.push('createCommit');
      assert.equal(input.parentSha, candidate.git.headSha);
      assert.equal(input.baseTreeSha, candidate.git.treeSha);
      assert.deepEqual(input.files, [{ path, mode: '100644', content: after, beforeBlobId: candidate.files[0].gitBlobId }]);
      assert.equal(input.author.name, 'Fixture Maintainer');
      assert(Date.parse(input.expiresAt) > Date.now());
      return { commitSha: memory.commitSha, treeSha: memory.treeSha };
    },
    createBranch: async input => {
      memory.calls.push('createBranch');
      assert.equal(memory.branch, null, 'fixture branch is create-only');
      memory.branch = { commitSha: input.commitSha };
    },
    createDraftPullRequest: async input => {
      memory.calls.push('createDraftPullRequest');
      const pr = { repositoryId: remote.repositoryId, headRepositoryId: remote.repositoryId, number: 7,
        url: 'https://github.com/fixture-owner/fixture-repo/pull/7', state: 'open', draft: true,
        headSha: memory.branch.commitSha, headBranch: input.headBranch, baseBranch: input.baseBranch, title: input.title, body: input.body };
      memory.prs.push(pr);
      return structuredClone(pr);
    },
    ...overrides,
  };
  const prepare = (input = {}) => preparePublicationRequest({ candidate, adapter: provider,
    author: { name: 'Fixture Maintainer', email: 'fixture@example.invalid' }, timestamp: '2026-10-07T08:00:00.000Z', ...input });
  const request = await prepare();
  const approve = (input = {}) => approvePublicationRequest({ request, expectedRequestId: request.id, statePath, consumerRoot, origin: 'explicit-sdk-caller', ...input });
  const operation = receiptId => ({ request, statePath, consumerRoot, receiptId, adapter: provider });
  return { directory, consumerRoot, statePath, candidate, provider, memory, request, prepare, approve, operation };
}

test('request preparation is deterministic for selected timestamp and binds repository, mode, author and candidate', async t => {
  const context = await fixture(t);
  assert.equal((await context.prepare()).id, context.request.id);
  assert.equal(context.request.action, 'publish-draft-pr');
  assert.equal(context.request.authorization, 'not-granted');
  assert.equal(context.request.snapshot.repositoryId, context.memory.remote.repositoryId);
  assert.equal(context.request.adapter.mode, 'simulation');
  assert.notEqual((await context.prepare({ author: { name: 'Another Fixture', email: 'another@example.invalid' } })).id, context.request.id);
  assert.notEqual((await context.prepare({ timestamp: '2026-10-07T09:00:00.000Z' })).id, context.request.id);
  assert.throws(() => { context.request.candidate.files[0].after = 'mutated'; }, TypeError);
  assert(context.memory.calls.every(call => call === 'readSnapshot'));
});

test('approval is separate, publication journals each intent before writes and preserves the consumer', async t => {
  const context = await fixture(t);
  const approval = await context.approve();
  assert.equal(approval.action, 'publish-draft-pr');
  assert.equal(approval.requestId, context.request.id);
  const path = join(context.statePath, 'attempts', approval.id);
  for (const [method, journal] of [['createCommit', '01-commit-intent.json'], ['createBranch', '03-branch-intent.json'], ['createDraftPullRequest', '05-pr-intent.json']]) {
    const original = context.provider[method];
    context.provider[method] = async input => {
      const evidence = JSON.parse(await readFile(join(path, journal), 'utf8'));
      assert.equal(evidence.requestId, context.request.id);
      assert.equal(JSON.parse(await readFile(join(path, 'publication.json'), 'utf8')).candidateId, context.candidate.id);
      return original(input);
    };
  }
  const before = await readFile(join(context.consumerRoot, 'orders.mjs'));
  const published = await publishPublication(context.operation(approval.id));
  assert.equal(published.status, 'published');
  assert.equal(published.mode, 'simulation');
  assert.equal(published.pullRequest.draft, true);
  assert.equal(published.commitSha, context.memory.commitSha);
  assert.equal(published.consumerModified, false);
  assert.deepEqual(await readFile(join(context.consumerRoot, 'orders.mjs')), before);
  assert.deepEqual(JSON.parse(await readFile(join(path, 'result.json'), 'utf8')), published);
  assert.deepEqual(context.memory.calls.filter(call => call.startsWith('create')), ['createCommit', 'createBranch', 'createDraftPullRequest']);
  await assert.rejects(publishPublication(context.operation(approval.id)), invalid);
});

test('concurrent publication using one receipt performs the write sequence once', async t => {
  const context = await fixture(t);
  const approval = await context.approve();
  const results = await Promise.allSettled([publishPublication(context.operation(approval.id)), publishPublication(context.operation(approval.id))]);
  assert.equal(results.filter(item => item.status === 'fulfilled' && item.value.status === 'published').length, 1);
  assert.equal(results.filter(item => item.status === 'rejected').length, 1);
  assert.equal(context.memory.calls.filter(call => call === 'createDraftPullRequest').length, 1);
});

test('validation authorization cannot be reused as publication authorization', async t => {
  const context = await fixture(t);
  const executionApproval = await issueApproval({ statePath: context.statePath, consumerRoot: context.consumerRoot,
    planId: context.candidate.evidence.planId, executionDigest: context.candidate.evidence.executionDigest,
    policyDigest: context.candidate.evidence.policyDigest, origin: 'explicit-sdk-caller' });
  await assert.rejects(publishPublication(context.operation(executionApproval.id)), invalid);
  assert(!context.memory.calls.some(call => call.startsWith('create')));
});

for (const source of [
  { language: 'Python', path: 'payment_client.py', before: 'def total(order):\n    return order["total"]\n', after: 'def total(order):\n    return order["amount"]\n' },
  { language: 'Java', path: 'PaymentClient.java', before: 'class PaymentClient { static int total() { return 1; } }\n', after: 'class PaymentClient { static int total() { return 2; } }\n' },
]) {
  test(`${source.language} publication simulation requires separate approval and preserves byte-bound source`, async t => {
    const context = await fixture(t, {}, source);
    assert.equal(context.request.candidate.files[0].path, source.path);
    assert.equal(context.request.authorization, 'not-granted');
    assert(context.memory.calls.every(call => call === 'readSnapshot'));
    const executionApproval = await issueApproval({ statePath: context.statePath, consumerRoot: context.consumerRoot,
      planId: context.candidate.evidence.planId, executionDigest: context.candidate.evidence.executionDigest,
      policyDigest: context.candidate.evidence.policyDigest, origin: 'explicit-sdk-caller' });
    await assert.rejects(publishPublication(context.operation(executionApproval.id)), invalid);
    assert(!context.memory.calls.some(call => call.startsWith('create')));
    const approval = await context.approve();
    assert.equal(approval.action, 'publish-draft-pr');
    const published = await publishPublication(context.operation(approval.id));
    assert.equal(published.status, 'published');
    assert.equal(published.mode, 'simulation');
    assert.equal(published.pullRequest.draft, true);
    assert.equal(published.consumerModified, false);
    assert.equal(await readFile(join(context.consumerRoot, source.path), 'utf8'), source.before);
    assert.deepEqual(context.memory.calls.filter(call => call.startsWith('create')), ['createCommit', 'createBranch', 'createDraftPullRequest']);
    await assert.rejects(publishPublication(context.operation(approval.id)), invalid);
    const changed = await fixture(t, {}, source);
    const changedApproval = await changed.approve();
    await writeFile(join(changed.consumerRoot, source.path), `${source.before}\n// synthetic concurrent edit\n`);
    await assert.rejects(changed.approve(), invalid);
    await assert.rejects(publishPublication(changed.operation(changedApproval.id)), invalid);
    assert(!changed.memory.calls.some(call => call.startsWith('create')));
  });
}

test('changed request, wrong confirmation, wrong consumer and nested state cannot be approved', async t => {
  const context = await fixture(t);
  await assert.rejects(context.approve({ expectedRequestId: 'different' }), invalid);
  await assert.rejects(context.approve({ request: { ...context.request, commit: { ...context.request.commit, message: 'Other commit.' } } }), invalid);
  const other = join(context.directory, 'other-consumer');
  await mkdir(other);
  await assert.rejects(context.approve({ consumerRoot: other }), invalid);
  await assert.rejects(context.approve({ statePath: join(context.consumerRoot, 'state') }), invalid);
});

test('changed local source prevents both approval and publication, without remote writes', async t => {
  const context = await fixture(t);
  const approval = await context.approve();
  await writeFile(join(context.consumerRoot, 'orders.mjs'), 'export const humanChange = true;\n');
  await assert.rejects(context.approve(), invalid);
  await assert.rejects(publishPublication(context.operation(approval.id)), invalid);
  assert(!context.memory.calls.some(call => call.startsWith('create')));
});

for (const changed of [{ repositoryId: 'another-repository' }, { headSha: oid('e') }, { treeSha: oid('e') }, { private: false }]) {
  test(`destination change ${Object.keys(changed)[0]} before publication prevents all writes`, async t => {
    const context = await fixture(t);
    const approval = await context.approve();
    Object.assign(context.memory.remote, changed);
    await assert.rejects(publishPublication(context.operation(approval.id)), invalid);
    assert(!context.memory.calls.some(call => call.startsWith('create')));
  });
}

test('preparation rejects changed base, public repositories and corrupt validation or source evidence', async t => {
  const context = await fixture(t);
  for (const change of [value => { value.validation.status = 'failed'; }, value => { value.files[0].after = 'other'; }, value => { value.headBranch = 'main'; }]) {
    const candidate = structuredClone(context.candidate);
    change(candidate);
    await assert.rejects(context.prepare({ candidate }), invalid);
  }
  context.memory.remote.headSha = oid('e');
  await assert.rejects(context.prepare(), invalid);
  context.memory.remote.headSha = context.candidate.git.headSha;
  context.memory.remote.private = false;
  await assert.rejects(context.prepare(), invalid);
});

test('live and simulation adapters are distinct approval destinations', async t => {
  const context = await fixture(t);
  const approval = await context.approve();
  await assert.rejects(publishPublication({ ...context.operation(approval.id), adapter: { ...context.provider, mode: 'live' } }), invalid);
  assert(!context.memory.calls.some(call => call.startsWith('create')));
});

for (const method of ['createCommit', 'createBranch', 'createDraftPullRequest']) {
  test(`failure at ${method} records uncertainty and is never blindly replayed`, async t => {
    const context = await fixture(t);
    const approval = await context.approve();
    let attempts = 0;
    context.provider[method] = async () => { attempts += 1; throw new Error('Bearer private-provider-error-never-echo'); };
    const result = await publishPublication(context.operation(approval.id));
    assert.equal(result.status, 'uncertain');
    assert(!JSON.stringify(result).includes('private-provider-error'));
    assert.equal(attempts, 1);
    await assert.rejects(publishPublication(context.operation(approval.id)), invalid);
    const mutations = context.memory.calls.filter(call => call.startsWith('create')).length;
    const reconciled = await reconcilePublication(context.operation(approval.id));
    assert.equal(reconciled.status, 'uncertain');
    assert.equal(attempts, 1);
    assert.equal(context.memory.calls.filter(call => call.startsWith('create')).length, mutations);
  });
}

test('lost PR response is recovered through exact evidence without duplicate creation', async t => {
  const context = await fixture(t);
  const approval = await context.approve();
  const create = context.provider.createDraftPullRequest;
  context.provider.createDraftPullRequest = async input => { await create(input); throw new Error('response lost'); };
  assert.equal((await publishPublication(context.operation(approval.id))).status, 'uncertain');
  const calls = context.memory.calls.filter(call => call.startsWith('create')).length;
  const recovered = await reconcilePublication(context.operation(approval.id));
  assert.equal(recovered.status, 'published');
  assert.equal(recovered.pullRequest.number, 7);
  assert.equal(context.memory.calls.filter(call => call.startsWith('create')).length, calls);
  assert.equal(context.memory.prs.length, 1);
  assert.equal((await reconcilePublication(context.operation(approval.id))).status, 'published');
});

for (const state of ['closed', 'merged']) {
  test(`reconciliation recognizes a ${state} PR after source branch deletion and base advancement`, async t => {
    const context = await fixture(t);
    const approval = await context.approve();
    await publishPublication(context.operation(approval.id));
    Object.assign(context.memory.prs[0], { state, draft: false });
    context.memory.branch = null;
    context.memory.remote.headSha = oid('e');
    context.memory.remote.treeSha = oid('f');
    const before = context.memory.calls.filter(call => call.startsWith('create')).length;
    const result = await reconcilePublication(context.operation(approval.id));
    assert.equal(result.status, 'published');
    assert.equal(result.pullRequest.state, state);
    assert.equal(context.memory.calls.filter(call => call.startsWith('create')).length, before);
  });
}

test('human commits or modified PR content are not overwritten or treated as the approved publication', async t => {
  const context = await fixture(t);
  const approval = await context.approve();
  await publishPublication(context.operation(approval.id));
  const before = context.memory.calls.filter(call => call.startsWith('create')).length;
  context.memory.branch.commitSha = oid('f');
  assert.equal((await reconcilePublication(context.operation(approval.id))).status, 'conflict');
  context.memory.branch.commitSha = context.memory.commitSha;
  context.memory.prs[0].body = 'Human changed the description.';
  assert.equal((await reconcilePublication(context.operation(approval.id))).status, 'conflict');
  assert.equal(context.memory.calls.filter(call => call.startsWith('create')).length, before);
});

test('existing branch or closed PR prevents a newly approved attempt from opening duplicates', async t => {
  const context = await fixture(t);
  const first = await context.approve();
  await publishPublication(context.operation(first.id));
  const before = context.memory.calls.filter(call => call.startsWith('create')).length;
  const second = await context.approve();
  assert.equal((await publishPublication(context.operation(second.id))).status, 'conflict');
  context.memory.branch = null;
  context.memory.prs[0].state = 'closed';
  const third = await context.approve();
  assert.equal((await publishPublication(context.operation(third.id))).status, 'conflict');
  assert.equal(context.memory.calls.filter(call => call.startsWith('create')).length, before);
});

test('base advancing after immutable commit creation stops branch and PR creation', async t => {
  const context = await fixture(t);
  const approval = await context.approve();
  const create = context.provider.createCommit;
  context.provider.createCommit = async input => { const created = await create(input); context.memory.remote.headSha = oid('f'); return created; };
  const result = await publishPublication(context.operation(approval.id));
  assert.equal(result.status, 'uncertain');
  assert(!context.memory.calls.includes('createBranch'));
  assert(!context.memory.calls.includes('createDraftPullRequest'));
});

for (const phase of ['createCommit', 'createBranch']) {
  test(`a local source change during ${phase} stops subsequent publication phases`, async t => {
    const context = await fixture(t);
    const approval = await context.approve();
    const perform = context.provider[phase];
    context.provider[phase] = async input => {
      const response = await perform(input);
      await writeFile(join(context.consumerRoot, 'orders.mjs'), 'export const humanEdit = true;\n');
      return response;
    };
    assert.equal((await publishPublication(context.operation(approval.id))).status, 'uncertain');
    assert(!context.memory.calls.includes('createDraftPullRequest'));
    if (phase === 'createCommit') assert(!context.memory.calls.includes('createBranch'));
    assert.equal(await readFile(join(context.consumerRoot, 'orders.mjs'), 'utf8'), 'export const humanEdit = true;\n');
  });
}

test('approval expiring before or during a publication does not authorize later write phases', async t => {
  const context = await fixture(t);
  const start = Date.now();
  t.mock.method(Date, 'now', () => start);
  const approval = await context.approve();
  Date.now.mock.mockImplementation(() => start + 15 * 60_000);
  await assert.rejects(publishPublication(context.operation(approval.id)), invalid);
  Date.now.mock.mockImplementation(() => start);
  const next = await context.approve();
  const create = context.provider.createCommit;
  context.provider.createCommit = async input => { const created = await create(input); Date.now.mock.mockImplementation(() => start + 15 * 60_000); return created; };
  assert.equal((await publishPublication(context.operation(next.id))).status, 'uncertain');
  assert(!context.memory.calls.includes('createBranch'));
});

test('read-only reconciliation remains possible after approval expiry and local source edits', async t => {
  const context = await fixture(t);
  const approval = await context.approve();
  await publishPublication(context.operation(approval.id));
  await writeFile(join(context.consumerRoot, 'orders.mjs'), 'export const changed = true;\n');
  t.mock.method(Date, 'now', () => Date.parse(approval.expiresAt) + 1000);
  assert.equal((await reconcilePublication(context.operation(approval.id))).status, 'published');
});

test('ambiguous duplicate PR evidence is a conflict and never triggers a new write', async t => {
  const context = await fixture(t);
  const approval = await context.approve();
  await publishPublication(context.operation(approval.id));
  context.memory.prs.push({ ...context.memory.prs[0], number: 8, url: 'https://github.com/fixture-owner/fixture-repo/pull/8' });
  assert.equal((await reconcilePublication(context.operation(approval.id))).status, 'conflict');
  assert.equal(context.memory.calls.filter(call => call === 'createDraftPullRequest').length, 1);
});

test('foreign repository PRs and wrong created commit identities cannot be accepted', async t => {
  const context = await fixture(t);
  const approval = await context.approve();
  const create = context.provider.createDraftPullRequest;
  context.provider.createDraftPullRequest = async input => ({ ...await create(input), headRepositoryId: 'foreign-fork' });
  assert.equal((await publishPublication(context.operation(approval.id))).status, 'uncertain');
  context.memory.prs[0].headRepositoryId = 'foreign-fork';
  assert.equal((await reconcilePublication(context.operation(approval.id))).status, 'uncertain');
});

test('journal corruption and cross-request receipts are rejected before reconciliation reads', async t => {
  const context = await fixture(t);
  const approval = await context.approve();
  await publishPublication(context.operation(approval.id));
  const next = await context.prepare({ timestamp: '2026-10-07T10:00:00.000Z' });
  await assert.rejects(reconcilePublication({ ...context.operation(approval.id), request: next }), invalid);
  const path = join(context.statePath, 'attempts', approval.id, '02-commit.json');
  const data = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...data, requestId: hash('9') }));
  await assert.rejects(reconcilePublication(context.operation(approval.id)), invalid);
});

test('request and adapter accessors are rejected without executing them', async t => {
  const context = await fixture(t);
  let executed = 0;
  const unsafe = { ...context.candidate };
  Object.defineProperty(unsafe, 'files', { get() { executed += 1; return []; }, enumerable: true });
  await assert.rejects(context.prepare({ candidate: unsafe }), invalid);
  const provider = { ...context.provider };
  Object.defineProperty(provider, 'readSnapshot', { get() { executed += 1; return async () => context.memory.remote; }, enumerable: true });
  await assert.rejects(context.prepare({ adapter: provider }), invalid);
  assert.equal(executed, 0);
});

test('an attempt keeps its journal even when an adapter never provided a complete commit response', async t => {
  const context = await fixture(t);
  const approval = await context.approve();
  context.provider.createCommit = async () => { throw new Error('transport disconnected'); };
  await publishPublication(context.operation(approval.id));
  const entries = await readdir(join(context.statePath, 'attempts', approval.id));
  assert(entries.includes('marker.json'));
  assert(entries.includes('publication.json'));
  assert(entries.includes('01-commit-intent.json'));
  assert(entries.includes('result.json'));
  assert(!entries.includes('02-commit.json'));
});

for (const loseResponse of [false, true]) {
  test(`runner composes with the bounded GitHub REST adapter using only an in-memory transport${loseResponse ? ' and reconciles a lost response' : ''}`, async t => {
    const context = await fixture(t);
    const routes = [];
    let branchSha = null;
    const prs = [];
    const destination = '/repos/fixture-owner/fixture-repo';
    const provider = createGitHubPublicationAdapter({
      mode: 'simulation', getToken: () => 'FICTIONAL_FIXTURE_TOKEN',
      transport: async (url, options) => {
        assert.equal(url.origin, 'https://api.github.com');
        assert.equal(options.redirect, 'error');
        assert.equal(options.headers.Authorization, 'Bearer FICTIONAL_FIXTURE_TOKEN');
        const path = decodeURIComponent(url.pathname);
        const method = options.method;
        const body = options.body ? JSON.parse(options.body) : undefined;
        routes.push({ method, path });
        let value;
        let status = 200;
        if (method === 'GET' && path === destination) value = { id: 123, owner: { login: 'fixture-owner' }, name: 'fixture-repo', private: true, fork: false, archived: false, disabled: false, permissions: { push: true } };
        else if (method === 'GET' && path === `${destination}/git/ref/heads/main`) value = { ref: 'refs/heads/main', object: { type: 'commit', sha: context.candidate.git.headSha } };
        else if (method === 'GET' && path === `${destination}/git/ref/heads/${context.candidate.headBranch}`) {
          if (branchSha === null) { status = 404; value = {}; }
          else value = { ref: `refs/heads/${context.candidate.headBranch}`, object: { type: 'commit', sha: branchSha } };
        } else if (method === 'GET' && path === `${destination}/git/commits/${context.candidate.git.headSha}`) value = { sha: context.candidate.git.headSha, tree: { sha: context.candidate.git.treeSha } };
        else if (method === 'GET' && path === `${destination}/git/trees/${context.candidate.git.treeSha}`) value = {
          sha: context.candidate.git.treeSha, truncated: false,
          tree: [{ path: 'orders.mjs', type: 'blob', mode: '100644', sha: context.candidate.files[0].gitBlobId }],
        };
        else if (method === 'POST' && path === `${destination}/git/blobs`) {
          const content = Buffer.from(body.content, 'base64');
          assert.equal(content.toString('utf8'), context.candidate.files[0].after);
          value = { sha: createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex') };
        } else if (method === 'POST' && path === `${destination}/git/trees`) value = { sha: context.memory.treeSha };
        else if (method === 'POST' && path === `${destination}/git/commits`) value = {
          sha: context.memory.commitSha, tree: { sha: context.memory.treeSha }, parents: [{ sha: context.candidate.git.headSha }],
          message: body.message, author: body.author, committer: body.committer,
        };
        else if (method === 'POST' && path === `${destination}/git/refs`) {
          assert.equal(branchSha, null);
          branchSha = body.sha;
          value = { ref: body.ref, object: { type: 'commit', sha: branchSha } };
        } else if (method === 'GET' && path === `${destination}/pulls`) {
          assert.equal(url.searchParams.get('state'), 'all');
          value = prs;
        } else if (method === 'POST' && path === `${destination}/pulls`) {
          assert.equal(body.draft, true);
          value = { number: 7, html_url: 'https://github.com/fixture-owner/fixture-repo/pull/7', state: 'open', draft: true, merged_at: null,
            title: body.title, body: body.body, head: { ref: body.head, sha: branchSha, repo: { id: 123 } }, base: { ref: body.base, repo: { id: 123 } } };
          prs.push(value);
          if (loseResponse) throw new Error('Simulated connection loss after remote acceptance.');
        } else throw new Error(`Unexpected simulated REST route ${method} ${path}`);
        return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
      },
    });
    const request = await context.prepare({ adapter: provider });
    const approval = await context.approve({ request, expectedRequestId: request.id });
    const input = { ...context.operation(approval.id), request, adapter: provider };
    const published = await publishPublication(input);
    assert.equal(published.status, loseResponse ? 'uncertain' : 'published');
    assert.equal(published.mode, 'simulation');
    assert.equal(prs.length, 1);
    assert.equal(routes.filter(route => route.method === 'POST').length, 5);
    const before = routes.filter(route => route.method === 'POST').length;
    assert.equal((await reconcilePublication(input)).status, 'published');
    assert.equal(routes.filter(route => route.method === 'POST').length, before);
    assert.equal(await readFile(join(context.consumerRoot, 'orders.mjs'), 'utf8'), context.candidate.files[0].before);
  });
}
