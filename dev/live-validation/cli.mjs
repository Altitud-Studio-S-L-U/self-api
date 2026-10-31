import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareJobValidation, approveJobValidation, queueJobValidation, runApprovedJobsOnce,
  prepareJobPublicationCandidate, preparePublicationRequest, approvePublicationRequest,
  publishPublication, reconcilePublication, createGitHubPublicationAdapter } from 'self-managed-api';
import { runCli } from 'self-managed-api/cli';
import { seedPilot, openPilot, observePilot, validationInput, repository, baseBranch, enginePath } from './environment.mjs';
import { captureGitHub } from './capture.mjs';

const [command, root, argument, ...extra] = process.argv.slice(2);
const arities = { seed: 1, observe: 0, plan: 0, validate: 1, 'model-plan': 1, 'model-propose': 2, 'model-review': 1,
  'model-validation-plan': 0, 'model-validate': 1, candidate: 1, review: 0, publish: 1, reconcile: 1, 'verify-live': 1 };
const output = value => console.log(JSON.stringify(value, null, 2));
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const load = async path => JSON.parse(await readFile(path, 'utf8'));
const adapter = () => createGitHubPublicationAdapter({ getToken: () => {
  assert(process.env.GH_TOKEN, 'Inject GH_TOKEN from the approved secret manager; never put it in arguments or files');
  return process.env.GH_TOKEN;
} });
try {
  assert(root && Object.hasOwn(arities, command) && Number(argument !== undefined) + extra.length === arities[command],
    'Usage: node dev/live-validation/cli.mjs <seed|observe|plan|validate|model-plan|model-propose|model-review|model-validation-plan|model-validate|candidate|review|publish|reconcile|verify-live> <owned-root> [arguments]');
  if (command === 'seed') { output(await seedPilot(root, argument)); }
  else {
    const paths = await openPilot(root);
    if (command === 'observe') {
      const { subscription, cycle, job } = await observePilot(paths);
      output({ subscriptionId: subscription.id, jobId: job.id, cycle, comparison: job.report.comparison.status,
        changes: job.report.comparison.changes.map(change => ({ id: change.id, text: change.text })), authorization: 'not-granted' });
    } else if (command === 'model-plan' || command === 'model-propose') {
      const { job } = await observePilot(paths), propose = command === 'model-propose';
      process.exitCode = await runCli([propose ? 'job-propose' : 'job-proposal-plan', job.id,
        '--state', paths.state, '--engine', enginePath, '--model', propose ? extra[0] : argument,
        '--source', 'github-contents.mjs', '--test', 'github-contents.test.mjs', '--evidence', join(paths.root, 'provider-evidence.txt'), '--timeout-ms', '120000',
        ...(propose ? ['--output', 'model-proposal.json'] : [])], {
        confirm: async requestId => { assert.equal(argument, requestId, 'Inspect this exact model request before one-use consent'); return true; },
      });
    } else if (command === 'model-review') {
      process.exitCode = await runCli(['job-review', '--state', paths.state, '--engine', enginePath,
        '--proposal', join(paths.state, 'proposals/model-proposal.json'), '--answers', argument,
        '--output', 'model-reviewed-recipe.json', '--json']);
    } else if (['plan', 'validate', 'model-validation-plan', 'model-validate'].includes(command)) {
      const generated = command.startsWith('model-');
      const input = await validationInput(paths, generated ? join(paths.state, 'proposals/model-reviewed-recipe.json') : undefined);
      const request = await prepareJobValidation(input);
      if (command === 'plan' || command === 'model-validation-plan') output(request);
      else {
        assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64');
        assert.equal(argument, request.id, 'Review the exact current plan before approval');
        const receipt = await approveJobValidation({ ...input, expectedRequestId: request.id, origin: 'explicit-sdk-caller' });
        const queued = await queueJobValidation({ ...input, receiptId: receipt.id });
        const result = await runApprovedJobsOnce({ statePath: paths.state, enginePath, intentId: queued.intent.id });
        await save(join(paths.root, 'validation.json'), { result, intentId: queued.intent.id, requestId: request.id });
        const outcome = result.results[0]?.outcome;
        output({ intentId: queued.intent.id, status: result.results[0]?.status, outcome: outcome?.status,
          baseline: outcome?.baseline.status, candidate: outcome?.candidate?.status, consumerModified: false });
        assert.equal(outcome?.status, 'improved', 'The live-capture baseline must fail and the approved candidate pass');
      }
    } else if (command === 'candidate') {
      const candidate = await prepareJobPublicationCandidate({ statePath: paths.state, intentId: argument,
        gitPath: process.env.SELF_MANAGED_API_GIT ?? '/usr/bin/git', enginePath, repository, baseBranch });
      await save(join(paths.root, 'candidate.json'), candidate);
      output({ candidateId: candidate.id, base: baseBranch, head: candidate.headBranch, files: candidate.files.map(file => file.path), authorization: candidate.authorization });
    } else if (command === 'review') {
      const candidate = await load(join(paths.root, 'candidate.json'));
      const request = await preparePublicationRequest({ candidate, adapter: adapter(),
        author: { name: 'SelfManagedApi live validation', email: 'self-managed-api-pilot@example.invalid' } });
      await save(join(paths.root, 'publication-request.json'), request);
      output({ requestId: request.id, destination: request.snapshot, head: candidate.headBranch,
        files: candidate.files.map(file => ({ path: file.path, before: file.before, after: file.after })), draft: true });
    } else if (command === 'publish' || command === 'reconcile') {
      const request = await load(join(paths.root, 'publication-request.json'));
      assert.equal(argument, request.id, 'Review the exact publication request before sending code');
      assert.equal(request.snapshot.owner + '/' + request.snapshot.name, repository);
      assert.equal(request.snapshot.baseBranch, baseBranch);
      const approvalPath = join(paths.root, 'publication-approval.json');
      const receipt = command === 'publish'
        ? await approvePublicationRequest({ request, expectedRequestId: request.id, statePath: paths.state, consumerRoot: paths.consumer, origin: 'explicit-sdk-caller' })
        : await load(approvalPath);
      if (command === 'publish') await save(approvalPath, receipt);
      const options = { request, receiptId: receipt.id, statePath: paths.state, consumerRoot: paths.consumer, adapter: adapter() };
      const result = await (command === 'publish' ? publishPublication : reconcilePublication)(options);
      await save(join(paths.root, command + '-result.json'), result);
      output(result);
      assert.equal(result.status, 'published', 'Preserve this attempt and reconcile uncertain results; never retry publication blindly');
    } else if (command === 'verify-live') {
      const candidate = await load(join(paths.root, 'candidate.json'));
      assert.equal(argument, candidate.id);
      const file = candidate.files.find(file => file.path === 'github-contents.mjs');
      assert(file);
      const candidatePath = join(paths.root, 'approved-candidate.mjs');
      await writeFile(candidatePath, file.after, { flag: 'wx', mode: 0o600 });
      const { parseEntries } = await import(pathToFileURL(candidatePath).href);
      const observation = await captureGitHub('/repos/git/git/contents?ref=master', '2026-03-10');
      const entries = parseEntries(observation.body), entry = entries.find(value => value.path === 'sha1collisiondetection');
      assert(entry && entry.directory === false && entry.downloadable === false);
      await save(join(paths.root, 'live-verification.json'), { source: observation.evidence, entries: entries.length, submodule: entry, candidateId: candidate.id });
      output({ candidateId: candidate.id, source: 'live-github-2026', entries: entries.length, submodule: entry, outcome: 'passed' });
    }
  }
} catch (error) {
  // Never print nested transport objects or environment values.
  console.error(error instanceof Error ? error.message : 'Pilot failed'); process.exitCode = 2;
}
