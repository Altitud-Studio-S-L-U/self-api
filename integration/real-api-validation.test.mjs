import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { observeOnce, prepareJobValidation, approveJobValidation, queueJobValidation, runApprovedJobsOnce } from 'self-managed-api';
import { seed, selectVersion, registerNotion, migrationRecipe, enginePath } from '../dev/real-apis/environment.mjs';

test('the real local worker validates the reviewed Notion exercise in isolated baseline and candidate containers', { timeout: 150_000 }, async t => {
  assert.equal(process.platform, 'linux', 'Run this in the dedicated Linux Docker profile');
  const parent = resolve('work/real-api-integration'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'case-'));
  t.after(async () => { assert.equal(dirname(await realpath(root)), await realpath(parent)); await rm(root, { recursive: true }); });
  const paths = await seed(root);
  const original = await readFile(join(paths.consumer, 'notion.mjs'), 'utf8');
  await selectVersion('2025-09-03', root);
  const subscription = await registerNotion(paths);
  const cycle = await observeOnce({ statePath: paths.state, enginePath, subscriptionId: subscription.id });
  const input = { statePath: paths.state, enginePath, jobId: cycle.results[0].jobId,
    recipe: await migrationRecipe(paths), testPaths: ['notion.test.mjs'] };
  const request = await prepareJobValidation(input);
  assert.equal(request.plan.authorization, 'not-granted');
  const receipt = await approveJobValidation({ ...input, expectedRequestId: request.id, origin: 'explicit-sdk-caller' });
  const queued = await queueJobValidation({ ...input, receiptId: receipt.id });
  const result = await runApprovedJobsOnce({ statePath: paths.state, enginePath, intentId: queued.intent.id });
  assert.equal(result.results[0].status, 'completed', JSON.stringify(result));
  assert.equal(result.results[0].outcome.status, 'improved');
  const evidence = JSON.parse(await readFile(join(paths.state, 'attempts', receipt.id, 'result.json'), 'utf8'));
  assert.equal(evidence.baseline.exitCode, 1);
  assert.equal(evidence.candidate.exitCode, 0, evidence.candidate.stderr);
  assert.match(evidence.candidate.stdout, /# tests 4\b/);
  assert.match(evidence.candidate.stdout, /# pass 4\b/);
  assert.equal(evidence.baseline.cleanup, 'removed');
  assert.equal(evidence.candidate.cleanup, 'removed');
  assert.equal(await readFile(join(paths.consumer, 'notion.mjs'), 'utf8'), original);
  await assert.rejects(queueJobValidation({ ...input, receiptId: receipt.id }), { code: 'INVALID_INPUT' });
});
