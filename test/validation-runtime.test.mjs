import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { dockerProfileForTests } from '../dist/docker-runner.js';
import { runtimeRecipeSha256, validateRuntime, MAVEN_FIXTURE_POM } from '../dist/validation-runtime.js';
import { captureConsumer } from '../dist/consumer-files.js';
import { prepareJobValidation } from '../dist/index.js';
import { enginePath, fixture } from './helpers/job-proposal.mjs';
import { createHash } from 'node:crypto';
import { runJobCli } from '../dist/job-cli.js';
import { runCli } from '../dist/cli.js';

const manifest = kind => ({ schemaVersion: 1, kind, imageId: `sha256:${'a'.repeat(64)}`,
  recipeSha256: runtimeRecipeSha256(kind), dependenciesSha256: 'b'.repeat(64) });

test('framework manifests are closed data, require a known recipe, and reject mutable image tags', () => {
  const input = manifest('pytest');
  assert.deepEqual(validateRuntime(input), input);
  assert(Object.isFrozen(validateRuntime(input)));
  for (const value of [null, [], { ...input, imageId: 'python:latest' }, { ...input, command: 'anything' },
    { ...input, recipeSha256: 'c'.repeat(64) }, { ...input, dependenciesSha256: '' },
    { ...input, kind: 'unknown' }, new Proxy(input, {})]) assert.throws(() => validateRuntime(value), { code: 'INVALID_INPUT' });
  const accessor = { ...input };
  Object.defineProperty(accessor, 'kind', { get() { throw new Error('must not be evaluated'); } });
  assert.throws(() => validateRuntime(accessor), { code: 'INVALID_INPUT' });
  assert.throws(() => dockerProfileForTests(['test_contract.py'], manifest('maven-junit')));
  assert.throws(() => dockerProfileForTests(['ContractTest.java'], manifest('maven-junit')));
  for (const [kind, path] of [['pytest', 'test_contract.py'], ['maven-junit', 'src/test/java/ContractTest.java']]) {
    const profile = dockerProfileForTests([path], manifest(kind));
    assert.equal(profile.image, manifest(kind).imageId);
    assert(profile.isolationArgs.includes('--network=none'));
    assert(profile.isolationArgs.includes('--pull=never'));
    assert.deepEqual(profile.runtime, manifest(kind));
  }
});

test('framework image, dependency digest and captured build manifests change consent identity', async t => {
  const f = await fixture(t, async consumer => {
    await writeFile(join(consumer, 'test_contract.py'), 'def test_contract(): assert True\n');
    await writeFile(join(consumer, 'pyproject.toml'), '[tool.pytest.ini_options]\ntestpaths = ["."]\n');
    await writeFile(join(consumer, 'pom.xml'), MAVEN_FIXTURE_POM);
    await writeFile(join(consumer, 'conftest.py'), 'VALUE = 1\n');
  });
  const base = { statePath: f.statePath, jobId: f.jobId, enginePath, recipe: f.reference, testPaths: ['test_contract.py'], runtime: manifest('pytest') };
  const request = await prepareJobValidation(base);
  for (const change of [{ imageId: `sha256:${'c'.repeat(64)}` }, { dependenciesSha256: 'c'.repeat(64) }]) {
    const modified = await prepareJobValidation({ ...base, runtime: { ...base.runtime, ...change } });
    assert.notEqual(modified.id, request.id);
    assert.notEqual(modified.executionDigest, request.executionDigest);
    assert.notEqual(modified.policyDigest, request.policyDigest);
  }
  const captured = await captureConsumer(f.consumerRoot);
  assert(captured.manifests.some(file => file.path === 'pom.xml'));
  assert(captured.manifests.some(file => file.path === 'pyproject.toml'));
  for (const path of ['conftest.py', 'orders.test.mjs', 'pom.xml']) {
    const before = await readFile(join(f.consumerRoot, path), 'utf8');
    const illegal = { ...f.reference, files: [...f.reference.files, { path, sha256: createHash('sha256').update(before).digest('hex'), edits: [{ before, after: `${before}\n` }] }] };
    await assert.rejects(prepareJobValidation({ ...base, recipe: illegal }), { code: 'INVALID_INPUT' });
  }
  await writeFile(join(f.consumerRoot, 'pom.xml'), `${MAVEN_FIXTURE_POM}\n`);
  assert.notEqual((await captureConsumer(f.consumerRoot)).digest, captured.digest);
  await assert.rejects(prepareJobValidation(base), { code: 'INVALID_INPUT' });
});

test('CLI validation planning forwards a checked runtime and rejects malformed manifests before service calls', async t => {
  await mkdir('work/test-runtime-cli', { recursive: true });
  const directory = await mkdtemp('work/test-runtime-cli/case-');
  t.after(() => rm(directory, { recursive: true }));
  const runtimePath = join(directory, 'runtime.json'), runtime = manifest('pytest');
  await writeFile(runtimePath, JSON.stringify(runtime));
  let calls = 0;
  const prepare = async input => { calls++; assert.deepEqual(input.runtime, runtime); return { schemaVersion: 1 }; };
  const output = { stdout: () => {}, stderr: () => {} };
  const args = ['--engine', 'oasdiff', '--recipe', 'fixtures/validation-recipe.json', '--test', 'test_contract.py', '--runtime', runtimePath, '--json'];
  assert.equal(await runJobCli(['job-plan', '1'.repeat(64), '--state', 'state', ...args], { ...output, prepare }), 0);
  assert.equal(await runCli(['validation-plan', 'base.json', 'revision.json', '--consumer', 'consumer', '--provider-base-url', 'https://example.invalid', ...args], { ...output, prepareValidation: prepare }), 0);
  assert.equal(calls, 2);
  await writeFile(runtimePath, JSON.stringify({ ...runtime, imageId: 'python:latest' }));
  assert.equal(await runJobCli(['job-plan', '1'.repeat(64), '--state', 'state', ...args], { ...output, prepare }), 2);
  assert.equal(calls, 2);
});

test('runtime preparation is explicit and its help and invalid arguments never invoke Docker preparation', async () => {
  let calls = 0, stdout = '';
  const prepareRuntime = async (kind, output) => { calls++; assert.equal(kind, 'pytest'); assert.equal(output, 'runtime.json'); return manifest(kind); };
  const options = { prepareRuntime, stdout: text => { stdout += text; }, stderr: () => {} };
  assert.equal(await runCli(['runtime', '--help'], options), 0);
  assert.match(stdout, /preparation|Preparation/u);
  for (const args of [['runtime'], ['runtime', 'prepare', 'ruby', '--output', 'runtime.json'],
    ['runtime', 'prepare', 'pytest', '--output', 'runtime.json', '--command', 'anything']]) assert.equal(await runCli(args, options), 2);
  assert.equal(calls, 0);
  stdout = '';
  assert.equal(await runCli(['runtime', 'prepare', 'pytest', '--output', 'runtime.json'], options), 0);
  assert.equal(calls, 1);
  assert.deepEqual(JSON.parse(stdout), manifest('pytest'));
});
