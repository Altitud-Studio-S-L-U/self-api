import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cases } from './fixtures.mjs';
import { classifyEvaluation, evaluationPassed } from './classification.mjs';
import { prepareReviewedCandidate, sha256 } from './semantic-review.mjs';

const root = resolve(import.meta.dirname, '../..'), base = join(root, 'work/model-evaluation');
const [selected, mode, answersPath, ...extra] = process.argv.slice(2);
assert(selected && extra.length === 0 && (mode === '--prepare' && answersPath === undefined || mode === '--answers' && answersPath),
  'Usage: pnpm dev:model-review <run-directory> --prepare | --answers <review.json>');
const directory = await realpath(resolve(selected));
assert.equal(dirname(directory), await realpath(base)); assert.match(basename(directory), /^run-[a-f0-9-]{36}$/u);
const output = join(directory, 'output');
const evaluationBytes = await readFile(join(output, 'evaluation.json'));
const evaluation = JSON.parse(evaluationBytes);
assert.equal(evaluation.syntheticOnly, true); assert.equal(evaluation.outputsAreUnapproved, true);
const proposals = [];
for (const outcome of evaluation.outcomes) {
  if (outcome.expected !== 'migration' || outcome.status !== 'accepted-proposal') continue;
  const scenario = cases.find(value => value.id === outcome.id); assert(scenario);
  const proposalBytes = await readFile(join(output, `${scenario.id}.proposal.json`));
  const proposal = JSON.parse(proposalBytes); assert.equal(proposal.requestId, outcome.requestId);
  proposals.push({ scenario, proposal, proposalBytes, outcome });
}
const template = { schemaVersion: 1, evaluationSha256: sha256(evaluationBytes), authorizeSyntheticTests: false,
  reviews: proposals.map(({ scenario, proposal, proposalBytes }) => ({ scenarioId: scenario.id, requestId: proposal.requestId,
    proposalSha256: sha256(proposalBytes), reviewer: '', evidence: '',
    answers: proposal.recipe.decisions.map(({ id, question }) => ({ id, question, answer: '' })) })) };
if (mode === '--prepare') { console.log(JSON.stringify(template, null, 2)); process.exit(0); }
assert((await stat(answersPath)).size <= 64 * 1024, 'Review input exceeds its bounded size.');
const authorization = JSON.parse(await readFile(answersPath, 'utf8'));
assert.equal(authorization.schemaVersion, 1); assert.equal(authorization.evaluationSha256, template.evaluationSha256);
assert.equal(authorization.authorizeSyntheticTests, true, 'Execution needs separate explicit fixture-only authorization.');
assert(Array.isArray(authorization.reviews) && authorization.reviews.length > 0);
assert.equal(new Set(authorization.reviews.map(review => review.scenarioId)).size, authorization.reviews.length);
const sdk = await import(pathToFileURL(join(directory, 'runtime/node_modules/keepseam-client/dist/migration-recipe.js')).href);
const reviewed = authorization.reviews.map(review => {
  const original = proposals.find(value => value.scenario.id === review.scenarioId);
  assert(original, 'Refused, rejected and ambiguous scenarios cannot receive substitute edits.');
  return { ...original, review, ...prepareReviewedCandidate({ ...original, review, previewRecipe: sdk.previewRecipe }) };
});
const reviewId = randomUUID(), reviewDirectory = join(directory, `review-${reviewId}`);
await mkdir(reviewDirectory);
const containers = [];
async function docker(args, expected = 0) {
  return new Promise((done, reject) => {
    const child = spawn('docker', args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', size = 0, expired = false;
    const timer = setTimeout(() => { expired = true; child.kill(); }, 30000);
    for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) stream.on('data', bytes => {
      size += bytes.length; if (size > 1024 * 1024) child.kill(); else if (name === 'stdout') stdout += bytes; else stderr += bytes;
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (expired || signal || size > 1024 * 1024 || expected !== null && code !== expected) { reject(new Error('Review subprocess failed or exceeded its time/output bound.')); return; }
      done({ code, stdout, stderr });
    });
  });
}
const outcomes = evaluation.outcomes.map(value => ({ ...value }));
try {
  await docker(['image', 'inspect', evaluation.profile.nodeImage]);
  for (const item of reviewed) {
    await writeFile(join(reviewDirectory, `${item.scenario.id}.review.json`), JSON.stringify({ review: item.review, recipe: item.recipe }, null, 2), { flag: 'wx' });
    const outcome = outcomes.find(value => value.id === item.scenario.id);
    Object.assign(outcome, { pendingDecisions: 0, filesChanged: 1, tests: [], semanticReview: 'explicit-fixture-review',
      testAuthorization: 'synthetic-copies-only', publication: 'not-authorized' });
    for (const revision of ['baseline', 'candidate']) {
      const fixture = join(reviewDirectory, `${item.scenario.id}-${revision}`); await mkdir(fixture);
      await writeFile(join(fixture, 'payment.mjs'), revision === 'baseline' ? item.scenario.source : item.candidate, { flag: 'wx' });
      await writeFile(join(fixture, 'payment.test.mjs'), item.scenario.test, { flag: 'wx' });
      const name = `keepseam-semantic-${reviewId}-${containers.length}`; containers.push(name);
      const result = await docker(['run', '--name', name, '--label', `io.keepseam.semantic-review=${reviewId}`,
        '--pull=never', '--platform=linux/amd64', '--read-only', '--user=65534:65534', '--cap-drop=ALL', '--security-opt=no-new-privileges=true',
        '--network=none', '--cpus=1', '--memory=256m', '--memory-swap=256m', '--pids-limit=128', '--tmpfs=/tmp:rw,nosuid,nodev,size=64m,mode=1777',
        '--mount', `type=bind,source=${fixture},target=/fixture,readonly`, '--workdir=/fixture', evaluation.profile.nodeImage,
        'node', '--test', 'payment.test.mjs'], null);
      outcome.tests.push({ revision, exitCode: result.code, testSha256: sha256(item.scenario.test) });
      await writeFile(join(reviewDirectory, `${item.scenario.id}-${revision}.test.txt`), result.stdout + result.stderr, { flag: 'wx' });
    }
    outcome.behavior = classifyEvaluation(outcome);
  }
  await writeFile(join(reviewDirectory, 'evaluation.json'), JSON.stringify({ ...evaluation,
    originalEvaluationSha256: template.evaluationSha256, semanticReview: 'separate-explicit-fixture-review', outcomes }, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ reviewDirectory, outcomes }, null, 2));
  process.exitCode = outcomes.every(evaluationPassed) ? 0 : 1;
} finally {
  for (const name of containers.reverse()) {
    const inspected = await docker(['inspect', name], null); if (inspected.code !== 0) continue;
    const config = JSON.parse(inspected.stdout)[0]; assert.equal(config.Config.Labels['io.keepseam.semantic-review'], reviewId);
    await docker(['rm', '-f', name]);
  }
}
