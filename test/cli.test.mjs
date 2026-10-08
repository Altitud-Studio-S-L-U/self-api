import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { runCli } from '../dist/cli.js';
import { PlumberError } from '../dist/errors.js';

const root = resolve(import.meta.dirname, '..');
const cli = join(root, 'dist', 'cli.js');
const argumentsForCompare = ['compare', 'base.json', 'revision.json', '--engine', 'oasdiff'];
const terminalControls = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/u;

function invoke(args) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return result;
}

function report(overrides = {}) {
  const metadata = {
    sha256: '0'.repeat(64),
    byteLength: 100,
    specificationVersion: '3.0.3',
    apiVersion: '1',
  };
  return {
    schemaVersion: 1,
    engine: { name: 'oasdiff', version: 'fixture-version' },
    base: metadata,
    revision: { ...metadata, apiVersion: '2' },
    contentChanged: true,
    status: 'no-breaking-changes',
    changes: [],
    coverage: 'structural-contract-only',
    consumerImpact: 'not-analyzed',
    ...overrides,
  };
}

async function capture(args, compare) {
  let stdout = '';
  let stderr = '';
  const code = await runCli(args, {
    compare,
    stdout: (text) => { stdout += text; },
    stderr: (text) => { stderr += text; },
  });
  return { code, stdout, stderr };
}

test('the built CLI shows help without requiring an engine', () => {
  const result = invoke(['--help']);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /keepseam compare <base\.json> <revision\.json>/u);
  assert.match(result.stdout, /consumer impact is not analyzed/u);
});

test('the built CLI rejects missing arguments and unknown options as input errors', () => {
  for (const args of [
    [],
    ['watch'],
    ['compare', 'base.json', 'revision.json'],
    ['compare', 'base.json', '--engine', 'oasdiff'],
    [...argumentsForCompare, 'extra.json'],
    [...argumentsForCompare, '--unknown'],
    ['compare', 'base.json', 'revision.json', '--engine'],
    [...argumentsForCompare, '--json=true'],
  ]) {
    const result = invoke(args);
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.equal(result.stdout, '');
    const error = JSON.parse(result.stderr).error;
    assert.equal(error.code, 'INVALID_INPUT');
    assert.equal(typeof error.message, 'string');
    assert.deepEqual(Object.keys(error).sort(), ['code', 'message']);
  }
});

test('the built CLI reports an actually missing engine with exit code 2', (t) => {
  const work = join(root, 'work');
  mkdirSync(work, { recursive: true });
  const directory = mkdtempSync(join(work, 'cli-test-'));
  t.after(() => {
    const target = resolve(directory);
    const ownedPath = relative(resolve(work), target);
    assert.ok(!isAbsolute(ownedPath) && !ownedPath.includes('..') &&
      ownedPath.startsWith('cli-test-') && !ownedPath.includes('/') && !ownedPath.includes('\\'),
    'Temporary cleanup must stay in the test-owned directory inside work');
    rmSync(target, { recursive: true, force: true });
  });
  const basePath = join(directory, 'base.json');
  const revisionPath = join(directory, 'revision.json');
  writeFileSync(basePath, JSON.stringify({ openapi: '3.0.3', info: { title: 'Fixture', version: '1' }, paths: {} }));
  writeFileSync(revisionPath, JSON.stringify({ openapi: '3.0.3', info: { title: 'Fixture', version: '2' }, paths: {} }));
  const result = invoke(['compare', basePath, revisionPath, '--engine', join(directory, 'missing-oasdiff.exe'), '--json']);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).error.code, 'ENGINE_UNAVAILABLE');
});

test('runCli passes selected paths unchanged and emits only the JSON comparison report', async () => {
  const expected = report();
  let received;
  const result = await capture([...argumentsForCompare, '--json'], async (input) => {
    received = input;
    return expected;
  });
  assert.deepEqual(received, { basePath: 'base.json', revisionPath: 'revision.json', enginePath: 'oasdiff' });
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), expected);
  assert.equal(result.stdout, `${JSON.stringify(expected)}\n`);
});

test('text output describes breaking changes and escapes externally supplied terminal controls', async () => {
  const expected = report({
    status: 'breaking-changes',
    changes: [{ id: 'removed\u001b', level: 'error', operation: 'GET', path: '/items\n/injected', text: 'Removed\u009b\u202e' }],
  });
  const result = await capture(argumentsForCompare, async () => expected);
  assert.equal(result.code, 1);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, [
    'Breaking changes detected.',
    'Engine: oasdiff fixture-version',
    'API version: 1 -> 2',
    'Content changed: yes',
    'Coverage: structural contract only. Consumer impact: not analyzed.',
    'Changes: 1',
    '- [error] removed\\u001b: GET /items\\u000a/injected — Removed\\u009b\\u202e',
    '',
  ].join('\n'));
  assert.doesNotMatch(result.stdout, terminalControls);
});

test('JSON output retains report data while escaping terminal controls', async () => {
  const expected = report({
    engine: { name: 'oasdiff', version: 'fixture\u001b\u009b\u202e' },
    status: 'breaking-changes',
  });
  const result = await capture([...argumentsForCompare, '--json'], async () => expected);
  assert.equal(result.code, 1);
  assert.deepEqual(JSON.parse(result.stdout), expected);
  assert.doesNotMatch(result.stdout, terminalControls);
});

test('text output supports findings that apply to the whole contract', async () => {
  const result = await capture(argumentsForCompare, async () => report({
    status: 'breaking-changes',
    changes: [{ id: 'global-change', level: 'warning', text: 'Contract-wide change' }],
  }));
  assert.equal(result.code, 1);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /- \[warning\] global-change: Contract-wide change\n/u);
  assert.doesNotMatch(result.stdout, /undefined/u);
});

test('known errors use JSON stderr in both modes and never emit a stack', async () => {
  const message = 'Unavailable\u001b[31m\nengine\u009b\u202e';
  for (const args of [argumentsForCompare, [...argumentsForCompare, '--json']]) {
    const result = await capture(args, async () => { throw new PlumberError('ENGINE_UNAVAILABLE', message); });
    assert.equal(result.code, 2);
    assert.equal(result.stdout, '');
    assert.deepEqual(JSON.parse(result.stderr), { error: { code: 'ENGINE_UNAVAILABLE', message } });
    assert.doesNotMatch(result.stderr, terminalControls);
  }
});

test('unexpected comparator errors are reported without exposing their details', async () => {
  const result = await capture(argumentsForCompare, async () => { throw new Error('private internal detail'); });
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.deepEqual(JSON.parse(result.stderr), {
    error: { code: 'ENGINE_FAILED', message: 'Comparison failed unexpectedly.' },
  });
  assert.doesNotMatch(result.stderr, /private internal detail|stack/u);
});

test('help and parsing failures never invoke the comparison engine', async () => {
  let calls = 0;
  const compare = async () => { calls += 1; return report(); };
  assert.equal((await capture(['-h'], compare)).code, 0);
  const invalid = await capture([...argumentsForCompare, '--unknown\u001b\u009b'], compare);
  assert.equal(invalid.code, 2);
  assert.doesNotMatch(invalid.stderr, terminalControls);
  assert.equal(calls, 0);
});
