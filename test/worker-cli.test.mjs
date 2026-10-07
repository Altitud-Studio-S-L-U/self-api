import assert from 'node:assert/strict';
import test from 'node:test';
import { runWorkerCli } from '../dist/worker-cli.js';
import { PlumberError } from '../dist/errors.js';

const forbiddenControls = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/u;
const subscription = {
  id: 'subscription-1',
  label: 'Fictional Orders',
  configuredBaselineSha: '1'.repeat(64),
  lastObservedSha: '2'.repeat(64),
  createdAt: '2026-10-07T10:00:00.000Z',
  lastCheckedAt: '2026-10-07T10:01:00.000Z',
  lastSucceededAt: '2026-10-07T10:01:00.000Z',
  lastError: null,
  adopted: 'unknown',
  deployed: 'unknown',
};
const job = {
  id: 'job-1',
  subscriptionId: subscription.id,
  status: 'review-required',
  baselineSha: subscription.configuredBaselineSha,
  revisionSha: subscription.lastObservedSha,
  consumerDigest: '3'.repeat(64),
  report: { privateReportFixture: 'not-for-text-output' },
};
const subscribeArgs = ['subscribe', 'provider source.json', '--baseline', 'base.json', '--consumer', 'consumer project',
  '--provider-base-url', 'https://orders.example.invalid', '--engine', 'local engine', '--state', 'private state'];
const workerArgs = ['worker', '--once', '--state', 'private state', '--engine', 'local engine'];

async function capture(args, replacements = {}) {
  let stdout = '';
  let stderr = '';
  const calls = [];
  const defaults = {
    register: subscription,
    observe: { schemaVersion: 1, results: [] },
    subscriptions: [subscription],
    jobs: [job],
  };
  const adapters = Object.fromEntries(Object.entries(defaults).map(([name, result]) => [name, async input => {
    calls.push({ name, input });
    return replacements[name] ? replacements[name](input) : result;
  }]));
  const code = await runWorkerCli(args, {
    ...adapters,
    stdout: text => { stdout += text; },
    stderr: text => { stderr += text; },
  });
  return { code, stdout, stderr, calls };
}

test('subscribe forwards explicit configuration and only registers the subscription', async () => {
  const result = await capture([...subscribeArgs, '--label', 'Orders fixture', '--json']);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(result.calls, [{ name: 'register', input: {
    sourcePath: 'provider source.json', baselinePath: 'base.json', consumerRoot: 'consumer project',
    providerBaseUrl: 'https://orders.example.invalid', enginePath: 'local engine', statePath: 'private state', label: 'Orders fixture',
  } }]);
  assert.deepEqual(JSON.parse(result.stdout), subscription);
  const noLabel = await capture(subscribeArgs);
  assert.equal(noLabel.code, 0);
  assert.ok(!Object.hasOwn(noLabel.calls[0].input, 'label'));
  assert.match(noLabel.stdout, /Adoption: unknown\. Deployment: unknown/u);
});

test('worker requires an explicit once action and never invokes a second workflow', async () => {
  const result = await capture([...workerArgs, '--subscription', 'subscription-1', '--json']);
  assert.equal(result.code, 0);
  assert.deepEqual(result.calls, [{ name: 'observe', input: {
    statePath: 'private state', enginePath: 'local engine', subscriptionId: 'subscription-1',
  } }]);
  assert.deepEqual(JSON.parse(result.stdout), { schemaVersion: 1, results: [] });
  const all = await capture(workerArgs);
  assert.equal(all.code, 0);
  assert.ok(!Object.hasOwn(all.calls[0].input, 'subscriptionId'));
  assert.match(all.stdout, /No approval, consumer execution, or publication/u);
  const missingOnce = await capture(['worker', '--state', 'private state', '--engine', 'local engine']);
  assert.equal(missingOnce.code, 2);
  assert.deepEqual(missingOnce.calls, []);
});

test('worker exit codes distinguish pending review from incomplete observations', async () => {
  for (const [results, expected] of [
    [[], 0],
    [[{ subscriptionId: 's', status: 'unchanged' }], 0],
    [[{ subscriptionId: 's', status: 'observed' }], 0],
    [[{ subscriptionId: 's', status: 'observed', jobId: 'j', created: true }], 1],
    [[{ subscriptionId: 's', status: 'unchanged', jobId: 'j', created: false }], 1],
    [[{ subscriptionId: 's', status: 'busy' }], 2],
    [[{ subscriptionId: 's', status: 'failed', reason: 'fixture failure' }], 2],
    [[{ subscriptionId: 's', status: 'observed', jobId: 'j' }, { subscriptionId: 'other', status: 'busy' }], 2],
    [[{ subscriptionId: 's', status: 'observed', jobId: 'j' }, { subscriptionId: 'other', status: 'failed' }], 2],
  ]) {
    const observation = { schemaVersion: 1, results };
    const result = await capture([...workerArgs, '--json'], { observe: async () => observation });
    assert.equal(result.code, expected, JSON.stringify(results));
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), observation);
    assert.equal(result.calls.length, 1);
  }
});

test('subscription and job listing forward only the state directory and preserve JSON results', async () => {
  for (const [command, expected] of [['subscriptions', [subscription]], ['jobs', [job]]]) {
    const result = await capture([command, '--state', 'private state', '--json']);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    assert.deepEqual(result.calls, [{ name: command, input: { statePath: 'private state' } }]);
    assert.deepEqual(JSON.parse(result.stdout), expected);
  }
});

test('unsupported option mixes, duplicate flags, and execution options are rejected before any API call', async () => {
  for (const args of [
    [], ['unknown'], ['subscriptions'], ['jobs', '--state', ''],
    ['worker', '--state', 'private state', '--engine', 'local engine'],
    ['worker', '--once', '--state', 'private state'],
    [...workerArgs, '--once'], [...workerArgs, '--state', 'another-state'],
    [...workerArgs, '--consumer', 'consumer'], [...workerArgs, '--baseline', 'base.json'],
    [...workerArgs, '--label', 'label'], [...workerArgs, '--subscription', ''],
    [...workerArgs, '--approval', 'receipt'], [...workerArgs, '--recipe', 'recipe.json'],
    [...workerArgs, '--test', 'consumer.test.mjs'], [...workerArgs, '--execute'],
    [...workerArgs, '--once=false'], [...workerArgs, 'extra'],
    [...subscribeArgs, '--once'], [...subscribeArgs, '--subscription', 'id'],
    [...subscribeArgs, '--label', ' '], subscribeArgs.slice(0, -2),
    ['subscribe', 'source.json', '--state', 'state'],
    ['subscriptions', '--state', 'state', '--engine', 'engine'],
    ['jobs', '--state', 'state', '--baseline', ''],
    ['jobs', '--state', 'state', '--json=true'],
  ]) {
    const result = await capture(args);
    assert.equal(result.code, 2, JSON.stringify(args));
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error.code, 'INVALID_INPUT');
    assert.deepEqual(result.calls, []);
  }
});

test('text summaries escape labels and identifiers while withholding stored reports and error details', async () => {
  const marker = 'private-raw-detail-must-not-appear';
  const tainted = 'fixture\u001b[31m\n\u009b\u202e';
  const subscriptions = await capture(['subscriptions', '--state', 'state'], {
    subscriptions: async () => [{ ...subscription, id: tainted, label: tainted, configuredBaselineSha: tainted, lastObservedSha: null, lastError: marker }],
  });
  const jobs = await capture(['jobs', '--state', 'state'], {
    jobs: async () => [{ ...job, id: tainted, subscriptionId: tainted, baselineSha: tainted, revisionSha: tainted, consumerDigest: tainted, report: marker }],
  });
  const observed = await capture(workerArgs, {
    observe: async () => ({ schemaVersion: 1, results: [{ subscriptionId: tainted, status: 'failed', jobId: tainted, reason: marker }] }),
  });
  for (const result of [subscriptions, jobs, observed]) {
    assert.equal(result.stderr, '');
    assert.doesNotMatch(result.stdout, forbiddenControls);
    assert.ok(!result.stdout.includes(marker));
    assert.ok(result.stdout.includes('\\u001b'));
  }
});

test('JSON output retains local data while escaping terminal control characters', async () => {
  const raw = { ...job, report: { value: '\u001b\u009b\u202e\nprivate fixture' } };
  const result = await capture(['jobs', '--state', 'state', '--json'], { jobs: async () => [raw] });
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), [raw]);
  assert.doesNotMatch(result.stdout, forbiddenControls);
});

test('known errors use escaped JSON stderr and unexpected errors do not disclose internal details', async () => {
  const message = 'Missing engine\u001b\u009b\u202e\nfixture';
  for (const args of [workerArgs, [...workerArgs, '--json']]) {
    const known = await capture(args, { observe: async () => { throw new PlumberError('ENGINE_UNAVAILABLE', message); } });
    assert.equal(known.code, 2);
    assert.equal(known.stdout, '');
    assert.deepEqual(JSON.parse(known.stderr), { error: { code: 'ENGINE_UNAVAILABLE', message } });
    assert.doesNotMatch(known.stderr, forbiddenControls);
    const unexpected = await capture(args, { observe: async () => { throw new Error('private token fixture'); } });
    assert.equal(unexpected.code, 2);
    assert.equal(unexpected.stdout, '');
    assert.deepEqual(JSON.parse(unexpected.stderr), { error: { code: 'ENGINE_FAILED', message: 'Worker command failed unexpectedly.' } });
    assert.ok(!unexpected.stderr.includes('private token fixture'));
  }
  const malformed = await capture([...workerArgs, '--unknown\u001b\u009b']);
  assert.equal(malformed.code, 2);
  assert.doesNotMatch(malformed.stderr, forbiddenControls);
});
