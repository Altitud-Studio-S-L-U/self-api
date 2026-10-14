import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { sha256 } from './semantic-review.mjs';
import { scenarioFiles } from './polyglot-cases.mjs';

function contract(version, language) {
  const properties = version === 'A'
    ? { id: { type: 'string' }, amount_minor: { type: 'integer' }, currency: { type: 'string' } }
    : { id: { type: 'string' }, money: { type: 'object', required: ['value', 'currency'], properties: {
      value: { type: 'string' }, currency: { type: 'string' },
    } } };
  return { openapi: '3.0.3', info: { title: 'Fictional money API', version }, paths: {
    '/payments/{id}': { get: { parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }], responses: {
      200: { description: 'Payment', content: { [language === 'java' ? 'application/xml' : 'application/json']: {
        schema: { type: 'object', required: Object.keys(properties), properties, ...(language === 'java' ? { xml: { name: 'payment' } } : {}) },
      } } },
    } } },
  } };
}

/** Execute the reviewed recipe through the installed SDK, never a replacement patch. */
export async function validatePolyglot({ item, directory, sdk, runtimeModule, enginePath, runtimesPath }) {
  assert.equal(process.platform, 'linux', 'Polyglot SDK execution requires Linux x64.');
  assert.equal(process.arch, 'x64');
  const root = join(directory, item.scenario.id); await mkdir(root);
  const consumerRoot = join(root, 'consumer'); await mkdir(consumerRoot);
  const java = item.scenario.language === 'java';
  const challenge = { path: java ? 'src/test/java/MoneyFormatTest.java' : 'test_money_format.py',
    text: await readFile(new URL(java ? './fixtures/MoneyFormatTest.java' : './fixtures/test_money_format.py', import.meta.url), 'utf8') };
  const files = [...scenarioFiles(item.scenario), challenge];
  for (const file of files) {
    const target = join(consumerRoot, file.path); await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.text, { flag: 'wx' });
  }
  if (item.scenario.runtimeKind === 'maven-junit') {
    await writeFile(join(consumerRoot, 'pom.xml'), runtimeModule.MAVEN_FIXTURE_POM, { flag: 'wx' });
  }
  const basePath = join(root, 'A.json'), revisionPath = join(root, 'B.json');
  await writeFile(basePath, JSON.stringify(contract('A', item.scenario.language)), { flag: 'wx' });
  await writeFile(revisionPath, JSON.stringify(contract('B', item.scenario.language)), { flag: 'wx' });
  const runtime = runtimeModule.validateRuntime(JSON.parse(await readFile(join(runtimesPath, `${item.scenario.runtimeKind}-runtime.json`), 'utf8')));
  assert.equal(runtime.kind, item.scenario.runtimeKind);
  const options = { basePath, revisionPath, enginePath, consumerRoot,
    providerBaseUrl: 'http://127.0.0.1:1', recipe: item.recipe, testPaths: [...item.scenario.testPaths, challenge.path], runtime };
  const request = await sdk.prepareMigrationValidation(options);
  const statePath = join(root, 'state');
  await writeFile(join(root, 'request.json'), JSON.stringify(request, null, 2), { flag: 'wx' });
  const receipt = await sdk.approveMigrationValidation({ options, expectedRequestId: request.id, statePath, origin: 'explicit-sdk-caller' });
  const result = await sdk.executeMigrationValidation({ options, statePath, receiptId: receipt.id });
  await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
  assert.equal(result.consumerModified, false); assert.equal(result.publication, 'not-authorized');
  for (const file of files) {
    assert.equal(sha256(await readFile(join(consumerRoot, file.path))), sha256(file.text), 'Live source and tests must retain their original bytes.');
  }
  if (item.scenario.runtimeKind === 'maven-junit') {
    assert.equal(await readFile(join(consumerRoot, 'pom.xml'), 'utf8'), runtimeModule.MAVEN_FIXTURE_POM);
  }
  const testDigests = [...item.scenario.tests, challenge].map(file => ({ path: file.path, sha256: sha256(file.text),
    provenance: file === challenge ? 'independent-test-not-sent-to-model' : 'immutable-model-context' }));
  const testSha256 = sha256(JSON.stringify(testDigests));
  return { status: result.status, requestId: request.id, testDigests,
    tests: [
      { revision: 'baseline', exitCode: result.baseline.exitCode, status: result.baseline.status, cleanup: result.baseline.cleanup, testSha256 },
      { revision: 'candidate', exitCode: result.candidate?.exitCode ?? null, status: result.candidate?.status ?? 'not-run',
        cleanup: result.candidate?.cleanup ?? 'not-created', testSha256 },
    ] };
}
