import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const cli = join(root, 'dist/cli.js');
const enginePath = join(root, 'work/tools/oasdiff', process.platform === 'win32' ? 'oasdiff.exe' : 'oasdiff');
function invoke(args) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.error, undefined);
  return result;
}

test('scan CLI inspects the fixture without an engine or execution authorization', () => {
  const result = invoke(['scan', 'fixtures/consumer', '--json']);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  const inventory = JSON.parse(result.stdout);
  assert.equal(inventory.calls.length, 1);
  assert.equal(inventory.codeExecuted, false);
  assert.equal(inventory.validationCandidates.length, 2);
});

test('impact CLI reports real breaking changes and matched usages as review evidence', () => {
  const result = invoke(['impact', 'fixtures/orders-v1.json', 'fixtures/orders-v2.json', '--consumer', 'fixtures/consumer', '--provider-base-url', 'https://orders.example.invalid', '--engine', enginePath, '--json']);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.equal(report.matches.length, 2);
  assert.equal(report.conclusion, 'review-required');
});

test('new command options cannot silently change the legacy compare contract', () => {
  for (const args of [
    ['scan', 'fixtures/consumer', '--engine', enginePath],
    ['impact', 'fixtures/orders-v1.json', 'fixtures/orders-v2.json', '--engine', enginePath],
    ['compare', 'fixtures/orders-v1.json', 'fixtures/orders-v2.json', '--engine', enginePath, '--consumer', 'fixtures/consumer'],
  ]) {
    const result = invoke(args);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error.code, 'INVALID_INPUT');
  }
});
