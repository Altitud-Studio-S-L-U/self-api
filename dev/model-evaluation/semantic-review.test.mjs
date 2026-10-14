import assert from 'node:assert/strict';
import { test } from 'node:test';
import { approveModelProposal, prepareModelProposal, proposeMigrationWithModel } from '../../dist/index.js';
import { previewRecipe } from '../../dist/migration-recipe.js';
import { cases } from './fixtures.mjs';
import { prepareReviewedCandidate, reviewRejection, sha256 } from './semantic-review.mjs';

async function fixture() {
  const scenario = cases[0];
  const identity = { id: 'fixture-review', location: 'local', destination: 'local:fixture', policyId: 'fixture-v1' };
  const request = prepareModelProposal({ adapter: identity,
    files: [{ path: 'payment.mjs', sha256: sha256(scenario.source), text: scenario.source, role: 'source' },
      { path: 'payment.test.mjs', sha256: sha256(scenario.test), text: scenario.test, role: 'test' }],
    evidence: [{ id: scenario.id, text: scenario.evidence }] });
  const proposal = await proposeMigrationWithModel({ request,
    consent: approveModelProposal({ request, expectedRequestId: request.id }), adapter: { ...identity,
      propose: async () => JSON.stringify({ schemaVersion: 1, summary: 'Controlled fixture output; this is not inference.', decisions: [],
        files: [{ path: 'payment.mjs', sha256: sha256(scenario.source), edits: [
          { before: "'/v1/payments/'", after: "'/v2/payments/'" }, { before: 'amount: body.amount', after: 'amount: body.total' },
        ] }] }) } });
  const proposalBytes = Buffer.from(JSON.stringify(proposal));
  const review = { scenarioId: scenario.id, requestId: request.id, proposalSha256: sha256(proposalBytes),
    reviewer: 'Explicit fictional fixture reviewer', evidence: scenario.evidence,
    answers: proposal.recipe.decisions.map(({ id, question }) => ({ id, question, answer: 'The supplied fictional release states identical integer minor units and unchanged currency.' })) };
  return { proposal, proposalBytes, scenario, review, previewRecipe };
}

test('separate review derives an exact candidate without changing inference evidence or tests', async () => {
  const value = await fixture(), original = JSON.stringify(value.proposal);
  assert.equal(value.proposal.preview.files.length, 0);
  const reviewed = prepareReviewedCandidate(value);
  assert(reviewed.candidate.includes("'/v2/payments/'")); assert(reviewed.candidate.includes('amount: body.total'));
  assert.equal(reviewed.preview.requirements.length, 0); assert.equal(JSON.stringify(value.proposal), original);
  assert.equal(value.proposal.authorization, 'not-granted'); assert.equal(value.proposal.publication, 'not-authorized');
});

test('review rejects missing decisions, changed questions, stale proposal binding and substitute recipes', async () => {
  const value = await fixture();
  for (const review of [{ ...value.review, answers: [] }, { ...value.review, proposalSha256: '0'.repeat(64) },
    { ...value.review, requestId: '0'.repeat(64) }, { ...value.review, reviewer: '' },
    { ...value.review, answers: value.review.answers.map(answer => ({ ...answer, question: 'Approve without checking?' })) }]) {
    assert.throws(() => prepareReviewedCandidate({ ...value, review }));
  }
  assert.throws(() => prepareReviewedCandidate({ ...value, proposal: { ...value.proposal, status: 'decision-required' } }));
  assert.throws(() => prepareReviewedCandidate({ ...value, scenario: cases[1] }));
});

test('semantic rejection preserves the model evidence and never grants execution or substitutes a repair', async () => {
  const value = await fixture(), before = JSON.stringify(value.proposal);
  const rejection = { scenarioId: value.scenario.id, requestId: value.proposal.requestId,
    proposalSha256: sha256(value.proposalBytes), reviewer: 'Fixture reviewer', reason: 'The output contradicts the supplied currency format.' };
  const result = reviewRejection({ ...value, rejection });
  assert.equal(result.status, 'rejected'); assert.equal(result.consumerExecuted, false);
  assert.equal(result.publication, 'not-authorized'); assert.equal(JSON.stringify(value.proposal), before);
  assert.throws(() => reviewRejection({ ...value, rejection: { ...rejection, proposalSha256: '0'.repeat(64) } }));
  assert.throws(() => reviewRejection({ ...value, rejection: { ...rejection, reason: '' } }));
});
