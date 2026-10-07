import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createGitHubPublicationAdapter } from '../dist/github-publication.js';

const H = 'a'.repeat(40), T = 'b'.repeat(40), N = 'c'.repeat(40), NT = 'd'.repeat(40), ST = 'e'.repeat(40);
const before = 'export const value = 1;\n', after = 'export const value = 2;\n';
const blob = content => createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest('hex');
const snapshot = { repositoryId: '123', owner: 'fixture', name: 'consumer', private: true, baseBranch: 'main', headSha: H, treeSha: T };
const branch = 'feat/api-0123456789ab';
const expiry = () => new Date(Date.now() + 60_000).toISOString();
const commitInput = () => ({ snapshot, parentSha: H, baseTreeSha: T, files: [{ path: 'src/client.ts', mode: '100644', content: after, beforeBlobId: blob(before) }],
  author: { name: 'Fixture Author', email: 'fixture@example.invalid' }, timestamp: '2026-10-07T12:00:00.000Z', message: 'Fixture update', requestId: 'f'.repeat(64), expiresAt: expiry() });
function fixture() {
  const state = {
    repository: { id: 123, owner: { login: 'fixture' }, name: 'consumer', private: true, fork: false, archived: false, disabled: false, permissions: { push: true } },
    baseSha: H, branchSha: null, prs: [], calls: [], mutateResponse: value => value,
    root: { sha: T, truncated: false, tree: [{ path: 'src', mode: '040000', type: 'tree', sha: ST }] },
    subtree: { sha: ST, truncated: false, tree: [{ path: 'client.ts', mode: '100644', type: 'blob', sha: blob(before) }] },
  };
  state.pr = (overrides = {}) => ({ number: 7, html_url: 'https://github.com/fixture/consumer/pull/7', state: 'open', merged_at: null, draft: true,
    title: 'Fixture PR', body: 'Reviewed fixture', base: { ref: 'main', repo: { id: 123 } }, head: { ref: branch, sha: N, repo: { id: 123 } }, ...overrides });
  const transport = async (url, options) => {
    const path = decodeURIComponent(url.pathname), method = options.method;
    const body = options.body ? JSON.parse(options.body) : undefined;
    state.calls.push({ path, method, body, search: url.search });
    let result;
    let status = 200;
    if (method === 'GET' && path === '/repos/fixture/consumer') result = state.repository;
    else if (method === 'GET' && path.endsWith('/git/ref/heads/main')) result = { ref: 'refs/heads/main', object: { type: 'commit', sha: state.baseSha } };
    else if (method === 'GET' && path.endsWith(`/git/ref/heads/${branch}`)) {
      if (state.branchSha) result = { ref: `refs/heads/${branch}`, object: { type: 'commit', sha: state.branchSha } };
      else { result = {}; status = 404; }
    } else if (method === 'GET' && path.endsWith(`/git/commits/${H}`)) result = { sha: H, tree: { sha: T } };
    else if (method === 'GET' && path.endsWith(`/git/trees/${T}`)) result = state.root;
    else if (method === 'GET' && path.endsWith(`/git/trees/${ST}`)) result = state.subtree;
    else if (method === 'POST' && path.endsWith('/git/blobs')) result = { sha: blob(Buffer.from(body.content, 'base64').toString('utf8')) };
    else if (method === 'POST' && path.endsWith('/git/trees')) result = { sha: NT };
    else if (method === 'POST' && path.endsWith('/git/commits')) result = { sha: N, tree: { sha: NT }, parents: [{ sha: H }], author: body.author, committer: body.committer, message: body.message };
    else if (method === 'POST' && path.endsWith('/git/refs')) {
      if (state.branchSha !== null) { result = {}; status = 422; }
      else { state.branchSha = body.sha; result = { ref: body.ref, object: { type: 'commit', sha: body.sha } }; }
    } else if (method === 'POST' && path.endsWith('/pulls')) { result = state.pr({ title: body.title, body: body.body }); state.prs.push(result); }
    else if (method === 'GET' && path.endsWith('/pulls')) result = state.prs;
    else throw new Error(`Unexpected fixture request ${method} ${path}`);
    return new Response(JSON.stringify(state.mutateResponse(result, { path, method, body })), { status, headers: { 'content-type': 'application/json' } });
  };
  const adapter = createGitHubPublicationAdapter({ getToken: () => 'FICTIONAL_TEST_TOKEN', transport, mode: 'simulation' });
  return { state, adapter };
}

test('GitHub adapter construction is inert and simulated mode requires an explicit transport', () => {
  let calls = 0;
  const adapter = createGitHubPublicationAdapter({ getToken: () => { calls++; return 'token'; } });
  assert.equal(adapter.mode, 'live'); assert.equal(calls, 0);
  assert.throws(() => createGitHubPublicationAdapter({ getToken: () => 'token', mode: 'simulation' }), { code: 'INVALID_INPUT' });
});
test('snapshot binds the private writable repository and exact base commit/tree using reads only', async () => {
  const { state, adapter } = fixture();
  assert.deepEqual(await adapter.readSnapshot({ host: 'github.com', owner: 'fixture', name: 'consumer', baseBranch: 'main', verified: false }), snapshot);
  assert.equal(state.calls.length, 3);
  assert(state.calls.every(call => call.method === 'GET'));
});
test('public, read-only, forked, archived, disabled and renamed destinations cannot receive writes', async () => {
  for (const changes of [{ private: false }, { fork: true }, { archived: true }, { disabled: true }, { permissions: { push: false } }, { name: 'different' }, { id: 0 }]) {
    const { state, adapter } = fixture(); Object.assign(state.repository, changes);
    await assert.rejects(adapter.createCommit(commitInput()), { code: 'ENGINE_FAILED' });
    assert(state.calls.every(call => call.method === 'GET'));
  }
});
test('immutable objects preserve reviewed bytes, modes, identity, timestamp and ancestry', async () => {
  const { state, adapter } = fixture();
  assert.deepEqual(await adapter.createCommit(commitInput()), { commitSha: N, treeSha: NT });
  const writes = state.calls.filter(call => call.method === 'POST');
  assert.equal(writes.length, 3);
  assert.equal(Buffer.from(writes[0].body.content, 'base64').toString('utf8'), after);
  assert.deepEqual(writes[1].body, { base_tree: T, tree: [{ path: 'src/client.ts', mode: '100644', type: 'blob', sha: blob(after) }] });
  assert.deepEqual(writes[2].body.parents, [H]);
  assert.deepEqual(writes[2].body.author, { name: 'Fixture Author', email: 'fixture@example.invalid', date: '2026-10-07T12:00:00.000Z' });
  assert.deepEqual(writes[2].body.committer, writes[2].body.author);
});
test('truncated trees, changed blobs and paths crossing a symlink fail before source upload', async () => {
  for (const mutate of [s => { s.root.truncated = true; }, s => { s.subtree.tree[0].sha = H; }, s => { s.root.tree[0].mode = '120000'; s.root.tree[0].type = 'blob'; }]) {
    const { state, adapter } = fixture(); mutate(state);
    await assert.rejects(adapter.createCommit(commitInput()), { code: 'ENGINE_FAILED' });
    assert(state.calls.every(call => call.method === 'GET'));
  }
});
test('base drift, repo replacement and expired approval stop every publication phase before writing', async () => {
  for (const mutate of [s => { s.baseSha = N; }, s => { s.repository.id = 456; }]) {
    const { state, adapter } = fixture(); mutate(state);
    await assert.rejects(adapter.createCommit(commitInput()), { code: 'ENGINE_FAILED' });
    await assert.rejects(adapter.createBranch({ snapshot, branch, commitSha: N, requestId: 'f'.repeat(64), expiresAt: expiry() }), { code: 'ENGINE_FAILED' });
    assert(state.calls.every(call => call.method === 'GET'));
  }
  const { state, adapter } = fixture();
  await assert.rejects(adapter.createCommit({ ...commitInput(), expiresAt: '2000-01-01T00:00:00.000Z' }), /authorization expired/u);
  assert(state.calls.every(call => call.method === 'GET'));
});
test('branch writes are create-only and an existing human commit is preserved without retries', async () => {
  const { state, adapter } = fixture();
  const input = { snapshot, branch, commitSha: N, requestId: 'f'.repeat(64), expiresAt: expiry() };
  await adapter.createBranch(input);
  assert.equal(state.branchSha, N);
  state.branchSha = H;
  await assert.rejects(adapter.createBranch(input), /HTTP 422/u);
  assert.equal(state.branchSha, H);
  assert.equal(state.calls.filter(call => call.method === 'POST').length, 2);
  assert(state.calls.every(call => !['PATCH', 'DELETE', 'PUT'].includes(call.method)));
});
test('pull requests remain drafts and reconciliation includes closed and merged requests', async () => {
  const { state, adapter } = fixture();
  state.branchSha = N;
  const input = { snapshot, baseBranch: 'main', headBranch: branch, commitSha: N, title: 'Fixture PR', body: 'Reviewed fixture', requestId: 'f'.repeat(64), expiresAt: expiry() };
  const created = await adapter.createDraftPullRequest(input);
  assert.equal(created.draft, true);
  const post = state.calls.find(call => call.method === 'POST');
  assert.equal(post.body.draft, true); assert.equal(post.body.maintainer_can_modify, false);
  state.prs = [state.pr({ state: 'closed', merged_at: '2026-10-07T12:01:00Z' })];
  const [found] = await adapter.findPullRequests(input);
  assert.equal(found.state, 'merged');
  assert.match(state.calls.at(-1).search, /state=all/u);
  assert.equal(state.calls.filter(call => call.method === 'POST').length, 1);
});
test('unexpected blob content and pull requests from another repository cannot establish publication success', async () => {
  const { state, adapter } = fixture();
  state.mutateResponse = (value, call) => call.path.endsWith('/git/blobs') ? { sha: H } : value;
  await assert.rejects(adapter.createCommit(commitInput()), /approved content/u);
  assert.equal(state.calls.filter(call => call.method === 'POST').length, 1);
  state.prs = [state.pr({ head: { ref: branch, sha: N, repo: { id: 456 } } })];
  await assert.rejects(adapter.findPullRequests({ snapshot, baseBranch: 'main', headBranch: branch }), /identity/u);
});
test('pagination inconsistencies cannot be interpreted as absence', async () => {
  const { state, adapter } = fixture();
  state.prs = [state.pr(), state.pr()];
  await assert.rejects(adapter.findPullRequests({ snapshot, baseBranch: 'main', headBranch: branch }), /inconsistent/u);
});
test('changed commit identity or message cannot establish a reviewed commit', async () => {
  for (const mutate of [value => ({ ...value, author: { ...value.author, email: 'different@example.invalid' } }),
    value => ({ ...value, committer: { ...value.committer, date: '2000-01-01T00:00:00Z' } }), value => ({ ...value, message: 'Different message' })]) {
    const { state, adapter } = fixture();
    state.mutateResponse = (value, call) => call.method === 'POST' && call.path.endsWith('/git/commits') ? mutate(value) : value;
    await assert.rejects(adapter.createCommit(commitInput()), /unexpected/u);
    assert.equal(state.branchSha, null);
  }
});
test('a human branch update stops PR creation and remains intact', async () => {
  const { state, adapter } = fixture(); state.branchSha = H;
  await assert.rejects(adapter.createDraftPullRequest({ snapshot, baseBranch: 'main', headBranch: branch, commitSha: N,
    title: 'Fixture PR', body: 'Reviewed fixture', requestId: 'f'.repeat(64), expiresAt: expiry() }), /branch changed/u);
  assert.equal(state.branchSha, H);
  assert(state.calls.every(call => call.method === 'GET'));
});
