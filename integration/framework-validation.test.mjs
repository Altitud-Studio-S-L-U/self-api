import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { approveJobValidation, observeOnce, prepareJobValidation, queueJobValidation, registerLocalSubscription, runApprovedJobsOnce } from '../dist/index.js';
import { MAVEN_FIXTURE_POM, validateRuntime } from '../dist/validation-runtime.js';

const root = resolve(import.meta.dirname, '..');
const enginePath = join(root, 'work/tools/oasdiff/oasdiff');
const hash = value => createHash('sha256').update(value).digest('hex');
function contract(version) {
  const properties = version === 'A' ? { id: { type: 'string' }, amount_minor: { type: 'integer' }, currency: { type: 'string' } }
    : { id: { type: 'string' }, money: { type: 'object', required: ['value', 'currency'], properties: { value: { type: 'string' }, currency: { type: 'string' } } } };
  return { openapi: '3.0.3', info: { title: 'Synthetic HTTP payment contract', version }, paths: {
    '/payments/{id}': { get: { parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }], responses: {
      200: { description: 'Exact synthetic USD payment', content: Object.fromEntries(['application/json', 'application/xml'].map(media => [media,
        { schema: { type: 'object', required: Object.keys(properties), properties } }])) },
    } } },
  } };
}
async function fixture(t, files) {
  const parent = join(root, 'work/framework-validation');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'case-'));
  t.after(() => rm(directory, { recursive: true }));
  const consumerRoot = join(directory, 'consumer'), statePath = join(directory, 'state');
  for (const [path, content] of files) {
    await mkdir(dirname(join(consumerRoot, path)), { recursive: true });
    await writeFile(join(consumerRoot, path), content);
  }
  const sourcePath = join(directory, 'B.json'), baselinePath = join(directory, 'A.json');
  await writeFile(sourcePath, JSON.stringify(contract('B')));
  await writeFile(baselinePath, JSON.stringify(contract('A')));
  const subscription = await registerLocalSubscription({ statePath, sourcePath, baselinePath, consumerRoot, enginePath, providerBaseUrl: 'http://127.0.0.1:1' });
  const observed = await observeOnce({ statePath, enginePath, subscriptionId: subscription.id });
  assert.equal(observed.results[0].status, 'observed');
  return { statePath, consumerRoot, jobId: observed.results[0].jobId };
}
for (const kind of ['pytest', 'maven-junit']) {
  for (const correct of [true, false]) {
    test(`${kind}: approved baseline and ${correct ? 'correct' : 'broken'} candidate use the same real HTTP contract tests`, { timeout: 300_000 }, async t => {
      assert.equal(process.platform, 'linux');
      const runtime = validateRuntime(JSON.parse(await readFile(join(root, `work/audit/${kind}-runtime.json`), 'utf8')));
      const python = kind === 'pytest';
      const sourcePath = python ? 'payment_client.py' : 'src/main/java/PaymentClient.java';
      const testPath = python ? 'test_payment.py' : 'src/test/java/PaymentContractTest.java';
      const language = python ? 'python' : 'java';
      const filename = python ? 'payment_client.py' : 'PaymentClient.java';
      const before = await readFile(join(root, `dev/polyglot/${language}/baseline/${filename}`), 'utf8');
      const after = correct ? await readFile(join(root, `dev/polyglot/${language}/candidate/${filename}`), 'utf8')
        : python ? 'def get_payment(*args):\n    raise RuntimeError("broken candidate sentinel")\n'
          : before.replace('"Expected " + name + " exactly once"', '"broken candidate sentinel: " + name');
      assert.notEqual(after, before, 'The synthetic candidate must contain a real source change.');
      const tests = await readFile(join(root, python ? 'dev/polyglot/pytest/test_payment.py' : 'dev/polyglot/maven/PaymentContractTest.java'), 'utf8');
      const immutable = [[testPath, tests]];
      if (!python) immutable.push(['pom.xml', MAVEN_FIXTURE_POM], ['src/test/java/PaymentTest.java', await readFile(join(root, 'dev/polyglot/java/PaymentTest.java'), 'utf8')]);
      const f = await fixture(t, [[sourcePath, before], ...immutable]);
      const recipe = { schemaVersion: 1, summary: 'Operator-authored synthetic adapter; no model inference claim.',
        decisions: [{ id: 'units', question: 'What is the conversion and required failure behavior?',
          answer: 'The synthetic USD contract converts exact decimal strings into integer minor units; unchanged HTTP tests verify large amounts, invalid formats and provider failures.' }],
        files: [{ path: sourcePath, sha256: hash(before), edits: [{ before, after }] }] };
      const input = { statePath: f.statePath, jobId: f.jobId, enginePath, recipe, testPaths: [testPath], runtime };
      const request = await prepareJobValidation(input);
      const receipt = await approveJobValidation({ ...input, expectedRequestId: request.id, origin: 'explicit-sdk-caller' });
      await assert.rejects(queueJobValidation({ ...input, receiptId: receipt.id, runtime: { ...runtime, dependenciesSha256: 'f'.repeat(64) } }), { code: 'INVALID_INPUT' });
      const queued = await queueJobValidation({ ...input, receiptId: receipt.id });
      assert.deepEqual(queued.intent.runtime, runtime);
      const cycle = await runApprovedJobsOnce({ statePath: f.statePath, enginePath, intentId: queued.intent.id });
      const result = cycle.results[0];
      assert.equal(result.status, 'completed', JSON.stringify(result));
      assert.equal(result.outcome.status, correct ? 'improved' : 'failed', JSON.stringify(result));
      const attempt = join(f.statePath, 'attempts', receipt.id);
      const detail = JSON.parse(await readFile(join(attempt, 'result.json'), 'utf8'));
      assert.match(detail.baseline.stdout + detail.baseline.stderr, python ? /KeyError: 'amount_minor'/u : /Expected amount_minor exactly once/u);
      if (!correct) assert.match(detail.candidate.stdout + detail.candidate.stderr, /broken candidate sentinel/u);
      for (const phase of ['baseline', 'candidate']) {
        for (const [path, content] of immutable) assert.equal(await readFile(join(attempt, phase, path), 'utf8'), content);
        const journal = JSON.parse(await readFile(join(attempt, 'containers', `${phase}.intent.json`), 'utf8'));
        assert.equal(journal.imageId, runtime.imageId);
        assert.equal(journal.profileSha256, hash(JSON.stringify(request.spec.profile)));
        assert.equal(detail[phase].cleanup, 'removed');
      }
      assert.equal(await readFile(join(f.consumerRoot, sourcePath), 'utf8'), before);
      assert.equal(result.outcome.publication, 'not-authorized');
      assert.deepEqual((await runApprovedJobsOnce({ statePath: f.statePath, enginePath, intentId: queued.intent.id })).results, []);
    });
  }
}
