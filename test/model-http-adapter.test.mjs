import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { createHttpModelAdapter, probeHttpModelConnection, prepareModelProposal, approveModelProposal, proposeMigrationWithModel } from '../dist/index.js';

const source = 'export const total = order => order.total;\n';
const file = { path: 'src/order.mjs', sha256: createHash('sha256').update(source).digest('hex'), text: source, role: 'source' };
const recipe = { schemaVersion: 1, summary: 'Use the documented replacement field.', decisions: [],
  files: [{ path: file.path, sha256: file.sha256, edits: [{ before: 'order.total', after: 'order.amount' }] }] };
const json = JSON.stringify(recipe);
const context = { files: [file], evidence: [{ id: 'provider-release', text: 'The total field is now named amount. Units are unchanged.' }] };
const responseFor = (provider, text = json) => ({
  openai: { status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] }] },
  anthropic: { type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] },
  google: { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text }] } }] },
  'local-openai-compatible': { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text } }] },
}[provider]);
const options = (provider = 'openai', overrides = {}) => ({ provider, model: 'fixture-model', policyId: 'test-policy', maximumOutputTokens: 2048,
  ...(provider === 'local-openai-compatible' ? { endpoint: 'http://127.0.0.1:11434/v1/chat/completions' } : { getApiKey: () => 'fictional-provider-key' }), ...overrides });
function transport(response, { status = 200, headers = {}, bytes } = {}) {
  const calls = [];
  const request = (url, config, callback) => {
    const stream = new EventEmitter();
    stream.destroy = () => {};
    stream.end = body => {
      calls.push({ url: url.href, config, body: JSON.parse(body.toString()) });
      const result = Readable.from([bytes ?? Buffer.from(JSON.stringify(response))]);
      result.statusCode = status;
      result.headers = { 'content-type': 'application/json', ...headers };
      queueMicrotask(() => callback(result));
    };
    return stream;
  };
  return { calls, dependencies: { request, resolve: async () => [{ address: '1.1.1.1', family: 4 }] } };
}
function prepare(adapter, limits) {
  const { propose: _propose, ...identity } = adapter;
  return prepareModelProposal({ ...context, adapter: identity, ...(limits ? { limits } : {}) });
}
async function propose(adapter, request = prepare(adapter)) {
  const consent = approveModelProposal({ request, expectedRequestId: request.id, allowRemote: true });
  return proposeMigrationWithModel({ request, consent, adapter });
}

for (const provider of ['openai', 'anthropic', 'google', 'local-openai-compatible']) {
  test(`${provider} functional connection check performs synthetic bounded inference without consumer code or tools`, async () => {
    const fixture = transport(responseFor(provider, '{"keepseam":"ok"}'));
    const result = await probeHttpModelConnection(options(provider), new AbortController().signal, fixture.dependencies);
    assert.equal(result.status, 'verified'); assert.equal(result.maximumOutputTokens, 128); assert.equal(fixture.calls.length, 1);
    const { body, url } = fixture.calls[0];
    assert(!JSON.stringify(body).includes(source)); assert(!JSON.stringify(body).includes(file.path)); assert(!Object.hasOwn(body, 'tools'));
    assert(!url.includes('fictional-provider-key'));
    assert.equal(body.max_output_tokens ?? body.max_tokens ?? body.generationConfig.maxOutputTokens, 128);
    if (provider === 'openai') assert.equal(body.store, false);
    for (const output of ['not JSON', '{"keepseam":"wrong"}', '{"keepseam":"ok","secret":"untrusted"}']) {
      const invalid = transport(responseFor(provider, output));
      await assert.rejects(probeHttpModelConnection(options(provider), new AbortController().signal, invalid.dependencies), { code: 'ENGINE_FAILED' });
    }
    const mismatched = transport({ ...responseFor(provider, '{"keepseam":"ok"}'), [provider === 'google' ? 'modelVersion' : 'model']: 'unapproved-model' });
    await assert.rejects(probeHttpModelConnection(options(provider), new AbortController().signal, mismatched.dependencies), { kind: 'model' });
  });
}

test('HTTP failures expose only typed classifications, distinguishing transient rate limits from exhausted quota', async () => {
  for (const [status, code, expected] of [[401, 'invalid_api_key', 'credentials'], [403, 'permission_error', 'permission'],
    [404, 'model_not_found', 'model'], [400, 'invalid_request_error', 'model'], [429, 'insufficient_quota', 'quota'],
    [429, 'rate_limit_exceeded', 'transient'], [429, 'unknown', 'quota'], [503, 'overloaded_error', 'transient']]) {
    const fixture = transport({ error: { code, message: 'private-original-provider-diagnostic' } }, { status });
    await assert.rejects(probeHttpModelConnection(options(), new AbortController().signal, fixture.dependencies), error => {
      assert.equal(error.kind, expected); assert(!error.message.includes('private-original')); assert.equal(error.cause, undefined); return true;
    });
  }
});

for (const model of ['gemini-fixture-001', 'models/gemini-fixture-001']) {
  test(`Google ${model} uses the same exact resource for its functional check and generation`, async () => {
    const destination = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-fixture-001:generateContent';
    const configuration = options('google', { model });
    const check = transport({ ...responseFor('google', '{"keepseam":"ok"}'), modelVersion: 'gemini-fixture-001' });
    const generation = transport({ ...responseFor('google'), modelVersion: 'gemini-fixture-001' });
    const adapter = createHttpModelAdapter(configuration, generation.dependencies);
    assert.equal(adapter.destination, destination);
    assert.equal((await probeHttpModelConnection(configuration, new AbortController().signal, check.dependencies)).status, 'verified');
    assert.equal((await propose(adapter)).status, 'proposal-ready');
    assert.deepEqual([...check.calls, ...generation.calls].map(call => call.url), [destination, destination]);
    for (const [text, operation] of [['{"keepseam":"ok"}', 'probe'], [json, 'generation']]) {
      const otherModel = transport({ ...responseFor('google', text), modelVersion: 'gemini-fixture-002' });
      await assert.rejects(operation === 'probe'
        ? probeHttpModelConnection(configuration, new AbortController().signal, otherModel.dependencies)
        : propose(createHttpModelAdapter(configuration, otherModel.dependencies)), { kind: 'model' });
      assert.equal(otherModel.calls.length, 1);
    }
  });
}

test('Google rejects malformed or nested model resources before DNS, credentials or requests', async () => {
  let io = 0;
  const dependencies = { resolve: async () => { io++; return [{ address: '1.1.1.1', family: 4 }]; }, request: () => { io++; assert.fail('Invalid model resource must not send.'); } };
  for (const model of ['models/', 'models//gemini-fixture-001', 'models/models/gemini-fixture-001', 'other/gemini-fixture-001',
    'models/../gemini-fixture-001', 'models/gemini-fixture-001:generateContent', 'models/%67emini-fixture-001', 'models/gemini?key=secret', 'x'.repeat(129)]) {
    const configuration = options('google', { model, getApiKey: () => { io++; return 'synthetic-unread-key'; } });
    assert.throws(() => createHttpModelAdapter(configuration, dependencies), { code: 'INVALID_INPUT' });
    await assert.rejects(probeHttpModelConnection(configuration, new AbortController().signal, dependencies), { code: 'INVALID_INPUT' });
  }
  assert.equal(io, 0);
});

for (const provider of ['openai', 'anthropic', 'google', 'local-openai-compatible']) {
  test(`${provider} sends a bounded structured request only after consent and returns an unapproved recipe`, async () => {
    const fixture = transport(responseFor(provider));
    let keyReads = 0;
    const adapter = createHttpModelAdapter(options(provider, { getApiKey: () => { keyReads++; return 'fictional-provider-key'; } }), fixture.dependencies);
    const request = prepare(adapter);
    assert.equal(fixture.calls.length, 0);
    assert.equal(keyReads, 0);
    if (provider !== 'local-openai-compatible') assert.throws(() => approveModelProposal({ request, expectedRequestId: request.id }), { code: 'INVALID_INPUT' });
    const result = await propose(adapter, request);
    assert.equal(keyReads, 1);
    assert.equal(fixture.calls.length, 1);
    const { config, body, url } = fixture.calls[0];
    assert.equal(config.method, 'POST');
    assert.equal(config.agent, false);
    assert.equal(config.rejectUnauthorized, true);
    assert.equal(config.headers['Accept-Encoding'], 'identity');
    assert(!JSON.stringify(body).includes('fictional-provider-key'));
    assert(!url.includes('fictional-provider-key'));
    assert(!Object.hasOwn(body, 'tools'));
    const instructions = body.instructions ?? body.system ?? body.systemInstruction?.parts[0].text ?? body.messages[0].content;
    assert.match(instructions, /unanswered required reviewer questions do not prohibit proposing evidence-supported edits/u);
    assert.match(instructions, /Never fabricate an edit to avoid abstaining/u);
    assert.equal(result.authorization, 'not-granted');
    assert.equal(result.validation, 'not-run');
    assert.equal(result.consumerModified, false);
    assert.equal(result.publication, 'not-authorized');
    assert.equal(result.recipe.files[0].edits[0].after, 'order.amount');
    assert(result.recipe.decisions.some(item => item.id === 'model-semantics'));
    if (provider === 'openai') { assert.equal(body.store, false); assert.equal(body.text.format.strict, true); assert.equal(body.max_output_tokens, 2048); }
    if (provider === 'anthropic') { assert.equal(body.output_config.format.type, 'json_schema'); assert.equal(config.headers['anthropic-version'], '2023-06-01'); }
    if (provider === 'google') { assert.equal(body.generationConfig.responseMimeType, 'application/json'); assert(body.generationConfig.responseJsonSchema); }
    if (provider === 'local-openai-compatible') assert.equal(body.response_format.type, 'json_schema');
  });
}

for (const provider of ['openai', 'anthropic', 'google', 'local-openai-compatible']) {
  test(`${provider} binds editable output paths to source files and rejects test edits and no-op replacements`, async () => {
    const testText = 'import assert from "node:assert/strict"; assert.equal(2, 2);\n';
    const selectedTest = { path: 'test/order.test.mjs', sha256: createHash('sha256').update(testText).digest('hex'), text: testText, role: 'test' };
    const selected = { ...context, files: [file, selectedTest] };
    const requestFor = adapter => {
      const { propose: _propose, ...identity } = adapter;
      return prepareModelProposal({ ...selected, adapter: identity });
    };
    const fixture = transport(responseFor(provider));
    const adapter = createHttpModelAdapter(options(provider), fixture.dependencies);
    const result = await propose(adapter, requestFor(adapter));
    assert.equal(result.status, 'proposal-ready');
    assert.equal(result.consumerModified, false);
    assert.equal(result.consumerExecuted, false);
    assert.equal(result.authorization, 'not-granted');
    assert.deepEqual(result.recipe.files.map(value => value.path), [file.path]);
    const body = fixture.calls[0].body;
    const schema = provider === 'openai' ? body.text.format.schema : provider === 'anthropic' ? body.output_config.format.schema
      : provider === 'google' ? body.generationConfig.responseJsonSchema : body.response_format.json_schema.schema;
    assert.deepEqual(schema.properties.files.items.properties.path.enum, [file.path]);
    assert(!JSON.stringify(schema).includes(selectedTest.path));

    const unauthorized = { ...recipe, files: [{ path: selectedTest.path, sha256: selectedTest.sha256,
      edits: [{ before: 'assert.equal(2, 2)', after: 'assert.equal(1, 1)' }] }] };
    const unchanged = structuredClone(recipe);
    unchanged.files[0].edits[0].after = unchanged.files[0].edits[0].before;
    for (const response of [unauthorized, unchanged]) {
      const rejected = transport(responseFor(provider, JSON.stringify(response)));
      const rejectedAdapter = createHttpModelAdapter(options(provider), rejected.dependencies);
      await assert.rejects(propose(rejectedAdapter, requestFor(rejectedAdapter)), { code: 'INVALID_INPUT' });
      assert.equal(rejected.calls.length, 1);
    }
  });
}

test('the native local adapter talks to an explicitly configured loopback server without credentials or DNS', async t => {
  let requests = 0;
  const server = createServer(async (request, response) => {
    requests++;
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.headers.authorization, undefined);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    assert.equal(body.messages[1].role, 'user');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(responseFor('local-openai-compatible')));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const adapter = createHttpModelAdapter(options('local-openai-compatible', { endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions` }),
    { resolve: () => assert.fail('Local numeric loopback must not resolve DNS.') });
  const result = await propose(adapter);
  assert.equal(requests, 1);
  assert.equal(result.consumerExecuted, false);
});

test('endpoint, model and token policy changes invalidate the prepared identity', () => {
  const a = createHttpModelAdapter(options());
  for (const change of [{ model: 'different' }, { maximumOutputTokens: 1024 }, { policyId: 'different' }]) {
    const b = createHttpModelAdapter(options('openai', change));
    assert.notEqual(a.policyId, b.policyId);
    assert.notEqual(prepare(a).id, prepare(b).id);
  }
});

// Captured policy-v3 identities: disclosure consent must not cross a prompt-policy change.
for (const [provider, policyId] of [
  ['openai', 'f4b4493bb9f30e359960cba5beb728e1db665a434ea4f2b2ec977ad9045d85db'],
  ['anthropic', 'a185b30abac9b05cd8ec2efdd32edc50302924b0efbf06631adae64c1ad73f67'],
  ['google', 'd6e3ec39c02c74defe097205fc90d3435edaa0b9394237359dd13a2896a4ff72'],
  ['local-openai-compatible', '1f80add3b02d40a6c8949a013caa956353ebd13ef45bbe02cb3a142abd6495cb'],
]) {
  test(`${provider} rejects prior prompt-policy consent before credentials or context disclosure`, async () => {
    const fixture = transport(responseFor(provider));
    let keyReads = 0;
    const adapter = createHttpModelAdapter(options(provider, { getApiKey: () => { keyReads++; return 'fictional-provider-key'; } }), fixture.dependencies);
    const previous = { id: `${provider}-${policyId.slice(0, 16)}`, location: adapter.location,
      destination: provider === 'local-openai-compatible' ? `local:http-${policyId}` : adapter.destination, policyId };
    const request = prepareModelProposal({ ...context, adapter: previous });
    const consent = approveModelProposal({ request, expectedRequestId: request.id, allowRemote: true });
    await assert.rejects(proposeMigrationWithModel({ request, consent, adapter }), { code: 'INVALID_INPUT' });
    assert.equal(keyReads, 0);
    assert.equal(fixture.calls.length, 0);
  });
}

test('a controlled local HTTP response can abstain with explicit decisions without creating an executable recipe', async () => {
  const output = JSON.stringify({ schemaVersion: 1, summary: 'The supplied documentation does not establish the replacement units.',
    decisions: [{ id: 'units', question: 'Which authoritative source confirms the amount units?' }], files: [] });
  const fixture = transport(responseFor('local-openai-compatible', output));
  const result = await propose(createHttpModelAdapter(options('local-openai-compatible'), fixture.dependencies));
  assert.equal(result.status, 'decision-required');
  assert(result.decisions.some(decision => decision.id === 'units'));
  assert(!Object.hasOwn(result, 'recipe'));
  assert.equal(result.publication, 'not-authorized');
  assert.equal(fixture.calls.length, 1);
});

test('invalid or remote local endpoints, embedded credentials and arbitrary hosted endpoints are rejected before I/O', () => {
  for (const endpoint of ['http://localhost:11434/v1/chat/completions', 'http://10.0.0.1/v1/chat/completions',
    'https://provider.example/v1/chat/completions', 'http://user:pass@127.0.0.1/v1/chat/completions',
    'http://127.0.0.1/v1/chat/completions?token=secret', 'http://2130706433/v1/chat/completions',
    'http://127.0.0.1/v1/../chat/completions', 'http://127.0.0.1/v1/chat/completions#x']) {
    assert.throws(() => createHttpModelAdapter(options('local-openai-compatible', { endpoint })), { code: 'INVALID_INPUT' });
  }
  for (const change of [{ endpoint: 'https://other.example/v1' }, { maximumOutputTokens: 32769 }, { model: '' }, { getApiKey: undefined }]) {
    assert.throws(() => createHttpModelAdapter(options('openai', change)), { code: 'INVALID_INPUT' });
  }
});

test('DNS results are all checked before reading a key; the chosen public address is pinned', async () => {
  const fixture = transport(responseFor('openai'));
  let keyReads = 0;
  const adapter = createHttpModelAdapter(options('openai', { getApiKey: () => { keyReads++; return 'fictional'; } }), {
    ...fixture.dependencies, resolve: async () => [{ address: '1.1.1.1', family: 4 }, { address: '127.0.0.1', family: 4 }],
  });
  await assert.rejects(propose(adapter), { code: 'INVALID_INPUT' });
  assert.equal(keyReads, 0);
  assert.equal(fixture.calls.length, 0);
  await propose(createHttpModelAdapter(options(), fixture.dependencies));
  const lookup = fixture.calls[0].config.lookup;
  await new Promise((resolve, reject) => lookup('api.openai.com', {}, (error, address, family) => {
    if (error) reject(error); else { assert.equal(address, '1.1.1.1'); assert.equal(family, 4); resolve(); }
  }));
  await new Promise(resolve => lookup('other.example', {}, error => { assert(error); resolve(); }));
});

for (const behavior of [{ status: 302 }, { status: 429 }, { status: 500 }, { headers: { 'content-encoding': 'gzip' } },
  { headers: { 'content-type': 'text/html' } }, { headers: { 'content-length': '999999999' } },
  { bytes: Buffer.from([0xff, 0xfe]) }, { bytes: Buffer.from('{') }]) {
  test(`transport rejects ${JSON.stringify(behavior)} without retry, redirects or leaking response data`, async () => {
    const fixture = transport({ secret: 'sensitive-response' }, behavior);
    await assert.rejects(propose(createHttpModelAdapter(options(), fixture.dependencies)), error => {
      assert.equal(error.code, 'INVALID_INPUT');
      assert(!error.message.includes('sensitive-response'));
      assert(!error.message.includes('fictional-provider-key'));
      return true;
    });
    assert.equal(fixture.calls.length, 1);
  });
}

for (const [provider, response] of [
  ['openai', { status: 'incomplete', output: [] }],
  ['openai', { status: 'completed', output: [{ type: 'function_call', arguments: 'run' }] }],
  ['openai', { status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: 'No' }] }] }],
  ['anthropic', { ...responseFor('anthropic'), stop_reason: 'max_tokens' }],
  ['anthropic', { ...responseFor('anthropic'), content: [{ type: 'tool_use', name: 'execute' }] }],
  ['google', { promptFeedback: { blockReason: 'SAFETY' }, candidates: [] }],
  ['google', { candidates: [{ finishReason: 'MAX_TOKENS' }] }],
  ['local-openai-compatible', { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: json, tool_calls: [] } }] }],
]) {
  test(`${provider} rejects refusal, truncation and tool requests as a failed proposal`, async () => {
    const fixture = transport(response);
    await assert.rejects(propose(createHttpModelAdapter(options(provider), fixture.dependencies)), { code: 'INVALID_INPUT' });
  });
}

test('decoded output is independently bounded and the existing harness rejects unselected edits', async () => {
  const large = transport(responseFor('openai', 'a'.repeat(200)));
  const adapter = createHttpModelAdapter(options(), large.dependencies);
  await assert.rejects(propose(adapter, prepare(adapter, { maximumOutputBytes: 100 })), { code: 'INVALID_INPUT' });
  const tampered = structuredClone(recipe);
  tampered.files[0].path = 'src/not-selected.mjs';
  const fixture = transport(responseFor('anthropic', JSON.stringify(tampered)));
  await assert.rejects(propose(createHttpModelAdapter(options('anthropic'), fixture.dependencies)), { code: 'INVALID_INPUT' });
});

test('cancellation before disclosure does not resolve, read a key or send', async () => {
  let calls = 0;
  const adapter = createHttpModelAdapter(options('openai', { getApiKey: () => { calls++; return 'fictional'; } }),
    { resolve: () => { calls++; throw new Error('Unexpected DNS'); } });
  const request = prepare(adapter);
  const consent = approveModelProposal({ request, expectedRequestId: request.id, allowRemote: true });
  await assert.rejects(proposeMigrationWithModel({ request, consent, adapter, signal: AbortSignal.abort() }), { code: 'INVALID_INPUT' });
  assert.equal(calls, 0);
});

for (const blockedAt of ['dns', 'credential']) test(`cancellation while awaiting ${blockedAt} cannot send late context or retry`, async () => {
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const fixture = transport(responseFor('openai'));
  let keyReads = 0;
  const adapter = createHttpModelAdapter(options('openai', { getApiKey: () => {
    keyReads++;
    if (blockedAt === 'credential') { enter(); return blocked; }
    return 'fictional-provider-key';
  } }), { ...fixture.dependencies, resolve: () => {
    if (blockedAt === 'dns') { enter(); return blocked; }
    return Promise.resolve([{ address: '1.1.1.1', family: 4 }]);
  } });
  const request = prepare(adapter), controller = new AbortController();
  const consent = approveModelProposal({ request, expectedRequestId: request.id, allowRemote: true });
  const attempt = proposeMigrationWithModel({ request, consent, adapter, signal: controller.signal });
  await entered; controller.abort();
  await assert.rejects(attempt, { code: 'INVALID_INPUT' });
  release(blockedAt === 'dns' ? [{ address: '1.1.1.1', family: 4 }] : 'fictional-provider-key');
  // Drain the deliberately late callback; a cancelled harness must not permit
  // its adapter to resume disclosure after the caller has observed failure.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.calls.length, 0);
  assert.equal(keyReads, blockedAt === 'dns' ? 0 : 1);
  await assert.rejects(proposeMigrationWithModel({ request, consent, adapter }), { code: 'INVALID_INPUT' });
  assert.equal(fixture.calls.length, 0);
});

test('consent for one model and token budget cannot authorize a different built-in adapter', async () => {
  const original = createHttpModelAdapter(options());
  const request = prepare(original);
  const consent = approveModelProposal({ request, expectedRequestId: request.id, allowRemote: true });
  for (const change of [{ model: 'another-model' }, { maximumOutputTokens: 32768 }, { policyId: 'another-policy' }]) {
    const fixture = transport(responseFor('openai'));
    let keyReads = 0;
    const adapter = createHttpModelAdapter(options('openai', { ...change, getApiKey: () => { keyReads++; return 'fictional-provider-key'; } }), fixture.dependencies);
    await assert.rejects(proposeMigrationWithModel({ request, consent, adapter }), { code: 'INVALID_INPUT' });
    assert.equal(keyReads, 0); assert.equal(fixture.calls.length, 0);
  }
});
