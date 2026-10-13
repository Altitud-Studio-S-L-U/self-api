import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { scenarioFiles } from './polyglot-cases.mjs';

export const sha256 = value => createHash('sha256').update(value).digest('hex');

export function reviewRejection({ proposal, proposalBytes, scenario, rejection }) {
  assert.equal(rejection.scenarioId, scenario.id); assert.equal(rejection.requestId, proposal.requestId);
  assert.equal(rejection.proposalSha256, sha256(proposalBytes), 'A rejection must bind the exact inference.');
  assert.equal(typeof rejection.reviewer, 'string'); assert(rejection.reviewer.trim().length > 0 && rejection.reviewer.length <= 200);
  assert.equal(typeof rejection.reason, 'string'); assert(rejection.reason.trim().length > 0 && rejection.reason.length <= 4096);
  assert.equal(proposal.authorization, 'not-granted'); assert.equal(proposal.publication, 'not-authorized');
  return { status: 'rejected', code: 'SEMANTIC_REVIEW_REJECTED', reason: rejection.reason,
    semanticReview: 'rejected', reviewer: rejection.reviewer, proposalSha256: rejection.proposalSha256,
    consumerModified: false, consumerExecuted: false, publication: 'not-authorized' };
}

/** This fixture reviewer records answers; it cannot replace an inference recipe. */
export function prepareReviewedCandidate({ proposal, proposalBytes, scenario, review, previewRecipe }) {
  assert.equal(scenario.expected, 'migration', 'Abstention cases are never converted into migrations.');
  assert.equal(proposal.status, 'proposal-ready', 'A refusal or rejection cannot acquire a replacement recipe.');
  assert.equal(proposal.consumerModified, false); assert.equal(proposal.consumerExecuted, false);
  assert.equal(proposal.authorization, 'not-granted'); assert.equal(proposal.publication, 'not-authorized');
  assert.equal(review.scenarioId, scenario.id);
  assert.equal(review.requestId, proposal.requestId, 'Review must identify the original model request.');
  assert.equal(review.proposalSha256, sha256(proposalBytes), 'Review must bind the exact saved proposal.');
  assert.equal(typeof review.reviewer, 'string'); assert(review.reviewer.trim().length > 0 && review.reviewer.length <= 200);
  assert.equal(typeof review.evidence, 'string'); assert(review.evidence.trim().length > 0 && review.evidence.length <= 4096);
  assert(Array.isArray(review.answers)); assert.equal(review.answers.length, proposal.recipe.decisions.length);
  const answers = new Map();
  for (const value of review.answers) {
    assert.deepEqual(Object.keys(value).sort(), ['answer', 'id', 'question']);
    assert.equal(typeof value.answer, 'string'); assert(value.answer.trim().length > 0 && value.answer.length <= 4096);
    assert(!answers.has(value.id), 'Review answers must be unique.'); answers.set(value.id, value);
  }
  const recipe = { ...proposal.recipe, decisions: proposal.recipe.decisions.map(decision => {
    assert(!Object.hasOwn(decision, 'answer'), 'Original inference must retain its unanswered decisions.');
    const answer = answers.get(decision.id); assert(answer, 'Every question needs an explicit reviewer answer.');
    assert.equal(answer.question, decision.question, 'Review cannot rewrite a question.');
    return { ...decision, answer: answer.answer };
  }) };
  const preview = previewRecipe(recipe, scenarioFiles(scenario).map(({ path, text }) => ({ path, text, sha256: sha256(text) })));
  assert.equal(preview.requirements.length, 0, 'Unanswered decisions must withhold execution.');
  assert.equal(preview.files.length, 1); assert.equal(preview.files[0].path, scenario.sourcePath ?? 'payment.mjs');
  assert.equal(preview.files[0].before, scenario.source); assert.equal(preview.files[0].beforeSha256, sha256(scenario.source));
  return { recipe, preview, candidate: preview.files[0].after };
}
