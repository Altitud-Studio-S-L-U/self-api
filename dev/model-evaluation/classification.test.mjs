import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyEvaluation, describeProposal, evaluationPassed } from './classification.mjs';

const flags = { authorization: 'not-granted', publication: 'not-authorized', consumerModified: false, consumerExecuted: false, validation: 'not-run' };
const proposal = { ...flags, status: 'proposal-ready', recipe: { files: [{ path: 'payment.mjs' }] },
  preview: { files: [], requirements: [{ id: 'model-semantics', question: 'Are units equivalent?' }] } };
const abstention = { ...flags, status: 'decision-required', summary: 'Unit evidence is missing.',
  decisions: [{ id: 'units', question: 'Which documented units apply?' }] };

test('decision-only outcomes are classified without accessing an absent recipe or preview', () => {
  const outcome = { ...describeProposal(abstention), expected: 'abstention' };
  assert.equal(outcome.status, 'decision-required');
  assert.equal(outcome.proposedFiles, 0);
  assert.equal(outcome.abstained, true);
  assert.equal(classifyEvaluation(outcome), 'abstained');
  assert.equal(evaluationPassed(outcome), true);
  assert.equal(evaluationPassed({ ...outcome, expected: 'migration' }), false);
});

test('withheld previews are not empty recipes, abstentions or successful migrations', () => {
  const outcome = { ...describeProposal(proposal), expected: 'migration' };
  assert.equal(outcome.proposedFiles, 1);
  assert.equal(outcome.filesChanged, 0);
  assert.equal(outcome.abstained, false);
  assert.equal(classifyEvaluation(outcome), 'awaiting-semantic-review');
  assert.equal(evaluationPassed(outcome), false);
  assert.equal(classifyEvaluation({ ...outcome, expected: 'abstention' }), 'failed-abstention');
});

test('recorded rejection remains a failure even when abstention was expected', () => {
  const original = Object.freeze({ id: 'ambiguous-units', expected: 'abstention', status: 'rejected',
    code: 'INVALID_INPUT', reason: 'The original inference exceeded its deadline.', latencyMs: 120001 });
  assert.equal(classifyEvaluation(original), 'rejected');
  assert.equal(evaluationPassed(original), false);
  assert.deepEqual(original, { id: 'ambiguous-units', expected: 'abstention', status: 'rejected',
    code: 'INVALID_INPUT', reason: 'The original inference exceeded its deadline.', latencyMs: 120001 });
});

test('only real recorded failing-baseline/passing-candidate results with the same test count as migration success', () => {
  const outcome = { expected: 'migration', status: 'accepted-proposal', proposedFiles: 1, filesChanged: 1, pendingDecisions: 0 };
  assert.equal(classifyEvaluation(outcome), 'awaiting-tests');
  assert.equal(evaluationPassed(outcome), false);
  const tests = [{ revision: 'baseline', exitCode: 1, testSha256: 'fixture-same-test' },
    { revision: 'candidate', exitCode: 0, testSha256: 'fixture-same-test' }];
  assert.equal(evaluationPassed({ ...outcome, tests }), true);
  assert.equal(evaluationPassed({ ...outcome, tests: [tests[0], { ...tests[1], exitCode: 1 }] }), false);
  assert.equal(evaluationPassed({ ...outcome, tests: [{ ...tests[0], exitCode: 0 }, tests[1]] }), false);
  assert.throws(() => classifyEvaluation({ ...outcome, tests: [tests[0], { ...tests[1], testSha256: 'weakened-test' }] }));
});

test('unknown or inconsistent harness outputs fail classification instead of becoming success', () => {
  assert.throws(() => describeProposal({ ...abstention, recipe: { files: [] } }));
  assert.throws(() => describeProposal({ ...proposal, status: undefined }));
  assert.throws(() => describeProposal({ ...proposal, recipe: { files: [] } }));
  assert.throws(() => describeProposal({ ...proposal, recipe: { files: [{ path: 'payment.test.mjs' }] } }));
});
