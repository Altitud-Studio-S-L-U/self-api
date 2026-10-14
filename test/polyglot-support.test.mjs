import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { approveModelProposal, prepareJobProposal, prepareJobValidation, prepareModelProposal, proposeJobMigration } from '../dist/index.js';
import { dockerProfileForTests, DOCKER_PROFILE, JAVA_DOCKER_PROFILE, PYTHON_DOCKER_PROFILE } from '../dist/docker-runner.js';
import { previewRecipe } from '../dist/migration-recipe.js';
import { fixture, identity, enginePath, root } from './helpers/job-proposal.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');

test('runtime profiles are closed, pinned and reject mixed-language selections', () => {
  assert.equal(dockerProfileForTests(['orders.test.mjs']), DOCKER_PROFILE);
  assert.equal(dockerProfileForTests(['test_orders.py']), PYTHON_DOCKER_PROFILE);
  assert.equal(dockerProfileForTests(['OrdersTest.java']), JAVA_DOCKER_PROFILE);
  for (const paths of [[], ['orders.rb'], ['test_orders.py', 'OrdersTest.java'], ['orders.test.mjs', 'test_orders.py'], ['../test_orders.py']]) {
    assert.throws(() => dockerProfileForTests(paths));
  }
  for (const profile of [PYTHON_DOCKER_PROFILE, JAVA_DOCKER_PROFILE]) {
    assert.ok(Object.isFrozen(profile) && Object.isFrozen(profile.command));
    assert.match(profile.image, /@sha256:[a-f0-9]{64}$/u);
    assert.deepEqual(profile.isolationArgs, DOCKER_PROFILE.isolationArgs);
    assert(profile.isolationArgs.includes('--network=none') && profile.isolationArgs.includes('--pull=never'));
  }
  assert.equal(JAVA_DOCKER_PROFILE.id, 'java25-linux-amd64-v1');
  assert(JAVA_DOCKER_PROFILE.command.join(' ').includes('-proc:none'));
});

for (const language of ['python', 'java']) {
  const file = language === 'python' ? 'payment_client.py' : 'PaymentClient.java';
  const selectedTest = language === 'python' ? 'test_payment.py' : 'PaymentTest.java';
  const profile = language === 'python' ? PYTHON_DOCKER_PROFILE : JAVA_DOCKER_PROFILE;
  test(`${language}: observed jobs accept explicit captured roles while preserving coverage, semantic and execution gates`, async t => {
    const before = await readFile(join(root, `dev/polyglot/${language}/baseline`, file), 'utf8');
    const after = await readFile(join(root, `dev/polyglot/${language}/candidate`, file), 'utf8');
    const tests = await readFile(join(root, `dev/polyglot/${language}`, selectedTest), 'utf8');
    const f = await fixture(t, async consumer => {
      await writeFile(join(consumer, file), before);
      await writeFile(join(consumer, selectedTest), tests);
    });
    const request = await prepareJobProposal({ ...f.input, sourcePaths: [file], testPaths: [selectedTest] });
    assert.deepEqual(request.modelRequest.context.files.map(item => [item.path, item.role]), [[file, 'source'], [selectedTest, 'test']]);
    assert.equal(request.modelRequest.context.files[0].sha256, hash(before));
    assert(request.discovery.inspectionIssueCount >= 2);
    assert(request.modelRequest.context.requiredDecisions.some(decision => decision.id === 'keepseam-coverage'));
    assert.equal(request.consumerExecuted, false);
    const recipe = { schemaVersion: 1, summary: 'Operator-authored synthetic fixture recipe; not an inference-quality claim.', decisions: [],
      files: [{ path: file, sha256: hash(before), edits: [{ before, after }] }] };
    let calls = 0;
    const adapter = { ...identity, propose: async () => { calls++; return JSON.stringify(recipe); } };
    await assert.rejects(proposeJobMigration({ request, expectedRequestId: request.id, consent: {}, adapter }), { code: 'INVALID_INPUT' });
    assert.equal(calls, 0);
    const consent = approveModelProposal({ request: request.modelRequest, expectedRequestId: request.modelRequest.id });
    const proposed = await proposeJobMigration({ request, expectedRequestId: request.id, consent, adapter });
    assert.equal(calls, 1);
    assert.equal(proposed.status, 'proposal-ready');
    assert.equal(proposed.preview.status, 'requires-decision');
    assert.equal(proposed.publication, 'not-authorized');
    assert.equal(proposed.validation, 'not-run');
    await assert.rejects(prepareJobValidation({ statePath: f.statePath, jobId: f.jobId, enginePath, recipe: proposed.recipe, testPaths: [selectedTest] }), { code: 'INVALID_INPUT' });
    const reviewed = { ...proposed.recipe, decisions: proposed.recipe.decisions.map(decision => ({ ...decision,
      answer: 'The fixture reviewer explicitly confirms the synthetic monetary contract and accepts limited static coverage.' })) };
    const validation = await prepareJobValidation({ statePath: f.statePath, jobId: f.jobId, enginePath, recipe: reviewed, testPaths: [selectedTest] });
    assert.equal(validation.spec.profile, profile);
    assert.equal(validation.plan.validation, 'not-run', 'Foreign source is not falsely labeled Babel syntax checked.');
    assert.equal(validation.plan.authorization, 'not-granted');
    assert.deepEqual(await readFile(join(f.consumerRoot, selectedTest), 'utf8'), tests);
    await assert.rejects(proposeJobMigration({ request, expectedRequestId: request.id, consent, adapter }), { code: 'INVALID_INPUT' });
    assert.equal(calls, 1);
    await assert.rejects(prepareJobProposal({ ...f.input, sourcePaths: [selectedTest], testPaths: [] }), { code: 'INVALID_INPUT' });
    await assert.rejects(prepareJobValidation({ statePath: f.statePath, jobId: f.jobId, enginePath, recipe: reviewed,
      testPaths: [selectedTest, 'orders.test.mjs'] }), { code: 'INVALID_INPUT' });
    const illegal = { ...reviewed, files: [...reviewed.files, { path: selectedTest, sha256: hash(tests), edits: [{ before: tests, after: '# weakened test' }] }] };
    await assert.rejects(prepareJobValidation({ statePath: f.statePath, jobId: f.jobId, enginePath, recipe: illegal, testPaths: [selectedTest] }), { code: 'INVALID_INPUT' });
  });
}

for (const path of ['test_payments.py', 'payments_test.py', 'PaymentsTest.java', 'PaymentsTests.java']) {
  test(`model context cannot assign conventional test ${path} to an editable role`, () => {
    const text = 'not executed';
    assert.throws(() => prepareModelProposal({ adapter: identity, files: [{ path, text, sha256: hash(text), role: 'source' }], evidence: [] }), { code: 'INVALID_INPUT' });
  });
}

test('Java business classes Latest and Contest are not mistaken for conventional test classes', () => {
  for (const path of ['Latest.java', 'Contest.java']) {
    const text = `class ${path.slice(0, -5)} {}`;
    const request = prepareModelProposal({ adapter: identity, files: [{ path, text, sha256: hash(text), role: 'source' }], evidence: [] });
    assert.equal(request.context.files[0].role, 'source');
  }
});

test('foreign recipe previews remain byte-bound without claiming a local syntax compiler', () => {
  const text = 'def payment():\n    return 1\n';
  const input = { schemaVersion: 1, summary: 'Explicit synthetic preview', decisions: [],
    files: [{ path: 'payment.py', sha256: hash(text), edits: [{ before: 'return 1', after: 'return (' }] }] };
  const preview = previewRecipe(input, [{ path: 'payment.py', text, sha256: hash(text) }]);
  assert.equal(preview.files[0].after, 'def payment():\n    return (\n');
  input.files[0].sha256 = '0'.repeat(64);
  assert.throws(() => previewRecipe(input, [{ path: 'payment.py', text, sha256: hash(text) }]), { code: 'INVALID_INPUT' });
});
