import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { registerLocalSubscription, observeOnce, prepareJobValidation, approveJobValidation, queueJobValidation,
  runApprovedJobsOnce, prepareJobPublicationCandidate, preparePublicationRequest, approvePublicationRequest, publishPublication } from 'keepseam-client';

assert.equal(process.platform, 'linux', 'Record with the supported Linux Docker host.');
const repositoryRoot = resolve(import.meta.dirname, '../..');
const run = promisify(execFile);
const fixtureRoot = join(repositoryRoot, 'fixtures/payments');
const parent = join(repositoryRoot, 'work/terminal-demo');
await mkdir(parent, { recursive: true, mode: 0o700 });
const directory = await mkdtemp(join(await realpath(parent), 'record-'));
const consumerRoot = join(directory, 'consumer'), statePath = join(directory, 'state');
await cp(join(fixtureRoot, 'consumer'), consumerRoot, { recursive: true });
await mkdir(statePath, { mode: 0o700 });
const git = args => run('/usr/bin/git', args, { cwd: consumerRoot, timeout: 10_000, maxBuffer: 256_000 });
await git(['init', '-b', 'feat/demo-base']);
await git(['add', '--', 'payments.mjs', 'payments-v1.test.mjs', 'payments-v2.test.mjs']);
await git(['-c','user.name=Keepseam demo','-c','user.email=demo@example.invalid','commit','-m','Add fictional payments consumer']);
const enginePath = join(repositoryRoot, 'work/tools/oasdiff/oasdiff');
const subscription = await registerLocalSubscription({ statePath, enginePath, consumerRoot,
  sourcePath: join(fixtureRoot, 'payments-v2.json'), baselinePath: join(fixtureRoot, 'payments-v1.json'), providerBaseUrl: 'http://127.0.0.1:43127' });
const observation = await observeOnce({ statePath, enginePath, subscriptionId: subscription.id });
const jobId = observation.results[0].jobId;
assert(jobId);
const recipe = JSON.parse(await readFile(join(fixtureRoot, 'payment-recipe.json'), 'utf8'));
const input = { statePath, enginePath, jobId, recipe, testPaths: ['payments-v2.test.mjs'] };
const request = await prepareJobValidation(input);
assert.equal(request.plan.impact.comparison.status, 'breaking-changes');
assert.equal(request.plan.authorization, 'not-granted');
const matched = new Set(request.plan.impact.matches.flatMap(match => match.callIds));
assert(request.plan.impact.inventory.calls.some(call => call.location.file === 'payments.mjs' && matched.has(call.id)));
assert.deepEqual(request.plan.files.map(file => file.path), ['payments.mjs']);
const approval = await approveJobValidation({ ...input, expectedRequestId: request.id, origin: 'explicit-sdk-caller' });
const queued = await queueJobValidation({ ...input, receiptId: approval.id });
const validation = await runApprovedJobsOnce({ statePath, enginePath, intentId: queued.intent.id });
const outcome = validation.results[0].outcome;
assert.equal(outcome.status, 'improved'); assert.equal(outcome.baseline.status, 'failed'); assert.equal(outcome.candidate.status, 'passed');
const result = JSON.parse(await readFile(join(statePath, 'attempts', approval.id, 'result.json'), 'utf8'));
const tests = Number(result.candidate.stdout.match(/# tests (\d+)/u)[1]);
assert.equal(tests, 25); assert.match(result.candidate.stdout, /# fail 0/u);
const candidate = await prepareJobPublicationCandidate({ statePath, enginePath, intentId: queued.intent.id, gitPath: '/usr/bin/git',
  repository: 'keepseam-demo/payments-api', baseBranch: 'feat/demo-base' });
const snapshot = { repositoryId: '1', owner: candidate.destination.owner, name: candidate.destination.name, private: true,
  baseBranch: candidate.destination.baseBranch, headSha: candidate.git.headSha, treeSha: candidate.git.treeSha };
const branches = new Map(), prs = [], writes = [];
// This adapter is deliberately simulated. Publication approvals and the SDK
// publisher execute normally, but no customer credential or GitHub write is used.
const adapter = { id: 'terminal-demo', host: 'github.com', mode: 'simulation',
  readSnapshot: async () => snapshot,
  readBranch: async ({ branch }) => branches.has(branch) ? { commitSha: branches.get(branch) } : null,
  findPullRequests: async () => structuredClone(prs),
  createCommit: async input => { writes.push('commit'); return { commitSha: createHash('sha1').update(JSON.stringify(input)).digest('hex'), treeSha: createHash('sha1').update(JSON.stringify(input.files)).digest('hex') }; },
  createBranch: async input => { assert(!branches.has(input.branch)); writes.push('branch'); branches.set(input.branch, input.commitSha); },
  createDraftPullRequest: async input => { writes.push('draft-pr'); const pr = { repositoryId: '1', headRepositoryId: '1', number: 1,
    url: 'https://github.com/keepseam-demo/payments-api/pull/1', state: 'open', draft: true, headSha: input.commitSha,
    headBranch: input.headBranch, baseBranch: input.baseBranch, title: input.title, body: input.body }; prs.push(pr); return pr; },
};
const publicationRequest = await preparePublicationRequest({ candidate, adapter, author: { name: 'Keepseam demo', email: 'demo@example.invalid' } });
const publicationApproval = await approvePublicationRequest({ request: publicationRequest, expectedRequestId: publicationRequest.id, statePath, consumerRoot, origin: 'explicit-sdk-caller' });
const publication = await publishPublication({ request: publicationRequest, receiptId: publicationApproval.id, statePath, consumerRoot, adapter });
assert.equal(publication.status, 'published'); assert.equal(publication.mode, 'simulation'); assert.equal(publication.pullRequest.draft, true);
assert.deepEqual(writes, ['commit','branch','draft-pr']);
assert.equal(await readFile(join(consumerRoot, 'payments.mjs'), 'utf8'), request.plan.files[0].before);
assert.equal((await git(['status', '--porcelain'])).stdout, '');
const record = { schemaVersion: 1, sdkVersion: JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8')).version,
  recordedAt: new Date().toISOString(), provider: 'fictional-payments', source: 'local-contract-snapshots', recipe: 'explicit-reviewed-recipe',
  publicationMode: publication.mode, changes: request.plan.impact.comparison.changes.map(change => ({ id: change.id, text: change.text })),
  files: request.plan.files.map(file => ({ path: file.path, before: file.before, after: file.after })),
  validation: { status: outcome.status, baseline: outcome.baseline.status, candidate: outcome.candidate.status, tests, failed: 0, testsUnchanged: true },
  publication: { status: publication.status, draft: publication.pullRequest.draft, branch: publication.pullRequest.headBranch,
    title: publication.pullRequest.title, writes }, consumerModified: false };
await writeFile(join(directory, 'public-replay.json'), JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ directory, tests, validation: outcome.status, publication: publication.mode, record: join(directory, 'public-replay.json') }));
