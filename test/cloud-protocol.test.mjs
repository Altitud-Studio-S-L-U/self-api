import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeCloudStatusEvent, encodeCloudStatusEvent, validateCloudStatusEvent, deriveCloudIdentifier, negotiateCloudProtocol } from '../dist/cloud-protocol.js';

const event = () => ({ schemaVersion: 1, eventId: 'a'.repeat(64), installationId: 'b'.repeat(64), projectId: 'c'.repeat(64), sequence: 7,
  recordedAt: '2026-10-07T00:00:00.000Z', body: { type: 'runner-status', state: 'review-required', reason: 'approval-required', pendingJobs: 2 } });

test('Cloud status has an exact bounded versioned round trip and immutable normalized output', () => {
  assert.deepEqual(decodeCloudStatusEvent(encodeCloudStatusEvent(event())), event());
  const validated = validateCloudStatusEvent(event());
  assert(Object.isFrozen(validated));
  assert(Object.isFrozen(validated.body));
});

test('local source, logs, schemas, commands, model responses and labels cannot cross the allowlist boundary', () => {
  for (const field of ['source', 'before', 'after', 'diff', 'stderr', 'stdout', 'stack', 'schema', 'prompt', 'completion', 'command', 'label', 'url', 'pullRequest', 'authorization']) {
    for (const location of ['root', 'body']) {
      const value = event();
      (location === 'root' ? value : value.body)[field] = 'DISTINCTIVE_PRIVATE_CONTENT';
      assert.throws(() => encodeCloudStatusEvent(value), { code: 'INVALID_INPUT' });
    }
  }
  for (const field of ['installationId', 'projectId', 'eventId']) {
    assert.throws(() => encodeCloudStatusEvent({ ...event(), [field]: '/private/project/repository' }), { code: 'INVALID_INPUT' });
  }
});

test('extra enumerable/nonenumerable/accessor fields and proxies are rejected without invoking them', () => {
  let calls = 0;
  const value = event();
  Object.defineProperty(value.body, 'type', { get() { calls++; return 'runner-status'; } });
  assert.throws(() => encodeCloudStatusEvent(value), { code: 'INVALID_INPUT' });
  assert.equal(calls, 0);
  const hidden = event(); Object.defineProperty(hidden, 'private', { value: 'secret' });
  assert.throws(() => encodeCloudStatusEvent(hidden), { code: 'INVALID_INPUT' });
  assert.throws(() => encodeCloudStatusEvent(new Proxy(event(), { ownKeys() { calls++; return []; } })), { code: 'INVALID_INPUT' });
  assert.equal(calls, 0);
});

test('maintenance summaries carry opaque IDs and bounded counts but cannot claim a deployment', () => {
  const value = event();
  value.body = { type: 'maintenance-status', integrationId: 'd'.repeat(64), jobId: 'e'.repeat(64), state: 'validated', reason: 'none',
    affectedOperations: 2, selectedTests: 3, passingTests: 3 };
  assert.deepEqual(decodeCloudStatusEvent(encodeCloudStatusEvent(value)), value);
  assert.throws(() => encodeCloudStatusEvent({ ...value, body: { ...value.body, state: 'deployed' } }), { code: 'INVALID_INPUT' });
  assert.throws(() => encodeCloudStatusEvent({ ...value, body: { ...value.body, passingTests: 4 } }), { code: 'INVALID_INPUT' });
});

test('malformed, oversized, unsupported and ambiguous wire messages fail closed', () => {
  for (const json of ['{', ' '.repeat(4097), JSON.stringify({ ...event(), schemaVersion: 2 }), JSON.stringify({ ...event(), sequence: -1 }),
    JSON.stringify({ ...event(), recordedAt: '2026-10-07' }), JSON.stringify({ ...event(), body: { ...event().body, reason: 'RAW_ERROR' } })]) {
    assert.throws(() => decodeCloudStatusEvent(json), { code: 'INVALID_INPUT' });
  }
});

test('identity derivation is domain and installation scoped, with explicit protocol incompatibility', () => {
  assert.notEqual(deriveCloudIdentifier('a'.repeat(64), 'b'.repeat(64)), deriveCloudIdentifier('a'.repeat(64), 'c'.repeat(64)));
  assert.throws(() => deriveCloudIdentifier('private-route', 'b'.repeat(64)), { code: 'INVALID_INPUT' });
  assert.deepEqual(negotiateCloudProtocol([1, 2]), { status: 'compatible', version: 1 });
  assert.deepEqual(negotiateCloudProtocol([2]), { status: 'upgrade-required', version: null });
});

test('protocol negotiation rejects executable, sparse and extended arrays without executing them', () => {
  let invoked = false;
  const accessor = [1]; Object.defineProperty(accessor, '0', { get() { invoked = true; return 1; } });
  const extended = [1]; extended.extra = true;
  const overridden = [1]; overridden.some = () => { invoked = true; return false; };
  for (const value of [accessor, extended, overridden, new Array(1), new Proxy([1], { get() { invoked = true; return 1; } })]) {
    assert.throws(() => negotiateCloudProtocol(value), { code: 'INVALID_INPUT' });
  }
  assert.equal(invoked, false);
});
