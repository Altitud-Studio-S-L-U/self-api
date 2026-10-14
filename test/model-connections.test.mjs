import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { ModelConnections, ModelConnectionError, normalizeModelRoutingConfiguration, prepareModelProposal,
  prepareModelRoute, approveModelRoute, runModelRoute } from '../dist/index.js';

const source = 'export const value = invoice => invoice.total;\n';
const file = { path: 'src/invoice.mjs', sha256: createHash('sha256').update(source).digest('hex'), text: source, role: 'source' };
const context = { files: [file], evidence: [{ id: 'provider', text: 'The total field is renamed amount with unchanged units.' }] };
const recipe = { schemaVersion: 1, summary: 'Use amount.', decisions: [], files: [{ path: file.path, sha256: file.sha256,
  edits: [{ before: 'invoice.total', after: 'invoice.amount' }] }] };
const connection = (id, overrides = {}) => ({ id, revision: 1, credentialRevision: 1, provider: 'openai', model: id,
  policyId: 'customer-reviewed', maximumOutputTokens: 1024, ...overrides });
const configuration = (auto = false, overrides = {}) => ({ schemaVersion: 1, primary: 'first',
  ...(auto ? { mode: 'auto', fallback: 'second' } : {}), connections: [connection('first'), ...(auto ? [connection('second')] : [])], ...overrides });
function setup(config = configuration(), { generate = async () => JSON.stringify(recipe), probe = async () => {}, persistence, now } = {}) {
  const calls = [], checks = [];
  const runtime = new ModelConnections(config, { ...(persistence ? { persistence } : {}), ...(now ? { now } : {}),
    adapter: options => ({ id: `fixture-${options.model}`, location: 'remote', destination: `https://api.example.invalid/${options.model}`,
      policyId: `fixture-policy-${options.policyId}`, propose: async (context, options_) => { calls.push({ model: options.model, context }); return generate(options.model, context, options_); } }),
    probe: async (options, signal) => {
      checks.push({ model: options.model, signal });
      await probe(options.model, signal);
      return { status: 'verified', latencyMs: 1, maximumOutputTokens: 128 };
    },
  });
  const plan = () => {
    const { maximumTotalOutputTokens: _total, ...limits } = runtime.configuration.limits;
    return prepareModelRoute(runtime, runtime.selectedIds().map(id => {
      const { propose: _propose, ...adapter } = runtime.adapter(id);
      return prepareModelProposal({ ...context, adapter, limits });
    }));
  };
  const approve = request => approveModelRoute({ request, expectedRequestId: request.id, allowRemote: true });
  const run = async (options = {}) => { const request = plan(); return runModelRoute({ request, consent: approve(request), ...options }); };
  return { runtime, calls, checks, plan, approve, run };
}

test('manual is the default, configuration has bounded revisions and no unlisted model, secret or destination', () => {
  const normalized = normalizeModelRoutingConfiguration(configuration());
  assert.equal(normalized.mode, 'manual'); assert.equal(normalized.limits.timeoutMs, 120000);
  for (const input of [configuration(false, { mode: 'adaptive' }), configuration(false, { fallback: 'first' }),
    configuration(true, { fallback: 'unconnected' }), configuration(true, { connections: [connection('first'), connection('first')] }),
    configuration(false, { connections: [connection('first', { revision: Number.MAX_SAFE_INTEGER })] }),
    configuration(false, { connections: [connection('first', { apiKey: 'not-a-real-secret' })] }),
    configuration(false, { connections: [connection('first', { endpoint: 'http://169.254.169.254/' })] }),
    configuration(false, { limits: { timeoutMs: 120001 } }), configuration(true, { limits: { maximumTotalOutputTokens: 2000 } })]) {
    assert.throws(() => normalizeModelRoutingConfiguration(input), { code: 'INVALID_INPUT' });
  }
  let read = false;
  const accessor = configuration(false, { connections: [Object.defineProperty({}, 'id', { enumerable: true, get() { read = true; return 'first'; } })] });
  assert.throws(() => normalizeModelRoutingConfiguration(accessor), { code: 'INVALID_INPUT' }); assert.equal(read, false);
  const sparse = configuration(false, { connections: Array(1) });
  assert.throws(() => normalizeModelRoutingConfiguration(sparse), { code: 'INVALID_INPUT' });
});

test('planning and refused remote consent make no inference; exact consent authorizes only one manual generation', async () => {
  const f = setup(), request = f.plan();
  assert.equal(request.maximumGenerations, 1); assert.equal(request.maximumFunctionalChecks, 1);
  assert.equal(request.functionalCheck.privateCode, false); assert.equal(request.functionalCheck.maximumOutputTokens, 128);
  assert.equal(f.calls.length, 0); assert.equal(f.checks.length, 0);
  assert.throws(() => approveModelRoute({ request, expectedRequestId: request.id }), { code: 'INVALID_INPUT' });
  const consent = f.approve(request), result = await runModelRoute({ request, consent });
  assert.equal(result.generations, 1); assert.equal(result.functionalChecks, 1); assert.equal(result.reservedOutputTokens, 1152);
  assert.equal(result.outcome.authorization, 'not-granted'); assert.equal(result.outcome.consumerExecuted, false);
  assert.equal(f.calls.length, 1); assert.equal(f.checks.length, 1);
  await assert.rejects(runModelRoute({ request, consent }), { code: 'INVALID_INPUT' });
  assert.equal(f.calls.length, 1);
});

test('Auto uses only the healthy allowlisted fallback after a transient primary failure, with observable limits and alerts', async () => {
  const f = setup(configuration(true), { generate: async model => {
    if (model === 'first') throw new ModelConnectionError('transient'); return JSON.stringify(recipe);
  } });
  const alerts = [], result = await f.run({ onAlert: event => alerts.push(event) });
  assert.equal(result.connectionId, 'second'); assert.equal(result.generations, 2); assert.equal(result.functionalChecks, 2);
  assert.equal(result.reservedOutputTokens, 2304);
  assert.deepEqual(f.calls.map(call => call.model), ['first', 'second']);
  assert.deepEqual(alerts.map(alert => alert.event), ['connection-degraded', 'fallback-selected']);
  assert.equal(f.runtime.states()[0].status, 'degraded'); assert.equal(f.runtime.states()[1].status, 'healthy');
  assert(!JSON.stringify(alerts).includes(source));
});

test('an unavailable primary probe can use only a fallback that itself passed the functional check', async () => {
  const f = setup(configuration(true), { probe: async model => { if (model === 'first') throw new ModelConnectionError('transient'); } });
  const result = await f.run();
  assert.equal(result.generations, 1); assert.equal(result.functionalChecks, 2); assert.deepEqual(f.calls.map(call => call.model), ['second']);
  const both = setup(configuration(true), { probe: async () => { throw new ModelConnectionError('transient'); } });
  await assert.rejects(both.run(), { kind: 'transient' }); assert.equal(both.calls.length, 0); assert.equal(both.checks.length, 2);
});

for (const failure of ['credentials', 'permission', 'model', 'quota']) {
  test(`${failure} blocks that connection while Auto can use its separately consented healthy fallback`, async () => {
    const stored = new Map(), persistence = { read: id => stored.get(id), write: state => stored.set(state.id, state) };
    const f = setup(configuration(true), { persistence, generate: async model => {
      if (model === 'first') throw new ModelConnectionError(failure); return JSON.stringify(recipe);
    } });
    const result = await f.run();
    assert.equal(result.connectionId, 'second'); assert.equal(result.generations, 2);
    assert.equal(result.alerts[0].event, 'reconfiguration-required'); assert.equal(result.alerts[0].reason, failure);
    assert.equal(f.calls.length, 2); assert.equal(f.runtime.states()[0].status, 'requires-reconfiguration');
    const count = f.checks.length;
    assert.equal((await f.run()).connectionId, 'second');
    assert.equal(f.checks.length, count); assert.equal(f.calls.length, 3);
    assert.equal(f.calls.filter(call => call.model === 'first').length, 1);
    const restart = setup(configuration(true), { persistence });
    assert.equal((await restart.run()).connectionId, 'second');
    assert.deepEqual(restart.checks.map(check => check.model), ['second']); assert.equal(restart.calls.length, 1);
    const manual = setup(configuration(), { persistence });
    await assert.rejects(manual.run(), { kind: failure }); assert.equal(manual.calls.length, 0); assert.equal(manual.checks.length, 0);
    await restart.runtime.verify('first', new AbortController().signal, true);
    assert.equal(restart.runtime.states()[0].status, 'healthy');
    assert.equal((await restart.run()).connectionId, 'first');
    const failedProbe = setup(configuration(true), { probe: async model => {
      if (model === 'first') throw new ModelConnectionError(failure);
    } });
    const checkedFallback = await failedProbe.run();
    assert.equal(checkedFallback.connectionId, 'second'); assert.equal(checkedFallback.generations, 1);
    assert.equal(checkedFallback.functionalChecks, 2); assert.deepEqual(failedProbe.calls.map(call => call.model), ['second']);
    assert.equal(failedProbe.runtime.states()[0].status, 'requires-reconfiguration');
    assert.deepEqual(checkedFallback.alerts.map(alert => alert.event), ['reconfiguration-required', 'fallback-selected']);
  });
}

test('a provider protocol or security failure stops the chain, even when a fallback was consented', async () => {
  const f = setup(configuration(true), { generate: async () => { throw new ModelConnectionError('invalid-response'); } });
  await assert.rejects(f.run(), { kind: 'invalid-response' });
  assert.equal(f.calls.length, 1); assert.equal(f.checks.length, 1); assert.equal(f.runtime.states()[0].status, 'requires-reconfiguration');
  await assert.rejects(f.run(), { kind: 'invalid-response' }); assert.equal(f.calls.length, 1); assert.equal(f.checks.length, 1);
});

test('decision-required, malformed output and an attempted test modification never try another model', async () => {
  const decision = { schemaVersion: 1, summary: 'The evidence does not define units.', decisions: [{ id: 'units', question: 'Which units apply?' }], files: [] };
  const f = setup(configuration(true), { generate: async () => JSON.stringify(decision) });
  assert.equal((await f.run()).outcome.status, 'decision-required'); assert.equal(f.calls.length, 1); assert.equal(f.checks.length, 1);
  for (const response of ['not JSON', JSON.stringify({ ...recipe, files: [{ ...recipe.files[0], path: 'test/invoice.test.mjs' }] }),
    JSON.stringify({ ...recipe, decisions: [{ id: 'approve', question: 'Approve?', answer: 'yes' }] })]) {
    const rejected = setup(configuration(true), { generate: async () => response });
    await assert.rejects(rejected.run(), { code: 'INVALID_INPUT' }); assert.equal(rejected.calls.length, 1);
  }
});

test('a serialized request, edited request, different context or changed policy cannot authorize probes or another destination', async () => {
  const f = setup(configuration(true)), request = f.plan();
  assert.throws(() => approveModelRoute({ request: structuredClone(request), expectedRequestId: request.id, allowRemote: true }), { code: 'INVALID_INPUT' });
  assert.throws(() => approveModelRoute({ request, expectedRequestId: '0'.repeat(64), allowRemote: true }), { code: 'INVALID_INPUT' });
  assert.throws(() => approveModelRoute({ request, expectedRequestId: request.id, allowRemote: true, expiresAt: Date.now() - 1 }), { code: 'INVALID_INPUT' });
  assert.throws(() => prepareModelRoute(f.runtime, request.attempts.map(attempt => structuredClone(attempt.request))), { code: 'INVALID_INPUT' });
  const other = setup(configuration(true, { limits: { maximumOutputBytes: 4096 } }));
  await assert.rejects(runModelRoute({ request: other.plan(), consent: f.approve(request) }), { code: 'INVALID_INPUT' });
  assert.equal(f.calls.length, 0); assert.equal(f.checks.length, 0); assert.equal(other.checks.length, 0);
});

test('functional receipts expire after five minutes, are never polled at idle, and cannot survive process restart as fresh authority', async () => {
  let now = 10_000;
  const stored = new Map(), persistence = { read: id => stored.get(id), write: state => stored.set(state.id, state) };
  const f = setup(configuration(), { now: () => now, persistence });
  await f.run(); await f.run(); assert.equal(f.checks.length, 1);
  now += 300001; assert.equal(f.checks.length, 1); assert.equal(f.runtime.fresh('first'), false);
  await f.run(); assert.equal(f.checks.length, 2);
  now -= 1; assert.equal(f.runtime.fresh('first'), false);
  const restart = setup(configuration(), { now: () => now, persistence });
  assert.equal(restart.runtime.fresh('first'), false); await restart.run(); assert.equal(restart.checks.length, 1);
  assert.throws(() => setup(configuration(false, { connections: [connection('first', { credentialRevision: 2 })] }), { persistence }), /increased connection revision/u);
  const changed = setup(configuration(false, { connections: [connection('first', { revision: 2, credentialRevision: 2 })] }), { persistence });
  assert.equal(changed.runtime.states()[0].status, 'unverified'); await changed.run(); assert.equal(changed.checks.length, 1);
});

test('cancellation and the single global deadline cover probes and caller evidence checks, with no later fallback', async () => {
  const cancelled = setup(configuration(true));
  await assert.rejects(cancelled.run({ signal: AbortSignal.abort() }), { kind: 'cancelled' });
  assert.equal(cancelled.checks.length, 0); assert.equal(cancelled.calls.length, 0);
  const blocked = setup(configuration(true, { limits: { timeoutMs: 1000 } }), { probe: async () => new Promise(() => {}) });
  await assert.rejects(blocked.run(), { kind: 'cancelled' });
  assert.equal(blocked.checks.length, 1); assert.equal(blocked.calls.length, 0);
  const checks = setup(configuration(true, { limits: { timeoutMs: 1000 } }));
  let observedSignal;
  await assert.rejects(checks.run({ execute: async (_request, _consent, _adapter, signal) => {
    observedSignal = signal; await delay(1250); signal.throwIfAborted(); throw new Error('Unreachable provider call.');
  } }), { kind: 'cancelled' });
  assert.equal(observedSignal.aborted, true); assert.equal(checks.calls.length, 0);
});

test('a runtime rejects overlapping approved operations instead of duplicating the authorized calls', async () => {
  let release, entered;
  const reached = new Promise(resolve => { entered = resolve; });
  const f = setup(configuration(), { generate: async () => { entered(); await new Promise(resolve => { release = resolve; }); return JSON.stringify(recipe); } });
  const first = f.run(); await reached;
  await assert.rejects(f.run(), /already has an active/u);
  release(); await first; assert.equal(f.calls.length, 1);
});

test('credential rotation cannot reuse a functional receipt or a previously approved route, and no key fingerprint is persisted', async t => {
  const keyName = 'KEEPSEAM_TEST_MODEL_CONNECTION_KEY', previous = process.env[keyName];
  t.after(() => { if (previous === undefined) delete process.env[keyName]; else process.env[keyName] = previous; });
  process.env[keyName] = 'fictional-first-key';
  const stored = new Map(); let generated = 0, probes = 0;
  const runtime = new ModelConnections(configuration(false, { connections: [connection('first', { apiKeyEnv: keyName })] }), {
    persistence: { read: id => stored.get(id), write: state => stored.set(state.id, state) },
    adapter: options => ({ id: 'credential-fixture', location: 'remote', destination: 'https://api.example.invalid/connection', policyId: 'credential-policy',
      propose: async (_context, { signal }) => { await options.getApiKey(signal); generated++; return JSON.stringify(recipe); } }),
    probe: async (options, signal) => { await options.getApiKey(signal); probes++; return { status: 'verified', latencyMs: 1, maximumOutputTokens: 128 }; },
  });
  const prepare = () => {
    const { maximumTotalOutputTokens: _total, ...limits } = runtime.configuration.limits;
    const { propose: _propose, ...adapter } = runtime.adapter('first');
    const request = prepareModelRoute(runtime, [prepareModelProposal({ ...context, adapter, limits })]);
    return { request, consent: approveModelRoute({ request, expectedRequestId: request.id, allowRemote: true }) };
  };
  await runModelRoute(prepare()); assert.equal(probes, 1); assert.equal(generated, 1);
  const old = prepare();
  process.env[keyName] = 'fictional-replacement-key';
  await assert.rejects(runModelRoute(prepare()), { kind: 'credentials' }); assert.equal(generated, 1);
  await runtime.verify('first', new AbortController().signal, true); assert.equal(probes, 2);
  await assert.rejects(runModelRoute(old), /credential changed/u); assert.equal(generated, 1);
  await runModelRoute(prepare()); assert.equal(generated, 2);
  const persisted = JSON.stringify([...stored.values()]);
  assert(!persisted.includes('fictional')); assert(!persisted.includes('credentialEpoch'));
  assert.deepEqual(Object.keys(stored.get('first')).sort(), ['configurationDigest', 'failure', 'id', 'latencyMs', 'revision', 'status', 'verifiedAt'].sort());
});
