import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { before, test } from 'node:test';
import { approveJobValidation, approveModelProposal, approvePublicationRequest, prepareJobProposal,
  prepareJobPublicationCandidate, prepareJobValidation, preparePublicationRequest, proposeJobMigration,
  publishPublication, queueJobValidation, runApprovedJobsOnce } from '../dist/index.js';
import { DOCKER_PROFILE } from '../dist/docker-runner.js';
import { fixture, controlledModel, enginePath } from '../test/helpers/job-proposal.mjs';

const execute = promisify(execFile);
const commandOptions = { shell: false, windowsHide: true, timeout: 15_000, maxBuffer: 128 * 1024, encoding: 'utf8' };
let gitPath;
before(async () => {
  assert.equal(process.platform, 'linux', 'This acceptance requires the dedicated Linux Docker validation profile.');
  gitPath = await realpath('/usr/bin/git');
  await execute(DOCKER_PROFILE.executable, ['--host', DOCKER_PROFILE.endpoint, 'image', 'inspect', DOCKER_PROFILE.image], commandOptions);
});

async function git(consumer, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Controlled workflow fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Controlled workflow fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' });
  return (await execute(gitPath, ['-c', 'core.autocrlf=false', '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=', '-C', consumer, ...args],
    { ...commandOptions, env })).stdout.trim();
}

/** Only publication is simulated: these methods never contact GitHub or create a remote PR. */
function simulatedPublication(candidate) {
  const snapshot = { repositoryId: 'controlled-workflow', owner: 'fixture-owner', name: 'fixture-repo', private: true,
    baseBranch: 'main', headSha: candidate.git.headSha, treeSha: candidate.git.treeSha };
  const writes = [];
  const prs = [];
  let branch = null;
  const adapter = {
    id: 'controlled-workflow', host: 'github.com', mode: 'simulation',
    readSnapshot: async () => structuredClone(snapshot),
    readBranch: async () => structuredClone(branch),
    findPullRequests: async () => structuredClone(prs),
    createCommit: async input => {
      writes.push('commit');
      assert.equal(input.parentSha, candidate.git.headSha);
      assert.deepEqual(input.files, candidate.files.map(file => ({ path: file.path, mode: file.mode, content: file.after, beforeBlobId: file.gitBlobId })));
      return { commitSha: 'c'.repeat(40), treeSha: 'd'.repeat(40) };
    },
    createBranch: async input => { writes.push('branch'); assert.equal(branch, null); branch = { commitSha: input.commitSha }; },
    createDraftPullRequest: async input => {
      writes.push('draft');
      const pr = { repositoryId: snapshot.repositoryId, headRepositoryId: snapshot.repositoryId, number: 1,
        url: 'https://github.com/fixture-owner/fixture-repo/pull/1', state: 'open', draft: true,
        headSha: branch.commitSha, headBranch: input.headBranch, baseBranch: input.baseBranch, title: input.title, body: input.body };
      prs.push(pr);
      return structuredClone(pr);
    },
  };
  return { adapter, writes, prs };
}

test('observed job → controlled model HTTP proposal → reviewer decisions → real Docker tests → separately approved simulated draft PR', { timeout: 120_000 }, async t => {
  const f = await fixture(t, async consumer => {
    await git(consumer, ['init', '--object-format=sha1', '--initial-branch=main', '--template=']);
    await git(consumer, ['add', '--all']);
    await git(consumer, ['commit', '-m', 'Controlled consumer before provider change']);
  });
  const beforeSource = await readFile(join(f.consumerRoot, 'orders.mjs'));
  const beforeTests = await readFile(join(f.consumerRoot, 'orders.test.mjs'));
  const beforeHead = await git(f.consumerRoot, ['rev-parse', 'HEAD']);
  const model = await controlledModel(t, f.recipe);
  const request = await prepareJobProposal({ ...f.input, adapter: model.adapter });
  assert.equal(model.calls.length, 0);
  assert.deepEqual(request.discovery.sourcePaths, ['orders.mjs']);
  const consent = approveModelProposal({ request: request.modelRequest, expectedRequestId: request.modelRequest.id });
  const proposal = await proposeJobMigration({ request, expectedRequestId: request.id, consent, adapter: model.adapter });
  assert.equal(model.calls.length, 1);
  assert.equal(proposal.status, 'proposal-ready');
  assert.equal(proposal.preview.status, 'requires-decision');
  assert.equal(proposal.validation, 'not-run');
  const answers = new Map(f.reference.decisions.map(decision => [decision.id, decision.answer]));
  // This trusted fixture reviewer explicitly supplies semantics. The deterministic model cannot approve them.
  const recipe = { ...proposal.recipe, decisions: proposal.recipe.decisions.map(decision => ({ ...decision,
    answer: answers.get(decision.id) ?? 'The controlled fixture reviewer checked the supplied API contracts and existing application model.' })) };
  const input = { statePath: f.statePath, jobId: f.jobId, enginePath, recipe, testPaths: proposal.testPaths };
  const validation = await prepareJobValidation(input);
  const approval = await approveJobValidation({ ...input, expectedRequestId: validation.id, origin: 'explicit-sdk-caller' });
  const { intent } = await queueJobValidation({ ...input, receiptId: approval.id });
  const execution = await runApprovedJobsOnce({ statePath: f.statePath, enginePath, intentId: intent.id });
  assert.equal(execution.results[0].status, 'completed', JSON.stringify(execution));
  const outcome = execution.results[0].outcome;
  assert.equal(outcome.status, 'improved', JSON.stringify(outcome));
  assert.equal(outcome.baseline.status, 'failed');
  assert.equal(outcome.baseline.exitCode, 1);
  assert.equal(outcome.candidate.status, 'passed');
  assert.equal(outcome.candidate.exitCode, 0);
  assert.equal(outcome.baseline.cleanup, 'removed');
  assert.equal(outcome.candidate.cleanup, 'removed');
  const candidate = await prepareJobPublicationCandidate({ statePath: f.statePath, intentId: intent.id, enginePath, gitPath,
    repository: 'fixture-owner/fixture-repo', baseBranch: 'main' });
  const remote = simulatedPublication(candidate);
  const publication = await preparePublicationRequest({ candidate, adapter: remote.adapter,
    author: { name: 'Controlled workflow fixture', email: 'fixture@example.invalid' } });
  const operation = { request: publication, statePath: f.statePath, consumerRoot: f.consumerRoot, adapter: remote.adapter };
  await assert.rejects(publishPublication({ ...operation, receiptId: approval.id }), { code: 'INVALID_INPUT' });
  assert.deepEqual(remote.writes, [], 'Validation approval cannot publish.');
  const publicationApproval = await approvePublicationRequest({ request: publication, expectedRequestId: publication.id,
    statePath: f.statePath, consumerRoot: f.consumerRoot, origin: 'explicit-sdk-caller' });
  const published = await publishPublication({ ...operation, receiptId: publicationApproval.id });
  assert.equal(published.status, 'published');
  assert.equal(published.mode, 'simulation');
  assert.equal(published.pullRequest.draft, true);
  assert.deepEqual(remote.writes, ['commit', 'branch', 'draft']);
  await assert.rejects(publishPublication({ ...operation, receiptId: publicationApproval.id }), { code: 'INVALID_INPUT' });
  assert.equal(remote.prs.length, 1);
  assert.deepEqual(await readFile(join(f.consumerRoot, 'orders.mjs')), beforeSource);
  assert.deepEqual(await readFile(join(f.consumerRoot, 'orders.test.mjs')), beforeTests);
  assert.equal(await git(f.consumerRoot, ['rev-parse', 'HEAD']), beforeHead);
  assert.equal(await git(f.consumerRoot, ['status', '--porcelain']), '');
});
