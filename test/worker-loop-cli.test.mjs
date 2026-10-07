import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runWorkerLoopCli } from '../dist/worker-loop-cli.js';
import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';

const cycle = { observation: { status: 'completed', counts: { observed: 0, unchanged: 1, busy: 0, failed: 0 } } };
async function invoke(args, loop) {
  let stdout = ''; let stderr = '';
  const code = await runWorkerLoopCli(args, { loop, stdout: text => { stdout += text; }, stderr: text => { stderr += text; } });
  return { code, stdout, stderr };
}
test('worker-loop CLI opts into processing approvals only explicitly and removes signal handlers', async () => {
  const before = process.listenerCount('SIGINT');
  for (const enabled of [false, true]) {
    const args = ['worker-loop', '--state', 'fixture-state', '--engine', 'fixture-engine', '--cycles', '2', '--interval-ms', '1000', '--json'];
    if (enabled) args.push('--run-approved');
    const result = await invoke(args, async options => {
      assert.equal(options.processApprovedJobs, enabled); assert.equal(options.maxCycles, 2); assert.equal(options.intervalMs, 1000);
      assert.equal(options.signal.aborted, false);
      return { schemaVersion: 1, stopReason: 'max-cycles', abortRequested: false, cycles: [cycle] };
    });
    assert.equal(result.code, 0); assert.equal(JSON.parse(result.stdout).cycles.length, 1);
    assert.equal(process.listenerCount('SIGINT'), before);
  }
});
test('worker-loop reports interrupted and attention results without pretending success', async () => {
  for (const [stopReason, expected] of [['aborted', 130], ['execution-attention', 2], ['observation-failure-limit', 2]]) {
    const result = await invoke(['worker-loop', '--state', 's', '--engine', 'e'], async () => ({ stopReason, cycles: [] }));
    assert.equal(result.code, expected);
  }
});
test('invalid loop arguments fail before starting any work', async () => {
  for (const args of [['worker-loop'], ['worker-loop', '--state', 's', '--engine', 'e', '--cycles', '1.5'],
    ['worker-loop', '--state', 's', '--engine', 'e', '--state', 'other'], ['worker-loop', '--state', 's', '--engine', 'e', 'extra']]) {
    const result = await invoke(args, () => assert.fail('must not start'));
    assert.equal(result.code, 2); assert.equal(result.stdout, '');
  }
});
test('a real missing worker database fails the CLI even when the finite cycle limit is reached', async () => {
  const state = resolve('work', `missing-loop-${randomUUID()}`);
  const result = await invoke(['worker-loop', '--state', state, '--engine', 'unused-engine', '--json']);
  const output = JSON.parse(result.stdout);
  assert.equal(output.stopReason, 'max-cycles');
  assert.equal(output.cycles[0].observation.status, 'failed');
  assert.equal(output.cycles[0].observation.counts.failed, 0);
  assert.equal(result.code, 2);
  await assert.rejects(access(state), { code: 'ENOENT' });
});
test('repeated termination signals keep draining the active operation and remove handlers afterwards', async () => {
  const before = process.listenerCount('SIGINT');
  let finish;
  const active = new Promise(resolveStep => { finish = resolveStep; });
  let selectedSignal;
  const pending = invoke(['worker-loop', '--state', 's', '--engine', 'e'], async ({ signal }) => {
    selectedSignal = signal;
    await active;
    return { stopReason: 'aborted', cycles: [] };
  });
  try {
    assert.equal(process.listenerCount('SIGINT'), before + 1);
    process.emit('SIGINT'); process.emit('SIGINT');
    assert.equal(selectedSignal.aborted, true);
    assert.equal(process.listenerCount('SIGINT'), before + 1);
  } finally { finish(); await pending; }
  assert.equal((await pending).code, 130);
  assert.equal(process.listenerCount('SIGINT'), before);
});
