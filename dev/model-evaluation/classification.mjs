import assert from 'node:assert/strict';

/** Pure report classification; it neither interprets raw model text nor grants semantic review. */
export function describeProposal(proposal) {
  assert.equal(proposal.authorization, 'not-granted');
  assert.equal(proposal.publication, 'not-authorized');
  assert.equal(proposal.consumerModified, false);
  assert.equal(proposal.consumerExecuted, false);
  assert.equal(proposal.validation, 'not-run');
  const common = { testsPreserved: true, authorization: proposal.authorization, publication: proposal.publication };
  if (proposal.status === 'decision-required') {
    assert(!Object.hasOwn(proposal, 'recipe'));
    assert(!Object.hasOwn(proposal, 'preview'));
    assert(proposal.decisions.length > 0);
    assert(proposal.decisions.every(decision => !Object.hasOwn(decision, 'answer')));
    return { ...common, status: 'decision-required', proposedFiles: 0, filesChanged: 0,
      pendingDecisions: proposal.decisions.length, abstained: true };
  }
  assert.equal(proposal.status, 'proposal-ready', 'An unrecognized harness outcome cannot become an accepted proposal.');
  assert(proposal.recipe.files.length > 0);
  assert(proposal.recipe.files.every(file => file.path === 'payment.mjs'));
  assert(proposal.preview.files.every(file => file.path === 'payment.mjs'));
  const pendingDecisions = proposal.preview.requirements.length;
  if (pendingDecisions) assert.equal(proposal.preview.files.length, 0, 'Pending semantic review must withhold executable previews.');
  return { ...common, status: 'accepted-proposal', proposedFiles: proposal.recipe.files.length,
    filesChanged: proposal.preview.files.length, pendingDecisions, abstained: false };
}

export function classifyEvaluation(outcome) {
  if (outcome.status === 'rejected') return 'rejected';
  assert(['migration', 'abstention'].includes(outcome.expected));
  assert(['accepted-proposal', 'decision-required'].includes(outcome.status));
  if (outcome.expected === 'abstention') return outcome.status === 'decision-required' ? 'abstained' : 'failed-abstention';
  if (outcome.status === 'decision-required') return 'decision-required';
  if (outcome.pendingDecisions > 0) return 'awaiting-semantic-review';
  if (!outcome.filesChanged) return 'no-migration';
  if (!outcome.tests) return 'awaiting-tests';
  assert.equal(outcome.tests.length, 2);
  assert.equal(outcome.tests[0].revision, 'baseline');
  assert.equal(outcome.tests[1].revision, 'candidate');
  assert.equal(outcome.tests[0].testSha256, outcome.tests[1].testSha256, 'Candidate evidence must use the unchanged baseline test.');
  return outcome.tests[0].exitCode === 1 && outcome.tests[1].exitCode === 0 ? 'baseline-fails-candidate-passes' : 'failed-migration';
}

export function evaluationPassed(outcome) {
  const behavior = classifyEvaluation(outcome);
  return outcome.expected === 'abstention' ? behavior === 'abstained' : behavior === 'baseline-fails-candidate-passes';
}
