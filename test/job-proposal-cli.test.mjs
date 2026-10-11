import assert from 'node:assert/strict';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { runJobProposalCli } from '../dist/job-proposal-cli.js';
import { fixture, controlledModel, enginePath } from './helpers/job-proposal.mjs';

async function setup(t) {
  const f = await fixture(t), model = await controlledModel(t, f.recipe);
  const modelPath = join(f.directory, 'model.json');
  await writeFile(modelPath, JSON.stringify({ provider: 'local-openai-compatible', model: 'deterministic-fixture',
    endpoint: model.adapter.destination.startsWith('local:') ? 'http://127.0.0.1:1/v1/chat/completions' : model.adapter.destination,
    policyId: 'fixture-v1', maximumOutputTokens: 2048 }));
  const args = ['--state', f.statePath, '--engine', enginePath, '--model', modelPath, '--test', 'orders.test.mjs'];
  return { ...f, model, modelPath, args };
}
async function invoke(args, options = {}) {
  let stdout = '', stderr = '';
  const code = await runJobProposalCli(args, { ...options, stdout: text => { stdout += text; }, stderr: text => { stderr += text; } });
  return { code, stdout, stderr };
}

test('job model planning is local and cancelled consent never invokes a configured model', async t => {
  const f = await setup(t);
  const factory = () => f.model.adapter;
  const planned = await invoke(['job-proposal-plan', f.jobId, ...f.args], { adapter: factory });
  assert.equal(planned.code, 0); assert.equal(f.model.calls.length, 0);
  const request = JSON.parse(planned.stdout); assert.equal(request.authorization, 'not-granted');
  const cancelled = await invoke(['job-propose', f.jobId, ...f.args], { adapter: factory, confirm: async id => {
    assert.equal(id, request.modelRequest.id); return false;
  } });
  assert.equal(cancelled.code, 1); assert.equal(f.model.calls.length, 0);
});

test('CLI generates a bound recipe, then accepts explicit answers without authorizing tests or publication', async t => {
  const f = await setup(t);
  const generated = await invoke(['job-propose', f.jobId, ...f.args, '--output', 'proposal.json'],
    { adapter: () => f.model.adapter, confirm: async () => true });
  assert.equal(generated.code, 0, generated.stderr); assert.equal(f.model.calls.length, 1);
  const saved = JSON.parse(generated.stdout.trim().split('\n').at(-1));
  assert.equal(saved.proposal.status, 'proposal-ready'); assert.equal(saved.proposal.authorization, 'not-granted');
  assert.equal(saved.proposal.publication, 'not-authorized'); assert.equal(saved.proposal.preview.files.length, 0);
  const answersPath = join(f.directory, 'answers.json');
  await writeFile(answersPath, JSON.stringify({ proposalSha256: saved.proposalSha256,
    answers: Object.fromEntries(saved.proposal.recipe.decisions.map(decision => [decision.id, 'The reviewed fictional contract preserves minor units and the existing application DTO; bounded coverage was inspected.'])) }));
  const reviewArgs = ['job-review', '--state', f.statePath, '--engine', enginePath, '--proposal', saved.artifactPath,
    '--answers', answersPath, '--output', 'reviewed-recipe.json', '--json'];
  const originalAnswers = await readFile(answersPath, 'utf8');
  await writeFile(answersPath, JSON.stringify({ ...JSON.parse(originalAnswers), proposalSha256: '0'.repeat(64) }));
  const mismatched = await invoke(reviewArgs);
  assert.equal(mismatched.code, 2); assert.match(mismatched.stderr, /exact proposal digest/u);
  await assert.rejects(readFile(join(f.statePath, 'proposals/reviewed-recipe.json')), { code: 'ENOENT' });
  await writeFile(answersPath, originalAnswers);
  const reviewed = await invoke(reviewArgs); assert.equal(reviewed.code, 0, reviewed.stderr);
  const artifact = JSON.parse(reviewed.stdout); assert.equal(artifact.authorization, 'not-granted');
  const recipe = JSON.parse(await readFile(artifact.artifactPath, 'utf8'));
  assert(recipe.decisions.every(decision => decision.answer));
  assert.deepEqual(recipe.files, saved.proposal.recipe.files);
  const original = JSON.parse(await readFile(saved.artifactPath, 'utf8'));
  assert(original.recipe.decisions.every(decision => !Object.hasOwn(decision, 'answer')));
  await appendFile(join(f.consumerRoot, 'orders.mjs'), '\n// changed after the reviewed proposal\n');
  const stale = await invoke(reviewArgs.map(value => value === 'reviewed-recipe.json' ? 'stale.json' : value));
  assert.equal(stale.code, 2); assert.match(stale.stderr, /current source or consumer|binding changed/u);
});

test('invalid model configuration and out-of-state output filenames are rejected', async t => {
  const f = await setup(t);
  const outside = await invoke(['job-propose', f.jobId, ...f.args, '--output', '../outside.json'],
    { adapter: () => f.model.adapter, confirm: async () => { assert.fail('Invalid output cannot request consent.'); } });
  assert.equal(outside.code, 2); assert.match(outside.stderr, /inside the private state/u); assert.equal(f.model.calls.length, 0);
  const invalidTimeout = await invoke(['job-propose', f.jobId, ...f.args, '--timeout-ms', '120001'],
    { confirm: async () => { assert.fail('Invalid deadline cannot request consent.'); } });
  assert.equal(invalidTimeout.code, 2); assert.match(invalidTimeout.stderr, /1000 to 120000/u); assert.equal(f.model.calls.length, 0);
  await writeFile(f.modelPath, JSON.stringify({ provider: 'openai', model: 'fixture', policyId: 'fixture-v1', maximumOutputTokens: 128, apiKey: 'fixture-secret-never-a-real-key' }));
  const result = await invoke(['job-propose', f.jobId, ...f.args], { confirm: async () => { assert.fail('Invalid configuration cannot request consent.'); } });
  assert.equal(result.code, 2); assert(!result.stderr.includes('fixture-secret')); assert.equal(f.model.calls.length, 0);
});
