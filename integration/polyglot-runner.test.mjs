import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import test, { before } from 'node:test';
import { promisify } from 'node:util';
import { JAVA_DOCKER_PROFILE, PYTHON_DOCKER_PROFILE, runDockerValidation } from '../dist/docker-runner.js';

const root = resolve(import.meta.dirname, '..');
const execute = promisify(execFile);
const dockerOptions = { shell: false, timeout: 15_000, maxBuffer: 128 * 1024, encoding: 'utf8' };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

before(async () => {
  assert.equal(process.platform, 'linux', 'Run the real polyglot runner tests in the dedicated Linux Docker job.');
  for (const profile of [JAVA_DOCKER_PROFILE, PYTHON_DOCKER_PROFILE]) {
    await execute('docker', ['image', 'inspect', profile.image], dockerOptions);
  }
});

async function validate(t, filename, source) {
  const parent = resolve(root, 'work', 'polyglot-runner-integration');
  await mkdir(parent, { recursive: true });
  const actualParent = await realpath(parent);
  const directory = await mkdtemp(join(actualParent, 'case-'));
  t.after(async () => {
    const actual = await realpath(directory);
    assert.equal(dirname(actual), actualParent);
    assert(basename(actual).startsWith('case-'));
    await rm(actual, { recursive: true, force: false });
  });
  const snapshotPath = join(directory, 'consumer'), statePath = join(directory, 'state');
  await mkdir(snapshotPath, { mode: 0o755 });
  await chmod(snapshotPath, 0o755);
  await mkdir(statePath, { mode: 0o700 });
  const path = join(snapshotPath, filename);
  await writeFile(path, source, { mode: 0o644 });
  await chmod(path, 0o644);
  const before = hash(await readFile(path));
  const result = await runDockerValidation({ snapshotPath, statePath, testPaths: [filename] });
  assert.equal(hash(await readFile(path)), before, 'The isolated runner changed its captured test.');
  assert.equal(result.cleanup, 'removed', `${result.status}: ${result.reason ?? result.stderr}`);
  assert.match(result.containerName, /^keepseam-validation-[a-f0-9-]+$/u);
  await assert.rejects(execute('docker', ['container', 'inspect', result.containerName], dockerOptions), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /No such (?:object|container)/iu);
    return true;
  });
  return result;
}

for (const passes of [false, true]) {
  test(`Java language assertions are ${passes ? 'passing' : 'failing'} test evidence`, { timeout: 60_000 }, async t => {
    const source = `public class AssertionsTest { public static void main(String[] args) { assert ${passes} : "synthetic assertion sentinel"; } }\n`;
    const result = await validate(t, 'AssertionsTest.java', source);
    assert.equal(result.status, passes ? 'passed' : 'failed', `${result.stdout}\n${result.stderr}`);
    if (passes) assert.equal(result.exitCode, 0);
    else {
      assert.notEqual(result.exitCode, 0);
      assert.match(result.stderr, /AssertionError: synthetic assertion sentinel/u);
    }
  });
}

for (const passes of [false, true]) {
  test(`Python unittest without a main block executes its ${passes ? 'passing' : 'failing'} case`, { timeout: 60_000 }, async t => {
    const source = `import unittest\nclass ContractTest(unittest.TestCase):\n    def test_contract(self):\n        self.assertTrue(${passes ? 'True' : 'False'}, "synthetic unittest sentinel")\n`;
    const result = await validate(t, 'test_contract.py', source);
    assert.equal(result.status, passes ? 'passed' : 'failed', `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /Ran 1 test/u);
    if (passes) assert.equal(result.exitCode, 0);
    else {
      assert.notEqual(result.exitCode, 0);
      assert.match(result.stderr, /synthetic unittest sentinel/u);
    }
  });
}

for (const [description, source, errorPattern] of [
  ['an empty module', 'VALUE = 1\n', /at least one unittest case/u],
  ['pytest-style functions without unittest cases', 'def test_contract():\n    assert False, "unexecuted synthetic pytest sentinel"\n', /at least one unittest case/u],
  ['an import that exits successfully before test execution', 'raise SystemExit(0)\n', /must not exit during import/u],
]) {
  test(`Python rejects ${description} as successful validation`, { timeout: 60_000 }, async t => {
    const result = await validate(t, 'test_contract.py', source);
    assert.equal(result.status, 'failed', `${result.stdout}\n${result.stderr}`);
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, errorPattern);
  });
}

test('Python imports unittest once and preserves the guarded main block', { timeout: 60_000 }, async t => {
  const source = 'import builtins, unittest\nbuiltins.keepseam_synthetic_imports = getattr(builtins, "keepseam_synthetic_imports", 0) + 1\nclass ContractTest(unittest.TestCase):\n    def test_contract(self):\n        self.assertEqual(builtins.keepseam_synthetic_imports, 1)\nif __name__ == "__main__":\n    raise AssertionError("the unittest module must be imported, not launched as a script")\n';
  const result = await validate(t, 'test_contract.py', source);
  assert.equal(result.status, 'passed', `${result.stdout}\n${result.stderr}`);
  assert.equal(result.exitCode, 0);
  assert.match(result.stderr, /Ran 1 test/u);
});
