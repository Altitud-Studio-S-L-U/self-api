import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { runCli } from '../dist/cli.js';

async function invoke(args) {
  let stdout = '', stderr = '';
  const code = await runCli(args, { stdout: text => { stdout += text; }, stderr: text => { stderr += text; } });
  return { code, stdout, stderr };
}
test('root CLI registers an OpenAPI HTTPS policy without contacting the provider', async t => {
  const work = resolve('work'); await mkdir(work, { recursive: true });
  const parent = await realpath(work), directory = await mkdtemp(join(parent, 'http-worker-cli-'));
  t.after(async () => {
    const actual = await realpath(directory);
    assert.equal(dirname(actual), parent);
    assert.ok(basename(actual).startsWith('http-worker-cli-'));
    await rm(actual, { recursive: true, force: true });
  });
  const policy = join(directory, 'policy.json'), state = join(directory, 'state');
  const engine = resolve('work/tools/oasdiff', process.platform === 'win32' ? 'oasdiff.exe' : 'oasdiff');
  await writeFile(policy, JSON.stringify({ url: 'https://orders.example.invalid/openapi.json',
    allowedOrigins: ['https://orders.example.invalid'], contentKind: 'json' }));
  const result = await invoke(['http-subscribe', policy, '--baseline', resolve('fixtures/orders-v1.json'),
    '--consumer', resolve('fixtures/validation-consumer'), '--provider-base-url', 'https://orders.example.invalid',
    '--engine', engine, '--state', state, '--json']);
  assert.equal(result.code, 0, result.stderr);
  const subscription = JSON.parse(result.stdout);
  assert.equal(subscription.sourcePath, 'https://orders.example.invalid/openapi.json');
  assert.equal(subscription.httpSource.contentKind, 'json');
  assert.equal(subscription.lastObservedSha, null);
  const blocked = await invoke(['worker', '--once', '--state', state, '--engine', engine, '--json']);
  assert.equal(blocked.code, 2);
  assert.equal(JSON.parse(blocked.stdout).results[0].reason, 'http-not-enabled');
});
