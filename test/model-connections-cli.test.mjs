import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { ModelConnectionError, ModelConnectionStore, ModelConnections, readModelConnectionStatus } from '../dist/index.js';
import { runModelConnectionsCli } from '../dist/model-connections-cli.js';
import { checkWindowsPermissions } from '../dist/windows-permissions.js';
import { controlledModel } from './helpers/job-proposal.mjs';

async function fixture(t) {
  const parent = resolve(process.env.SELF_MANAGED_API_TEST_WORK ?? join(tmpdir(), 'self-managed-api-model-connections-tests')); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(await realpath(parent), 'case-'));
  checkWindowsPermissions([directory], true, directory);
  t.after(async () => {
    const target = await realpath(directory); assert.equal(dirname(target), await realpath(parent)); assert(basename(target).startsWith('case-'));
    await rm(target, { recursive: true });
  });
  const model = await controlledModel(t, { schemaVersion: 1, summary: 'No generation in connection tests.', decisions: [], files: [] });
  const configuration = { schemaVersion: 1, primary: 'fixture', connections: [{ id: 'fixture', revision: 1, credentialRevision: 1,
    provider: 'local-openai-compatible', model: 'deterministic-fixture', policyId: 'fixture-v1', maximumOutputTokens: 1024, endpoint: model.endpoint }] };
  const modelPath = join(directory, 'connections.json'); await writeFile(modelPath, JSON.stringify(configuration), { mode: 0o600 });
  return { directory, model, configuration, modelPath, args: ['--state', directory, '--model', modelPath] };
}
async function invoke(args, options = {}) {
  let stdout = '', stderr = '';
  const code = await runModelConnectionsCli(args, { ...options, stdout: text => { stdout += text; }, stderr: text => { stderr += text; } });
  return { code, stdout, stderr };
}

test('connection CLI cancellation and status perform no inference; confirmation sends only the real loopback functional check', async t => {
  const f = await fixture(t);
  const cancelled = await invoke(['model-connections', 'verify', ...f.args], { confirm: async () => false });
  assert.equal(cancelled.code, 1); assert.equal(f.model.checks.length, 0); assert.equal(f.model.calls.length, 0);
  const before = await invoke(['model-connections', 'status', ...f.args]); assert.equal(before.code, 0);
  assert.equal(JSON.parse(before.stdout).inferencePerformed, false); assert.equal(f.model.checks.length, 0);
  const verified = await invoke(['model-connections', 'verify', ...f.args, '--startup-checks'], { confirm: async id => {
    assert.match(id, /^[a-f0-9]{64}$/u); return true;
  } });
  assert.equal(verified.code, 0, verified.stderr); assert.equal(f.model.checks.length, 1); assert.equal(f.model.calls.length, 0);
  const output = JSON.parse(verified.stdout.trim().split('\n').at(-1));
  assert.equal(output.connections[0].status, 'healthy'); assert.equal(output.privateCodeSent, false); assert.equal(output.startupChecksAuthorized, true);
  const snapshot = JSON.parse(await readFile(join(f.directory, 'model-connections.json'), 'utf8'));
  assert.equal(snapshot.probeGrant, new ModelConnections(f.configuration).configurationDigest);
  assert(!JSON.stringify(snapshot).includes('getApiKey')); assert(!JSON.stringify(snapshot).includes('endpoint'));
  const restarted = await invoke(['model-connections', 'status', ...f.args]); assert.equal(restarted.code, 0);
  assert.equal(JSON.parse(restarted.stdout).connections[0].fresh, false); assert.equal(f.model.checks.length, 1);
});

test('local state serializes processes and protects connection revisions without storing model credentials', async t => {
  const f = await fixture(t), first = await ModelConnectionStore.open(f.directory);
  try {
    await assert.rejects(ModelConnectionStore.open(f.directory), { code: 'INVALID_INPUT' });
    const runtime = new ModelConnections(f.configuration, { persistence: first });
    await runtime.verify('fixture', new AbortController().signal, true);
    assert.equal(readModelConnectionStatus(f.directory)[0].status, 'healthy');
    assert.throws(() => new ModelConnections({ ...f.configuration, connections: [{ ...f.configuration.connections[0], model: 'different' }] }, { persistence: first }), /increased connection revision/u);
  } finally { first.close(); }
  const second = await ModelConnectionStore.open(f.directory); second.close();
  await writeFile(join(f.directory, 'model-connections.json'), '{"schemaVersion":1,"states":[{"apiKey":"do-not-disclose"}],"probeGrant":null}', { mode: 0o600 });
  const invalid = await invoke(['model-connections', 'status', ...f.args]);
  assert.equal(invalid.code, 2); assert(!invalid.stderr.includes('do-not-disclose'));
});

test('remote checks require explicit disclosure consent and reject raw keys or configuration drift before inference', async t => {
  const f = await fixture(t);
  const remote = { ...f.configuration, connections: [{ id: 'fixture', revision: 1, credentialRevision: 1, provider: 'openai',
    model: 'configured-customer-model', policyId: 'customer-policy', maximumOutputTokens: 1024, apiKeyEnv: 'SELF_MANAGED_API_TEST_MISSING_API_KEY' }] };
  await writeFile(f.modelPath, JSON.stringify(remote));
  const denied = await invoke(['model-connections', 'verify', ...f.args], { confirm: async () => { assert.fail('Missing remote consent must not ask for a provider call.'); } });
  assert.equal(denied.code, 2); assert.match(denied.stderr, /--allow-remote/u); assert.equal(f.model.checks.length, 0);
  await writeFile(f.modelPath, JSON.stringify({ ...remote, connections: [{ ...remote.connections[0], apiKey: 'fictional-secret' }] }));
  const invalid = await invoke(['model-connections', 'verify', ...f.args, '--allow-remote'], { confirm: async () => { assert.fail('Literal secrets cannot reach consent.'); } });
  assert.equal(invalid.code, 2); assert(!invalid.stderr.includes('fictional-secret')); assert.equal(f.model.checks.length, 0);
});

test('only a transient local probe failure recommends preparing the local service, without relaxing deadlines or exposing provider data', async t => {
  const f = await fixture(t);
  for (const failure of ['transient', 'credentials', 'permission', 'model', 'quota', 'invalid-response', 'cancelled']) {
    const result = await invoke(['model-connections', 'verify', ...f.args], {
      confirm: async () => true, dependencies: { probe: async () => { throw new ModelConnectionError(failure); } },
    });
    assert.equal(result.code, 2);
    const error = JSON.parse(result.stderr).error;
    assert.equal(error.failure, failure);
    if (failure === 'transient') {
      assert.equal(error.action, 'check-local-model-service');
      assert.match(error.hint, /service is reachable/u);
      assert.match(error.hint, /finished loading/u);
      assert.match(error.hint, /limited to 30 seconds/u);
    } else {
      assert.equal(error.action, undefined);
      assert.equal(error.hint, undefined);
    }
    const request = JSON.parse(result.stdout.trim().split('\n')[0]);
    assert.equal(request.timeoutMs, 120000);
    assert.equal(request.maximumChecks, 1);
    assert.equal(request.destinations[0].maximumOutputTokens, 128);
  }
  await writeFile(f.modelPath, JSON.stringify({ ...f.configuration, connections: [{ ...f.configuration.connections[0],
    revision: 2, provider: 'openai', endpoint: undefined, apiKeyEnv: 'SELF_MANAGED_API_TEST_MISSING_API_KEY' }] }));
  const remote = await invoke(['model-connections', 'verify', ...f.args, '--allow-remote'], {
    confirm: async () => true, dependencies: { probe: async () => { throw new ModelConnectionError('transient'); } },
  });
  assert.equal(remote.code, 2);
  const remoteError = JSON.parse(remote.stderr).error;
  assert.equal(remoteError.failure, 'transient');
  assert.equal(remoteError.action, undefined);
  assert.equal(remoteError.hint, undefined);
});
