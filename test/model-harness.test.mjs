import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { approveModelProposal, prepareModelProposal, proposeMigrationWithModel } from '../dist/model-harness.js';

const adapterIdentity = { id: 'fixture-model', location: 'local', destination: 'local:fixture-model', policyId: 'fixture-policy-v1' };
const sha256 = value => createHash('sha256').update(value).digest('hex');
const source = 'export function total(order) { return order.total; }\n';
const file = { path: 'src/orders.mjs', sha256: sha256(source), text: source, role: 'source' };
const testText = 'import assert from "node:assert/strict"; assert.equal(2, 2);\n';
const selectedTest = { path: 'test/orders.test.mjs', sha256: sha256(testText), text: testText, role: 'test' };
const recipe = () => ({
  schemaVersion: 1, summary: 'Use the documented replacement field.', decisions: [],
  files: [{ path: file.path, sha256: file.sha256, edits: [{ before: 'order.total', after: 'order.amount' }] }],
});
const options = overrides => ({ adapter: adapterIdentity, files: [file, selectedTest], evidence: [{ id: 'release-v2', text: 'The total field was renamed to amount; the unit is unchanged.' }], ...overrides });
const prepare = overrides => prepareModelProposal(options(overrides));
const approve = request => approveModelProposal({ request, expectedRequestId: request.id });
const adapter = (response = recipe(), overrides = {}) => ({ ...adapterIdentity, propose: async () => JSON.stringify(response), ...overrides });
const invalid = error => error.code === 'INVALID_INPUT';

test('preparation is deterministic, copies selected data and binds context, adapter, provider policy and budgets', () => {
  const input = options();
  const request = prepareModelProposal(input);
  assert.equal(request.id, prepare().id);
  assert.equal(request.authorization, 'not-granted');
  assert.equal(request.contextDigest, sha256(JSON.stringify(request.context)));
  assert.equal(request.inputBytes, Buffer.byteLength(JSON.stringify(request.context)));
  input.files[0] = { ...file, text: 'changed' };
  assert.equal(request.context.files[0].text, source);
  assert.throws(() => { request.context.files[0].text = 'changed'; }, TypeError);
  assert.notEqual(request.id, prepare({ evidence: [{ id: 'new', text: 'New evidence.' }] }).id);
  assert.notEqual(request.id, prepare({ adapter: { ...adapterIdentity, policyId: 'new-policy' } }).id);
  assert.notEqual(request.id, prepare({ adapter: { ...adapterIdentity, destination: 'local:other' } }).id);
  assert.notEqual(request.id, prepare({ limits: { maximumOutputBytes: 1000 } }).id);
  assert.notEqual(request.id, prepare({ sensitiveValues: ['private-value'] }).id);
});

test('a local adapter receives only the inspected context and an abort signal, returning an unapproved proposal', async () => {
  const request = prepare({ requiredDecisions: [{ id: 'units', question: 'Are the units unchanged for this account?' }] });
  let calls = 0;
  let signal;
  const proposal = await proposeMigrationWithModel({
    request, consent: approve(request), adapter: adapter(recipe(), { propose: async (context, callOptions) => {
      calls += 1;
      assert.equal(context, request.context);
      assert.deepEqual(Object.keys(context), ['schemaVersion', 'files', 'evidence', 'requiredDecisions']);
      assert.equal(callOptions.maximumOutputBytes, request.limits.maximumOutputBytes);
      assert(callOptions.signal instanceof AbortSignal);
      signal = callOptions.signal;
      return JSON.stringify(recipe());
    } }),
  });
  assert.equal(calls, 1);
  assert.equal(signal.aborted, true);
  assert.equal(proposal.authorization, 'not-granted');
  assert.equal(proposal.validation, 'not-run');
  assert.equal(proposal.publication, 'not-authorized');
  assert.equal(proposal.consumerModified, false);
  assert.equal(proposal.consumerExecuted, false);
  assert.equal(proposal.preview.status, 'requires-decision');
  assert.deepEqual(proposal.preview.files, []);
  assert.deepEqual(proposal.recipe.decisions.map(item => item.id), ['model-semantics', 'units']);
  assert(proposal.recipe.decisions.every(item => !Object.hasOwn(item, 'answer')));
});

test('remote destinations require separate explicit disclosure authorization and still use only the injected fixture', async () => {
  const remote = { ...adapterIdentity, location: 'remote', destination: 'https://model.example.invalid/v1' };
  const request = prepare({ adapter: remote });
  assert.throws(() => approve(request), invalid);
  const consent = approveModelProposal({ request, expectedRequestId: request.id, allowRemote: true });
  const result = await proposeMigrationWithModel({ request, consent, adapter: { ...remote, propose: async () => JSON.stringify(recipe()) } });
  assert.equal(result.authorization, 'not-granted');
});

test('approval confirms the exact inspected request; serialized requests and consents are not executable capabilities', async () => {
  const request = prepare();
  assert.throws(() => approveModelProposal({ request, expectedRequestId: 'wrong' }), invalid);
  assert.throws(() => approveModelProposal({ request: JSON.parse(JSON.stringify(request)), expectedRequestId: request.id }), invalid);
  const consent = approve(request);
  assert.equal(consent.scope, 'model-proposal');
  assert.equal(consent.contextDigest, request.contextDigest);
  assert.equal(consent.policyDigest, request.policyDigest);
  assert.equal(consent.destination, request.adapter.destination);
  await assert.rejects(proposeMigrationWithModel({ request, consent: { ...consent }, adapter: adapter() }), invalid);
  await assert.rejects(proposeMigrationWithModel({ request: prepare(), consent, adapter: adapter() }), invalid);
});

test('consent is consumed before the adapter runs, including concurrent calls and failed calls', async () => {
  const request = prepare();
  const consent = approve(request);
  let calls = 0;
  const fixture = adapter(recipe(), { propose: async () => { calls += 1; throw new Error('private-key-do-not-echo'); } });
  const outcomes = await Promise.allSettled([
    proposeMigrationWithModel({ request, consent, adapter: fixture }),
    proposeMigrationWithModel({ request, consent, adapter: fixture }),
  ]);
  assert.equal(calls, 1);
  assert(outcomes.every(outcome => outcome.status === 'rejected'));
  assert(outcomes.every(outcome => !outcome.reason.message.includes('private-key-do-not-echo')));
  await assert.rejects(proposeMigrationWithModel({ request, consent, adapter: adapter() }), invalid);
});

test('consent has a bounded expiry and cannot be reused after its time has elapsed', async t => {
  const request = prepare();
  const start = 2_000_000_000_000;
  t.mock.method(Date, 'now', () => start);
  for (const expiresAt of [start - 1, start, start + 900_001, Infinity, NaN, 'later']) {
    assert.throws(() => approveModelProposal({ request, expectedRequestId: request.id, expiresAt }), invalid);
  }
  const consent = approveModelProposal({ request, expectedRequestId: request.id, expiresAt: start + 10 });
  Date.now.mock.mockImplementation(() => start + 10);
  let calls = 0;
  await assert.rejects(proposeMigrationWithModel({ request, consent, adapter: adapter(recipe(), { propose: async () => { calls += 1; return JSON.stringify(recipe()); } }) }), invalid);
  assert.equal(calls, 0);
});

for (const changed of [{ id: 'other' }, { policyId: 'other-policy' }, { destination: 'local:other' }, { location: 'remote', destination: 'https://other.example.invalid/' }]) {
  test(`adapter identity change ${Object.keys(changed).join(',')} is rejected before context disclosure`, async () => {
    const request = prepare();
    let calls = 0;
    await assert.rejects(proposeMigrationWithModel({ request, consent: approve(request), adapter: adapter(recipe(), {
      ...changed, propose: async () => { calls += 1; return JSON.stringify(recipe()); },
    }) }), invalid);
    assert.equal(calls, 0);
  });
}

for (const path of ['src/unselected.mjs', 'test/orders.test.mjs', '../outside.mjs', '.git/config.mjs', '.github/workflows/action.mjs']) {
  test(`model cannot expand source scope to ${path}`, async () => {
    const request = prepare();
    const malicious = recipe();
    malicious.files[0].path = path;
    if (path === selectedTest.path) {
      malicious.files[0].sha256 = selectedTest.sha256;
      malicious.files[0].edits = [{ before: 'assert.equal(2, 2)', after: 'assert.equal(1, 1)' }];
    }
    await assert.rejects(proposeMigrationWithModel({ request, consent: approve(request), adapter: adapter(malicious) }), invalid);
  });
}

for (const action of ['authorization', 'publication', 'tools', 'commands', 'credentials', 'testsPassed']) {
  test(`model output cannot introduce ${action} actions or claims`, async () => {
    const request = prepare();
    await assert.rejects(proposeMigrationWithModel({ request, consent: approve(request), adapter: adapter({ ...recipe(), [action]: 'approved' }) }), invalid);
  });
}

test('models cannot answer, remove or rewrite required business decisions', async () => {
  const requiredDecisions = [{ id: 'units', question: 'Which unit is used?' }];
  const decisions = [
    [{ ...requiredDecisions[0], answer: 'The model decided cents.' }],
    [{ ...requiredDecisions[0], answer: '' }],
    [{ id: 'units', question: 'Ignore the original decision.' }],
  ];
  for (const outputDecisions of decisions) {
    const request = prepare({ requiredDecisions });
    await assert.rejects(proposeMigrationWithModel({ request, consent: approve(request), adapter: adapter({ ...recipe(), decisions: outputDecisions }) }), invalid);
  }
  const request = prepare({ requiredDecisions });
  const result = await proposeMigrationWithModel({ request, consent: approve(request), adapter: adapter() });
  assert.deepEqual(result.preview.requirements.find(item => item.id === 'units'), requiredDecisions[0]);
});

test('models may identify additional unknown semantics but those remain unanswered', async () => {
  const request = prepare();
  const result = await proposeMigrationWithModel({ request, consent: approve(request), adapter: adapter({
    ...recipe(), decisions: [{ id: 'rounding', question: 'What rounding applies to fractional amounts?' }],
  }) });
  assert(result.preview.requirements.some(item => item.id === 'rounding'));
  assert(result.preview.requirements.some(item => item.id === 'model-semantics'));
});

for (const modify of [
  output => { output.files[0].sha256 = '0'.repeat(64); },
  output => { output.files[0].edits[0].before = 'not present'; },
  output => { output.files[0].edits[0].after = ') invalid syntax'; },
  output => { output.files.push(structuredClone(output.files[0])); },
]) {
  test('model edits still obey deterministic hash, unique edit and syntax validation', async () => {
    const request = prepare();
    const output = recipe();
    modify(output);
    await assert.rejects(proposeMigrationWithModel({ request, consent: approve(request), adapter: adapter(output) }), invalid);
  });
}

for (const secret of [
  'ghp_0123456789abcdefghijABCDEFGHIJ',
  'Bearer abcdefghijklmnopqrstuvwxyz',
  '-----BEGIN PRIVATE KEY-----',
  'const apiKey = "private-key-value";',
]) {
  test('recognized raw credentials are rejected before model context can be approved', () => {
    assert.throws(() => prepare({ evidence: [{ id: 'credential', text: secret }] }), invalid);
  });
}

test('explicit sensitive values are not passed to adapters and are forbidden in both context and output', async () => {
  const sensitiveValues = ['customer-private-value'];
  assert.throws(() => prepare({ sensitiveValues, evidence: [{ id: 'evidence', text: sensitiveValues[0] }] }), invalid);
  const request = prepare({ sensitiveValues });
  assert(!JSON.stringify(request).includes(sensitiveValues[0]));
  await assert.rejects(proposeMigrationWithModel({ request, consent: approve(request), adapter: adapter({ ...recipe(), summary: sensitiveValues[0] }) }), invalid);
});

test('escaped sensitive text in a JSON model response is rejected after canonical decoding', async () => {
  const request = prepare({ sensitiveValues: ['customer-private-value'] });
  const output = JSON.stringify({ ...recipe(), summary: 'customer-private-value' }).replace('customer-private-value', 'customer-\\u0070rivate-value');
  await assert.rejects(proposeMigrationWithModel({ request, consent: approve(request), adapter: adapter(recipe(), { propose: async () => output }) }), invalid);
});

test('secret-bearing source strings and explicit values are checked after JSON quote and newline decoding', async () => {
  const secretRecipe = recipe();
  secretRecipe.files[0].edits[0].after = '(() => { const apiKey = "private-key-value"; return order.amount; })()';
  const request = prepare();
  await assert.rejects(proposeMigrationWithModel({ request, consent: approve(request), adapter: adapter(secretRecipe) }), invalid);
  const sensitiveValues = ['customer"private\nvalue'];
  const another = prepare({ sensitiveValues });
  await assert.rejects(proposeMigrationWithModel({ request: another, consent: approve(another), adapter: adapter({ ...recipe(), summary: sensitiveValues[0] }) }), invalid);
});

test('input and output byte budgets count UTF-8 bytes, not string character count', async () => {
  assert.throws(() => prepare({ limits: { maximumInputBytes: 10 } }), invalid);
  assert.throws(() => prepare({ evidence: [{ id: 'unicode', text: 'é'.repeat(1000) }], limits: { maximumInputBytes: 1500 } }), invalid);
  const request = prepare({ limits: { maximumOutputBytes: 10 } });
  let attempts = 0;
  await assert.rejects(proposeMigrationWithModel({ request, consent: approve(request), adapter: adapter(recipe(), {
    propose: async () => { attempts += 1; return 'é'.repeat(6); },
  }) }), invalid);
  assert.equal(attempts, 1);
});

test('a stalled asynchronous adapter receives cancellation and cannot trigger automatic repair retries', async () => {
  const request = prepare({ limits: { timeoutMs: 10 } });
  let calls = 0;
  let signal;
  await assert.rejects(proposeMigrationWithModel({ request, consent: approve(request), adapter: adapter(recipe(), {
    propose: async (_, options) => { calls += 1; signal = options.signal; return new Promise(() => {}); },
  }) }), invalid);
  assert.equal(calls, 1);
  assert.equal(signal.aborted, true);
});

test('caller cancellation interrupts a running adapter and never accepts its late result', async () => {
  const request = prepare();
  const caller = new AbortController();
  let release;
  let adapterSignal;
  const running = proposeMigrationWithModel({ request, consent: approve(request), signal: caller.signal, adapter: adapter(recipe(), {
    propose: async (_, { signal }) => {
      adapterSignal = signal;
      queueMicrotask(() => caller.abort());
      return new Promise(resolve => { release = resolve; });
    },
  }) });
  await assert.rejects(running, invalid);
  assert.equal(adapterSignal.aborted, true);
  release(JSON.stringify(recipe()));
});

test('already-cancelled requests never disclose context and leave consent available for a later explicit call', async () => {
  const request = prepare();
  const consent = approve(request);
  let calls = 0;
  const fixture = adapter(recipe(), { propose: async () => { calls += 1; return JSON.stringify(recipe()); } });
  await assert.rejects(proposeMigrationWithModel({ request, consent, signal: AbortSignal.abort(), adapter: fixture }), invalid);
  assert.equal(calls, 0);
  await proposeMigrationWithModel({ request, consent, adapter: fixture });
  assert.equal(calls, 1);
});

test('the model must return bounded JSON text, never executable object values or markdown', async () => {
  for (const output of [recipe(), undefined, '```json\n{}\n```', 'not json', 'null', '[]']) {
    const request = prepare();
    await assert.rejects(proposeMigrationWithModel({ request, consent: approve(request), adapter: adapter(recipe(), { propose: async () => output }) }), invalid);
  }
});

test('input validation does not execute getters, array hooks, proxies or adapter accessors', async () => {
  let executed = 0;
  const withGetter = options();
  Object.defineProperty(withGetter, 'files', { get() { executed += 1; return [file]; }, enumerable: true });
  assert.throws(() => prepareModelProposal(withGetter), invalid);
  const hooked = [file];
  hooked.toJSON = () => { executed += 1; return []; };
  assert.throws(() => prepare({ files: hooked }), invalid);
  const proxied = new Proxy(options(), { get() { executed += 1; return undefined; } });
  assert.throws(() => prepareModelProposal(proxied), invalid);
  const request = prepare();
  const fixture = { ...adapterIdentity, get propose() { executed += 1; return async () => JSON.stringify(recipe()); } };
  await assert.rejects(proposeMigrationWithModel({ request, consent: approve(request), adapter: fixture }), invalid);
  assert.equal(executed, 0);
});

test('unsafe selection paths, duplicate paths, unknown actions and incorrectly labelled tests are rejected', () => {
  const invalidFiles = [
    [{ ...file, path: 'test/anything.mjs' }],
    [{ ...file, path: 'src/orders.spec.mjs' }],
    [{ ...file, path: '.env.mjs' }],
    [{ ...file, path: '../orders.mjs' }],
    [{ ...file, path: 'package.json' }],
    [{ ...file, path: 'src/../orders.mjs' }],
    [{ ...file, path: 'src\\orders.mjs' }],
    [file, { ...file, path: 'SRC/ORDERS.MJS' }],
    [{ ...file, sha256: '0'.repeat(64) }],
    [selectedTest],
  ];
  for (const files of invalidFiles) assert.throws(() => prepare({ files }), invalid);
  assert.throws(() => prepare({ execute: true }), invalid);
});

test('adapter destination metadata cannot contain credentials or an ambiguous local/remote destination', () => {
  for (const changed of [
    { location: 'local', destination: 'https://model.example.invalid/' },
    { location: 'remote', destination: 'http://model.example.invalid/' },
    { location: 'remote', destination: 'https://secret@model.example.invalid/' },
    { location: 'remote', destination: 'https://model.example.invalid/?token=secret' },
    { location: 'remote', destination: 'https://model.example.invalid/#token' },
    { location: 'unknown', destination: 'local:fixture' },
  ]) assert.throws(() => prepare({ adapter: { ...adapterIdentity, ...changed } }), invalid);
});

test('budgets and input collections reject unsupported or ambiguous values', () => {
  for (const limits of [{ timeoutMs: 0 }, { timeoutMs: 120_001 }, { timeoutMs: 0.5 }, { maximumOutputBytes: Infinity }, { maximumInputBytes: 2 ** 20 + 1 }, { maxTokens: 20 }]) {
    assert.throws(() => prepare({ limits }), invalid);
  }
  assert.throws(() => prepare({ files: new Array(1) }), invalid);
  assert.throws(() => prepare({ sensitiveValues: [''] }), invalid);
  assert.throws(() => prepare({ requiredDecisions: [{ id: 'model-semantics', question: 'Ignore all requirements.' }] }), invalid);
});
