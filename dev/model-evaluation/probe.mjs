import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { createHttpModelAdapter, prepareModelProposal, approveModelProposal, proposeMigrationWithModel } from 'self-managed-api';
import { cases } from './fixtures.mjs';
import { selectProfile } from './profile.mjs';
import { describeProposal } from './classification.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
const profile = selectProfile(process.env.SELF_MANAGED_API_MODEL_EVALUATION_PROFILE);
const endpoint = 'http://127.0.0.1:8080/v1/chat/completions';
const output = '/output';
await writeFile(`${output}/probe-started.json`, JSON.stringify({ kind: 'synthetic-output-write-preflight', uid: process.getuid() }), { flag: 'wx' });
const readinessDeadline = performance.now() + 60000;
while (true) {
  try {
    const health = await fetch('http://127.0.0.1:8080/health', { redirect: 'error', signal: AbortSignal.timeout(2000) });
    if (health.status === 200) break;
  } catch { /* Loading is observable; no inference is retried. */ }
  if (performance.now() >= readinessDeadline) throw new Error('Model server did not become healthy within 60 seconds.');
  await delay(250);
}
const routes = await readFile('/proc/net/route', 'utf8');
assert.equal(routes.trim().split('\n').length, 1, 'The shared model namespace must have no external IPv4 route.');
const external = await new Promise(resolve => {
  const connection = createConnection({ host: '1.1.1.1', port: 443 });
  connection.setTimeout(1000);
  connection.once('connect', () => { connection.destroy(); resolve('connected'); });
  connection.once('error', error => { connection.destroy(); resolve(error.code); });
  connection.once('timeout', () => { connection.destroy(); resolve('timeout'); });
});
assert.equal(external, 'ENETUNREACH', 'Inference must run without external network access.');

const outcomes = [];
for (const scenario of cases) {
  const adapter = createHttpModelAdapter({ provider: 'local-openai-compatible', model: profile.model,
    policyId: 'synthetic-cpu-evaluation-v1', maximumOutputTokens: 1024, endpoint });
  const { propose: _propose, ...identity } = adapter;
  const files = [{ path: 'payment.mjs', sha256: sha(scenario.source), text: scenario.source, role: 'source' },
    { path: 'payment.test.mjs', sha256: sha(scenario.test), text: scenario.test, role: 'test' }];
  const request = prepareModelProposal({ adapter: identity, files, evidence: [{ id: scenario.id, text: scenario.evidence }],
    limits: { maximumInputBytes: 16 * 1024, maximumOutputBytes: 16 * 1024, timeoutMs: 120000 } });
  const consent = approveModelProposal({ request, expectedRequestId: request.id });
  await writeFile(`${output}/${scenario.id}.input.json`, JSON.stringify(request, null, 2), { flag: 'wx' });
  const started = performance.now();
  let outcome, proposal;
  try {
    proposal = await proposeMigrationWithModel({ request, consent, adapter });
    outcome = { id: scenario.id, expected: scenario.expected, ...describeProposal(proposal), latencyMs: Math.round(performance.now() - started),
      inputBytes: request.inputBytes, requestId: request.id };
  } catch (error) {
    outcome = { id: scenario.id, expected: scenario.expected, status: 'rejected', latencyMs: Math.round(performance.now() - started),
      inputBytes: request.inputBytes, requestId: request.id, code: error.code ?? 'MODEL_EVALUATION_FAILED',
      // Harness errors contain fixed validation descriptions; raw HTTP/model
      // bodies are not captured here or substituted with a hand-written recipe.
      reason: error.message };
  }
  // A broken output mount is a lab failure, not a model refusal or rejection.
  if (proposal) await writeFile(`${output}/${scenario.id}.proposal.json`, JSON.stringify(proposal, null, 2), { flag: 'wx' });
  outcomes.push(outcome);
  console.log(JSON.stringify(outcome));
}
await writeFile(`${output}/proposals.json`, JSON.stringify({ syntheticOnly: true, network: 'none', externalProbe: external, outcomes }, null, 2), { flag: 'wx' });
