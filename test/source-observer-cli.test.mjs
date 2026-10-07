import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, writeFile, realpath, rm } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute, sep } from 'node:path';
import { runCli } from '../dist/cli.js';

async function invoke(args) {
  let stdout = '', stderr = '';
  const code = await runCli(args, { stdout: text => { stdout += text; }, stderr: text => { stderr += text; } });
  return { code, stdout, stderr };
}
test('root CLI persists MCP subscriptions and observes changes without provider execution', async t => {
  const work = resolve('work'); await mkdir(work, { recursive: true });
  const directory = await mkdtemp(join(work, 'source-cli-'));
  t.after(async () => {
    const actual = await realpath(directory), owned = relative(await realpath(work), actual);
    assert(!isAbsolute(owned) && owned.startsWith('source-cli-') && !owned.includes(sep));
    await rm(actual, { recursive: true, force: true });
  });
  const state = join(directory, 'state'), source = join(directory, 'source.json');
  const baseline = resolve('fixtures/mcp/catalog-before.json');
  await writeFile(source, await readFile(baseline));
  const registered = await invoke(['source-subscribe', source, '--baseline', baseline, '--kind', 'mcp', '--state', state, '--json']);
  assert.equal(registered.code, 0, registered.stderr);
  const subscription = JSON.parse(registered.stdout);
  assert.equal(subscription.adopted, 'unknown');
  const args = ['source-observe', '--once', '--state', state, '--json'];
  assert.equal((await invoke(args)).code, 1);
  assert.equal((await invoke(args)).code, 0);
  await writeFile(source, await readFile(resolve('fixtures/mcp/catalog-after.json')));
  const changed = await invoke(args);
  assert.equal(changed.code, 1, changed.stderr);
  const history = await invoke(['source-history', '--state', state, '--subscription', subscription.id, '--json']);
  assert.equal(history.code, 0);
  const records = JSON.parse(history.stdout);
  assert.equal(records.length, 2);
  assert.equal(records[1].report.status, 'breaking-changes');
  assert.equal(records[1].authorization, 'not-granted');
  const listed = await invoke(['source-subscriptions', '--state', state, '--json']);
  assert.equal(JSON.parse(listed.stdout).length, 1);
});
test('source CLI rejects unsupported flags, kinds, repeated options and implicit loops', async () => {
  for (const args of [
    ['source-observe', '--state', 's'], ['source-observe', '--once', '--state', 's', '--kind', 'mcp'],
    ['source-subscriptions', '--state', 's', '--state', 't'], ['source-history', 'extra', '--state', 's'],
    ['source-subscribe', 'source', '--baseline', 'base', '--state', 's', '--kind', 'remote'],
  ]) {
    const result = await invoke(args); assert.equal(result.code, 2); assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error.code, 'INVALID_INPUT');
  }
});
