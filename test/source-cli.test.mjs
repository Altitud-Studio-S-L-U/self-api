import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runCli } from '../dist/cli.js';

const before = resolve('fixtures/mcp/catalog-before.json');
const after = resolve('fixtures/mcp/catalog-after.json');
async function invoke(args) {
  let stdout = ''; let stderr = '';
  const code = await runCli(args, { stdout: text => { stdout += text; }, stderr: text => { stderr += text; } });
  return { code, stdout, stderr };
}
test('MCP fixtures can be compared through the root CLI without an engine or server', async () => {
  const result = await invoke(['mcp-compare', before, after, '--json']);
  assert.equal(result.code, 1);
  assert.equal(result.stderr, '');
  assert.equal(JSON.parse(result.stdout).status, 'breaking-changes');
  const unchanged = await invoke(['mcp-compare', before, before]);
  assert.equal(unchanged.code, 0);
  assert.match(unchanged.stdout, /consumer impact is not analyzed/u);
});
test('MCP snapshot inspection emits normalized evidence and never executes a tool', async () => {
  const result = await invoke(['mcp-snapshot', before, '--json']);
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.stdout).catalog.completeness, 'complete');
});
test('the integration manifest example validates through the public CLI with unknown effective version preserved', async () => {
  const result = await invoke(['integration-check', resolve('fixtures/integration-manifest.json'), '--json']);
  assert.equal(result.code, 0, result.stderr);
  const manifest = JSON.parse(result.stdout);
  assert.equal(manifest.effectiveVersions[0].value, null);
  assert.equal(manifest.versionCoverage, 'listed-only');
  assert.equal(manifest.knownVersions.length, 2);
});
test('source commands reject missing, extra, repeated and unrelated options', async () => {
  for (const args of [
    ['mcp-compare', before], ['mcp-compare', before, after, before], ['mcp-snapshot', before, after],
    ['integration-check', before, '--engine', 'untrusted'], ['mcp-snapshot', before, '--json', '--json'],
    ['integration-check', before], ['mcp-snapshot', 'https://invalid.invalid/catalog.json'],
  ]) {
    const result = await invoke(args);
    assert.equal(result.code, 2, JSON.stringify(args));
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error.code, 'INVALID_INPUT');
  }
});

test('MCP impact CLI binds an explicit customer call and its parser without execution', async t => {
  const work = resolve('work');
  await mkdir(work, { recursive: true });
  const directory = await mkdtemp(join(work, 'mcp-impact-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const consumer = join(directory, 'consumer');
  await mkdir(consumer);
  await copyFile(resolve('fixtures/mcp/consumer-before.mjs'), join(consumer, 'quote.mjs'));
  const bindingPath = join(directory, 'bindings.json');
  await writeFile(bindingPath, JSON.stringify([{ file: 'quote.mjs', receiver: 'client',
    serverId: 'fictional-commerce-tools', authContextId: 'fixture-team-reader' }]));
  const result = await invoke(['mcp-impact', before, after, '--consumer', consumer, '--bindings', bindingPath, '--json']);
  assert.equal(result.code, 1, result.stderr);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.equal(report.inventory.codeExecuted, false);
  assert.equal(report.authorization, 'not-granted');
  assert.equal(report.inventory.calls.length, 1);
  assert.equal(report.inventory.calls[0].resolution, 'bound');
  assert.ok(report.matches.some(match => match.parserLocations.length > 0));
  const unbound = await invoke(['mcp-impact', before, before, '--consumer', consumer]);
  assert.equal(unbound.code, 1);
  assert.match(unbound.stdout, /Unresolved calls: 1/u);
  for (const args of [
    ['mcp-impact', before, after],
    ['mcp-impact', before, after, '--consumer', consumer, '--bindings', before],
    ['mcp-compare', before, after, '--consumer', consumer],
    ['mcp-impact', before, after, '--consumer', consumer, '--consumer', consumer],
  ]) {
    const rejected = await invoke(args);
    assert.equal(rejected.code, 2, JSON.stringify(args));
    assert.equal(rejected.stdout, '');
  }
});
