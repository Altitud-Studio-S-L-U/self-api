import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { runWorkerLoop } from '../dist/worker-loop.js';

let fixtureNumber = 0;
function options(overrides = {}) {
  // Adapter-only fixtures: these paths are never opened by the test callbacks.
  return { statePath: resolve('work', `worker-loop-fixture-${fixtureNumber++}`), enginePath: resolve('work', 'unused-engine'), ...overrides };
}

function observed(...statuses) {
  return { schemaVersion: 1, results: statuses.map((status, index) => ({ subscriptionId: `fixture-${index}`, status })) };
}

function executed(status = 'completed', outcomeStatus = 'passed') {
  // Scheduler summaries do not assert that this synthetic outcome is durable validation evidence.
  return { schemaVersion: 1, results: [{ intentId: 'fixture-intent', status,
    ...(status === 'completed' ? { outcome: { status: outcomeStatus } } : {}) }] };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function adapters(overrides = {}) {
  return { observe: async () => observed('unchanged'), runApproved: async () => executed(),
    delay: async () => {}, ...overrides };
}

test('the default loop observes once without execution or scheduling another cycle', async () => {
  let observations = 0;
  let executions = 0;
  let delays = 0;
  const input = options();
  const result = await runWorkerLoop(input, adapters({ observe: async received => {
    observations += 1;
    assert.deepEqual(received, { statePath: input.statePath, enginePath: input.enginePath });
    return observed('observed', 'unchanged', 'busy');
  }, runApproved: async () => { executions += 1; return executed(); }, delay: async () => { delays += 1; } }));
  assert.equal(observations, 1);
  assert.equal(executions, 0);
  assert.equal(delays, 0);
  assert.equal(result.stopReason, 'max-cycles');
  assert.equal(result.abortRequested, false);
  assert.equal(result.cycles[0].nextDelayMs, null);
  assert.deepEqual(result.cycles[0].observation.counts, { observed: 1, unchanged: 1, busy: 1, failed: 0 });
  assert.equal(result.cycles[0].execution.status, 'not-enabled');
});

test('explicit approved-job passes run after observation and obey the configured limit and subscription', async () => {
  const trace = [];
  const input = options({ processApprovedJobs: true, executionLimit: 2, subscriptionId: 'a'.repeat(64), maxCycles: 3 });
  const result = await runWorkerLoop(input, adapters({ observe: async received => {
    trace.push('observe');
    assert.equal(received.subscriptionId, input.subscriptionId);
    return observed('unchanged');
  }, runApproved: async received => {
    trace.push('execute-approved');
    assert.deepEqual(received, { statePath: input.statePath, enginePath: input.enginePath, limit: 2 });
    return executed();
  }, delay: async milliseconds => { trace.push(`delay:${milliseconds}`); } }));
  assert.deepEqual(trace, ['observe', 'execute-approved', 'delay:60000', 'observe', 'execute-approved', 'delay:60000', 'observe', 'execute-approved']);
  assert.equal(result.cycles.length, 3);
  assert.equal(result.cycles[2].execution.counts.completed, 1);
});

test('a slow phase never overlaps another phase or catches up missed timer intervals', async () => {
  let active = 0;
  let maximum = 0;
  const trace = [];
  const phase = async name => {
    active += 1;
    maximum = Math.max(maximum, active);
    trace.push(`${name}:start`);
    await new Promise(done => setImmediate(done));
    trace.push(`${name}:end`);
    active -= 1;
  };
  const result = await runWorkerLoop(options({ maxCycles: 3, intervalMs: 1000, processApprovedJobs: true }), adapters({
    observe: async () => { await phase('observe'); return observed('unchanged'); },
    runApproved: async () => { await phase('execute'); return executed(); },
    delay: async milliseconds => { assert.equal(active, 0); trace.push(`delay:${milliseconds}`); },
  }));
  assert.equal(result.cycles.length, 3);
  assert.equal(maximum, 1);
  assert.deepEqual(trace.slice(0, 5), ['observe:start', 'observe:end', 'execute:start', 'execute:end', 'delay:1000']);
});

test('concurrent loops for the same resolved state path are rejected and the guard is released afterward', async () => {
  const entered = deferred();
  const release = deferred();
  const input = options();
  const first = runWorkerLoop(input, adapters({ observe: async () => { entered.resolve(); await release.promise; return observed(); } }));
  await entered.promise;
  try {
    await assert.rejects(runWorkerLoop({ ...input, statePath: resolve(input.statePath, '.') }, adapters()),
      error => error.code === 'INVALID_INPUT');
  } finally { release.resolve(); }
  await first;
  assert.equal((await runWorkerLoop(input, adapters())).stopReason, 'max-cycles');
});

test('different state paths can run independently', async () => {
  const firstEntered = deferred();
  const secondEntered = deferred();
  const release = deferred();
  const first = runWorkerLoop(options(), adapters({ observe: async () => { firstEntered.resolve(); await release.promise; return observed(); } }));
  const second = runWorkerLoop(options(), adapters({ observe: async () => { secondEntered.resolve(); await release.promise; return observed(); } }));
  await Promise.all([firstEntered.promise, secondEntered.promise]);
  release.resolve();
  assert.deepEqual((await Promise.all([first, second])).map(result => result.stopReason), ['max-cycles', 'max-cycles']);
});

test('an already aborted signal starts no operations', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const result = await runWorkerLoop(options({ signal: controller.signal, processApprovedJobs: true }), adapters({
    observe: async () => { calls += 1; return observed(); }, runApproved: async () => { calls += 1; return executed(); },
    delay: async () => { calls += 1; },
  }));
  assert.equal(calls, 0);
  assert.deepEqual(result, { schemaVersion: 1, stopReason: 'aborted', abortRequested: true, cycles: [] });
});

test('abort during observation drains the current operation and skips execution', async () => {
  const controller = new AbortController();
  const entered = deferred();
  const release = deferred();
  let executions = 0;
  let settled = false;
  const pending = runWorkerLoop(options({ signal: controller.signal, processApprovedJobs: true, maxCycles: 5 }), adapters({
    observe: async () => { entered.resolve(); await release.promise; return observed('observed'); },
    runApproved: async () => { executions += 1; return executed(); },
  }));
  pending.then(() => { settled = true; });
  await entered.promise;
  controller.abort();
  await Promise.resolve();
  assert.equal(settled, false);
  release.resolve();
  const result = await pending;
  assert.equal(result.stopReason, 'aborted');
  assert.equal(result.cycles.length, 1);
  assert.equal(result.cycles[0].observation.counts.observed, 1);
  assert.equal(result.cycles[0].execution.status, 'skipped-aborted');
  assert.equal(executions, 0);
});

test('abort during approved execution waits for its result and starts no further cycle', async () => {
  const controller = new AbortController();
  const entered = deferred();
  const release = deferred();
  let settled = false;
  const pending = runWorkerLoop(options({ signal: controller.signal, processApprovedJobs: true, maxCycles: 5 }), adapters({
    runApproved: async () => { entered.resolve(); await release.promise; return executed(); },
  }));
  pending.then(() => { settled = true; });
  await entered.promise;
  controller.abort();
  await Promise.resolve();
  assert.equal(settled, false);
  release.resolve();
  const result = await pending;
  assert.equal(result.stopReason, 'aborted');
  assert.equal(result.cycles[0].execution.status, 'completed');
  assert.equal(result.cycles[0].execution.counts.completed, 1);
  assert.equal(result.cycles[0].nextDelayMs, null);
});

test('the actual default timer is interrupted by abort without waiting for its interval', { timeout: 2000 }, async () => {
  const controller = new AbortController();
  const input = options({ signal: controller.signal, maxCycles: 5, intervalMs: 60_000 });
  const result = await runWorkerLoop(input, { observe: async () => {
    setImmediate(() => controller.abort());
    return observed('unchanged');
  } });
  assert.equal(result.stopReason, 'aborted');
  assert.equal(result.cycles.length, 1);
  assert.equal(result.cycles[0].nextDelayMs, 60_000);
});

test('observation failures back off, cap the delay, and reset after a successful observation', async () => {
  const statuses = ['failed', 'failed', 'failed', 'unchanged', 'failed', 'unchanged'];
  const delays = [];
  let executions = 0;
  const result = await runWorkerLoop(options({ intervalMs: 1000, maxObservationBackoffMs: 5000,
    maxObservationFailures: 5, maxCycles: 6, processApprovedJobs: true }), adapters({
    observe: async () => observed(statuses.shift()),
    runApproved: async () => { executions += 1; return executed(); },
    delay: async milliseconds => { delays.push(milliseconds); },
  }));
  assert.deepEqual(delays, [2000, 4000, 5000, 1000, 2000]);
  assert.deepEqual(result.cycles.map(cycle => cycle.consecutiveObservationFailures), [1, 2, 3, 0, 1, 0]);
  assert.equal(executions, 2);
  assert.equal(result.cycles[0].execution.status, 'skipped-observation-failed');
});

test('a partially failed observation retains counts and prevents approved execution in that cycle', async () => {
  let executions = 0;
  const result = await runWorkerLoop(options({ processApprovedJobs: true }), adapters({
    observe: async () => observed('observed', 'failed', 'busy'),
    runApproved: async () => { executions += 1; return executed(); },
  }));
  assert.equal(result.cycles[0].observation.status, 'partial-failure');
  assert.deepEqual(result.cycles[0].observation.counts, { observed: 1, unchanged: 0, busy: 1, failed: 1 });
  assert.equal(executions, 0);
});

test('repeated thrown observation failures stop at the finite retry limit without leaking raw errors', async () => {
  let attempts = 0;
  const result = await runWorkerLoop(options({ maxCycles: 100, maxObservationFailures: 3 }), adapters({
    observe: async () => { attempts += 1; throw new Error('private-source-path and private-secret'); },
  }));
  assert.equal(result.stopReason, 'observation-failure-limit');
  assert.equal(attempts, 3);
  assert.equal(result.cycles[2].observation.reason, 'operation-error');
  assert.equal(result.cycles[2].nextDelayMs, null);
  assert.equal(JSON.stringify(result).includes('private-'), false);
});

test('a thrown execution error is terminal and is never automatically retried', async () => {
  let executions = 0;
  let observations = 0;
  let delays = 0;
  const input = options({ processApprovedJobs: true, maxCycles: 100 });
  const result = await runWorkerLoop(input, adapters({
    observe: async () => { observations += 1; return observed('unchanged'); },
    runApproved: async () => { executions += 1; throw new Error('private command or token'); },
    delay: async () => { delays += 1; },
  }));
  assert.equal(result.stopReason, 'execution-error');
  assert.equal(result.cycles[0].execution.reason, 'operation-error');
  assert.equal(executions, 1);
  assert.equal(observations, 1);
  assert.equal(delays, 0);
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal((await runWorkerLoop({ ...input, maxCycles: 1 }, adapters())).stopReason, 'max-cycles');
});

for (const status of ['blocked', 'interrupted', 'lease-lost']) {
  test(`execution ${status} requires attention and cannot be retried by the loop`, async () => {
    let attempts = 0;
    const result = await runWorkerLoop(options({ processApprovedJobs: true, maxCycles: 10 }), adapters({
      runApproved: async () => { attempts += 1; return executed(status); },
    }));
    assert.equal(result.stopReason, 'execution-attention');
    assert.equal(attempts, 1);
    assert.equal(result.cycles[0].execution.counts[status === 'lease-lost' ? 'leaseLost' : status], 1);
  });
}

for (const status of ['regression', 'failed', 'blocked']) {
  test(`a completed validation with ${status} outcome stops without being represented as successful validation`, async () => {
    const result = await runWorkerLoop(options({ processApprovedJobs: true, maxCycles: 10 }), adapters({ runApproved: async () => executed('completed', status) }));
    assert.equal(result.stopReason, 'execution-attention');
    assert.equal(result.cycles[0].execution.counts.completed, 1);
    assert.equal(result.cycles[0].execution.counts.unacceptedOutcomes, 1);
  });
}

test('passed and improved outcomes permit the next separately approved queue pass', async () => {
  let executions = 0;
  const result = await runWorkerLoop(options({ processApprovedJobs: true, maxCycles: 2 }), adapters({
    runApproved: async () => executed('completed', executions++ === 0 ? 'improved' : 'passed'),
  }));
  assert.equal(result.stopReason, 'max-cycles');
  assert.equal(executions, 2);
  assert.ok(result.cycles.every(cycle => cycle.execution.counts.unacceptedOutcomes === 0));
});

test('empty observation and approved-job queues are valid bounded cycles', async () => {
  const result = await runWorkerLoop(options({ processApprovedJobs: true }), adapters({
    observe: async () => observed(), runApproved: async () => ({ schemaVersion: 1, results: [] }),
  }));
  assert.equal(result.cycles[0].observation.status, 'completed');
  assert.equal(result.cycles[0].execution.status, 'completed');
  assert.equal(result.cycles[0].execution.counts.completed, 0);
});

test('scheduler failure is distinct from observation and execution failures and releases the active-state guard', async () => {
  const input = options({ maxCycles: 2 });
  const result = await runWorkerLoop(input, adapters({ delay: async () => { throw new Error('private delay details'); } }));
  assert.equal(result.stopReason, 'scheduler-error');
  assert.equal(result.cycles.length, 1);
  assert.equal(result.cycles[0].observation.status, 'completed');
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal((await runWorkerLoop({ ...input, maxCycles: 1 }, adapters())).stopReason, 'max-cycles');
});

test('an abort-related delay rejection is reported as cancellation, not scheduler failure', async () => {
  const controller = new AbortController();
  const result = await runWorkerLoop(options({ signal: controller.signal, maxCycles: 5 }), adapters({
    delay: async (milliseconds, signal) => { assert.equal(milliseconds, 60_000); assert.equal(signal, controller.signal);
      controller.abort(); throw new Error('AbortError'); },
  }));
  assert.equal(result.stopReason, 'aborted');
  assert.equal(result.abortRequested, true);
  assert.equal(result.cycles.length, 1);
});

test('execution failure remains visible when abort is requested during that failed operation', async () => {
  const controller = new AbortController();
  const result = await runWorkerLoop(options({ signal: controller.signal, processApprovedJobs: true }), adapters({
    runApproved: async () => { controller.abort(); throw new Error('execution failure'); },
  }));
  assert.equal(result.stopReason, 'execution-error');
  assert.equal(result.abortRequested, true);
});

test('invalid observation results fail closed and are distinguished from thrown operational errors', async () => {
  for (const result of [null, { schemaVersion: 2, results: [] }, observed('invented-success'),
    { schemaVersion: 1, results: new Array(1) }, { schemaVersion: 1, results: Array.from({ length: 101 }, () => ({ status: 'unchanged' })) }]) {
    const output = await runWorkerLoop(options({ processApprovedJobs: true }), adapters({ observe: async () => result,
      runApproved: async () => { assert.fail('invalid observations must not authorize execution'); } }));
    assert.equal(output.cycles[0].observation.reason, 'invalid-result');
    assert.equal(output.cycles[0].execution.status, 'skipped-observation-failed');
  }
});

test('invalid execution results fail closed once, without retry', async () => {
  for (const result of [null, executed('unknown-status'), executed('completed', 'invented-success'),
    { schemaVersion: 1, results: [{ status: 'completed' }] },
    { schemaVersion: 1, results: [executed().results[0], executed().results[0]] }]) {
    let attempts = 0;
    const output = await runWorkerLoop(options({ processApprovedJobs: true, maxCycles: 5, executionLimit: 1 }), adapters({
      runApproved: async () => { attempts += 1; return result; },
    }));
    assert.equal(output.stopReason, 'execution-error');
    assert.equal(output.cycles[0].execution.reason, 'invalid-result');
    assert.equal(attempts, 1);
  }
});

test('adapter result getters and proxies are not evaluated when producing summaries', async () => {
  let calls = 0;
  const malicious = { schemaVersion: 1, results: [{}] };
  Object.defineProperty(malicious.results[0], 'status', { get() { calls += 1; throw new Error('must not execute'); } });
  const output = await runWorkerLoop(options(), adapters({ observe: async () => malicious }));
  assert.equal(output.cycles[0].observation.reason, 'invalid-result');
  const proxied = { schemaVersion: 1, results: new Proxy([], { get() { calls += 1; throw new Error('must not execute'); } }) };
  const output2 = await runWorkerLoop(options(), adapters({ observe: async () => proxied }));
  assert.equal(output2.cycles[0].observation.reason, 'invalid-result');
  assert.equal(calls, 0);
});

test('loop configuration is copied before asynchronous work and cannot expand mid-run', async () => {
  const input = options({ maxCycles: 2, intervalMs: 1000, processApprovedJobs: false });
  let executions = 0;
  let observations = 0;
  const delays = [];
  const result = await runWorkerLoop(input, adapters({ observe: async () => {
    observations += 1;
    input.maxCycles = 1000;
    input.intervalMs = 2000;
    input.processApprovedJobs = true;
    return observed();
  }, runApproved: async () => { executions += 1; return executed(); }, delay: async milliseconds => { delays.push(milliseconds); } }));
  assert.equal(result.cycles.length, 2);
  assert.equal(observations, 2);
  assert.equal(executions, 0);
  assert.deepEqual(delays, [1000]);
});

for (const overrides of [
  { maxCycles: 0 }, { maxCycles: 1001 }, { maxCycles: 1.5 }, { maxCycles: Number.NaN },
  { intervalMs: 0 }, { intervalMs: 999 }, { intervalMs: 3_600_001 }, { intervalMs: Infinity },
  { maxObservationFailures: 0 }, { maxObservationFailures: 11 },
  { intervalMs: 5000, maxObservationBackoffMs: 4999 }, { maxObservationBackoffMs: 3_600_001 },
  { executionLimit: 0 }, { executionLimit: 11 }, { processApprovedJobs: 'true' },
  { subscriptionId: 'unknown' }, { signal: {} }, { statePath: '' }, { statePath: 'bad\0path' }, { enginePath: '' },
]) {
  test(`invalid bounded loop option is rejected before callbacks: ${Object.keys(overrides).join(',')}`, async () => {
    let calls = 0;
    await assert.rejects(runWorkerLoop(options(overrides), adapters({ observe: async () => { calls += 1; return observed(); } })),
      error => error.code === 'INVALID_INPUT');
    assert.equal(calls, 0);
  });
}
