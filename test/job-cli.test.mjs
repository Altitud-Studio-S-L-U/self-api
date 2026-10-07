import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { runJobCli } from '../dist/job-cli.js';
import { runCli } from '../dist/cli.js';
import { DOCKER_PROFILE } from '../dist/docker-runner.js';
import { PlumberError } from '../dist/errors.js';

const recipePath = resolve(import.meta.dirname, '../fixtures/validation-recipe.json');
const id = '1'.repeat(64);
const argsFor = command => [command, id, '--state', 'private state', '--engine', 'trusted engine', '--recipe', recipePath, '--test', 'orders.test.mjs'];
const request = { id, spec: { profile: DOCKER_PROFILE, testPaths: ['orders.test.mjs'] }, plan: {
  id, summary: 'Controlled fixture', status: 'ready-for-review', authorization: 'not-granted', validation: 'syntax-only',
  decisions: [], requirements: [], files: [{ path: 'orders.mjs', beforeSha256: '2'.repeat(64), afterSha256: '3'.repeat(64), before: 'private before', after: 'private after' }],
} };
const receipt = { id: 'c49370c9-14e8-4470-b41d-bc3861a20504', expiresAt: '2026-10-07T10:15:00.000Z' };
const intent = { id, status: 'queued', recipeJson: 'private recipe', outcome: null, reason: null };
const noWork = { schemaVersion: 1, results: [] };

async function capture(args, replacements = {}) {
  let stdout = '';
  let stderr = '';
  const calls = [];
  const adapters = Object.fromEntries(Object.entries({ prepare: request, approve: receipt, queue: { intent, created: true },
    run: noWork, recover: noWork, list: [intent], confirm: true }).map(([name, value]) => [name, async input => {
      calls.push({ name, input });
      return replacements[name] ? replacements[name](input) : value;
    }]));
  const code = await runJobCli(args, { ...adapters, stdout: text => { stdout += text; }, stderr: text => { stderr += text; } });
  return { code, stdout, stderr, calls };
}

test('job-plan inspects only and emits source solely in explicit JSON mode', async () => {
  const shown = await capture(argsFor('job-plan'));
  assert.equal(shown.code, 0);
  assert.deepEqual(shown.calls.map(call => call.name), ['prepare']);
  assert.ok(!shown.stdout.includes('private before'));
  const json = await capture([...argsFor('job-plan'), '--json']);
  assert.deepEqual(JSON.parse(json.stdout), request);
});

test('job approval shows the exact proposal then requires confirmation without queueing or execution', async () => {
  const result = await capture(argsFor('job-approve'));
  assert.equal(result.code, 0);
  assert.deepEqual(result.calls.map(call => call.name), ['prepare', 'confirm', 'approve']);
  assert.equal(result.calls[1].input, id);
  assert.equal(result.calls[2].input.expectedRequestId, id);
  assert.equal(result.calls[2].input.origin, 'local-cli');
  assert.match(result.stdout, /private before/u);
  assert.match(result.stdout, /Queue and execution are separate/u);
  const cancelled = await capture(argsFor('job-approve'), { confirm: async () => false });
  assert.equal(cancelled.code, 1);
  assert.deepEqual(cancelled.calls.map(call => call.name), ['prepare', 'confirm']);
});

test('job-queue forwards existing authorization without prompting or approving', async () => {
  const result = await capture([...argsFor('job-queue'), '--approval', receipt.id, '--json']);
  assert.equal(result.code, 0);
  assert.deepEqual(result.calls.map(call => call.name), ['queue']);
  assert.equal(result.calls[0].input.receiptId, receipt.id);
  assert.deepEqual(JSON.parse(result.stdout), { intent, created: true });
});

test('execution and recovery commands remain distinct and bounded', async () => {
  const run = await capture(['run-approved', '--once', '--state', 'private state', '--engine', 'trusted engine', '--limit', '2', '--intent', id]);
  assert.equal(run.code, 0);
  assert.deepEqual(run.calls, [{ name: 'run', input: { statePath: 'private state', enginePath: 'trusted engine', limit: 2, intentId: id } }]);
  const recovery = await capture(['recover-approved', '--state', 'private state', '--json']);
  assert.equal(recovery.code, 0);
  assert.deepEqual(recovery.calls, [{ name: 'recover', input: { statePath: 'private state' } }]);
});

test('execution exit codes preserve improved, failed, interrupted and blocked outcomes', async () => {
  for (const [status, outcome, expected] of [
    ['completed', 'passed', 0], ['completed', 'improved', 1], ['completed', 'failed', 1], ['completed', 'regression', 1],
    ['completed', 'blocked', 2], ['interrupted', undefined, 2], ['lease-lost', undefined, 2], ['blocked', undefined, 2],
  ]) {
    const cycle = { schemaVersion: 1, results: [{ intentId: id, status, ...(outcome ? { outcome: { status: outcome } } : {}) }] };
    const result = await capture(['run-approved', '--once', '--state', 'state', '--engine', 'engine', '--json'], { run: async () => cycle });
    assert.equal(result.code, expected);
    assert.deepEqual(JSON.parse(result.stdout), cycle);
  }
});

test('invalid or duplicate options cannot trigger any job action', async () => {
  for (const args of [[], ['unknown'], ['executions'], ['executions', '--state', 's', '--recipe', recipePath],
    ['run-approved', '--state', 's', '--engine', 'e'], ['recover-approved', '--state', 's', '--limit', '11'],
    ['recover-approved', '--state', 's', '--limit', '1.5'], ['recover-approved', '--state', 's', '--limit', '01'],
    ['executions', '--state', 's', '--state', 'other'], [...argsFor('job-approve'), '--json'], [...argsFor('job-approve'), '--yes'],
    [...argsFor('job-plan'), '--approval', receipt.id]]) {
    const result = await capture(args);
    assert.equal(result.code, 2, JSON.stringify(args));
    assert.deepEqual(result.calls, [], JSON.stringify(args));
    assert.equal(JSON.parse(result.stderr).error.code, 'INVALID_INPUT');
  }
});

test('listing hides private recipes and escapes untrusted terminal text', async () => {
  const result = await capture(['executions', '--state', 's'], { list: async () => [{ ...intent, reason: 'reason\u001b[2J\u202e' }] });
  assert.equal(result.code, 0);
  assert.ok(!result.stdout.includes('private recipe'));
  assert.doesNotMatch(result.stdout, /[\u001b\u202e]/u);
  const failed = await capture(['recover-approved', '--state', 's'], { recover: async () => { throw new PlumberError('LEASE_LOST', 'owner changed'); } });
  assert.equal(failed.code, 2);
  assert.equal(JSON.parse(failed.stderr).error.code, 'LEASE_LOST');
});

test('the main CLI routes job commands and exposes their help without initializing state', async () => {
  let output = '';
  const code = await runCli(['run-approved', '--help'], { stdout: text => { output += text; } });
  assert.equal(code, 0);
  assert.match(output, /recover-approved/u);
  let error = '';
  assert.equal(await runCli(['run-approved'], { stdout: () => {}, stderr: text => { error += text; } }), 2);
  assert.equal(JSON.parse(error).error.code, 'INVALID_INPUT');
});
