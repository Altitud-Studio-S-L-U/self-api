import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, dirname, join, resolve } from 'node:path';
import { createHttpModelAdapter, observeOnce, registerLocalSubscription } from '../../dist/index.js';

export const root = resolve(import.meta.dirname, '../..');
export const enginePath = join(root, 'work/tools/oasdiff', process.platform === 'win32' ? 'oasdiff.exe' : 'oasdiff');
export const identity = { id: 'controlled-model', location: 'local', destination: 'local:controlled-model', policyId: 'fixture-v1' };

export async function fixture(t, beforeObserve = async () => {}) {
  // WSL DrvFS does not provide the private POSIX state permissions required by the real worker.
  const parent = process.env.KEEPSEAM_TEST_WORK ? resolve(process.env.KEEPSEAM_TEST_WORK) : join(root, 'work/test-job-proposal');
  await mkdir(parent, { recursive: true });
  const realParent = await realpath(parent);
  const directory = await mkdtemp(join(realParent, 'case-'));
  t.after(async () => {
    const target = await realpath(directory);
    assert.equal(dirname(target), realParent);
    assert(basename(target).startsWith('case-'));
    await rm(target, { recursive: true });
  });
  const consumerRoot = join(directory, 'consumer');
  await cp(join(root, 'fixtures/validation-consumer'), consumerRoot, { recursive: true });
  await beforeObserve(consumerRoot);
  const sourcePath = join(directory, 'provider.json');
  await cp(join(root, 'fixtures/orders-v2.json'), sourcePath);
  const statePath = join(directory, 'state');
  const subscription = await registerLocalSubscription({ statePath, sourcePath, baselinePath: join(root, 'fixtures/orders-v1.json'),
    consumerRoot, enginePath, providerBaseUrl: 'https://orders.example.invalid' });
  const result = await observeOnce({ statePath, enginePath, subscriptionId: subscription.id });
  assert.equal(result.results[0].status, 'observed');
  const jobId = result.results[0].jobId;
  assert.match(jobId, /^[a-f0-9]{64}$/u);
  const reference = JSON.parse(await readFile(join(root, 'fixtures/validation-recipe.json'), 'utf8'));
  const recipe = { ...reference, decisions: reference.decisions.map(({ id, question }) => ({ id, question })) };
  return { directory, consumerRoot, sourcePath, statePath, jobId, reference, recipe,
    input: { statePath, jobId, enginePath, adapter: identity, testPaths: ['orders.test.mjs'] } };
}

/** Real local HTTP transport with deterministic output; this server is not an inference model. */
export async function controlledModel(t, recipe, onRequest = () => {}) {
  const calls = [], checks = [];
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(request.headers.authorization, undefined);
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks));
      if (payload.response_format?.json_schema?.name === 'keepseam_connection') {
        checks.push(payload);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"keepseam":"ok"}' } }] }));
        return;
      }
      calls.push(payload);
      await onRequest(payload);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(recipe) } }] }));
    } catch (error) { response.writeHead(500); response.end('controlled fixture rejected request'); calls.push({ error }); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
  const adapter = createHttpModelAdapter({ provider: 'local-openai-compatible', model: 'deterministic-fixture', policyId: 'fixture-v1',
    maximumOutputTokens: 2048, endpoint });
  const { propose: _propose, ...adapterIdentity } = adapter;
  return { calls, checks, endpoint, adapter, identity: adapterIdentity };
}
