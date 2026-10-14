import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test, { before } from 'node:test';
import { runDockerValidation } from '../dist/docker-runner.js';
import { MAVEN_FIXTURE_POM, validateRuntime } from '../dist/validation-runtime.js';

const runtimes = {};
before(async () => {
  assert.equal(process.platform, 'linux', 'Real framework validation requires the dedicated Linux Docker job.');
  for (const kind of ['pytest', 'maven-junit']) {
    runtimes[kind] = validateRuntime(JSON.parse(await readFile(resolve(`work/audit/${kind === 'pytest' ? 'pytest' : 'maven-junit'}-runtime.json`), 'utf8')));
    execFileSync('/usr/bin/docker', ['image', 'inspect', runtimes[kind].imageId], { stdio: 'ignore' });
  }
});

async function validate(t, kind, source) {
  const parent = resolve('work/framework-runner');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'case-'));
  t.after(() => rm(directory, { recursive: true }));
  const snapshotPath = join(directory, 'snapshot'), statePath = join(directory, 'state');
  await mkdir(snapshotPath, { mode: 0o755 });
  await mkdir(statePath, { mode: 0o700 });
  const path = kind === 'pytest' ? 'test_contract.py' : 'src/test/java/ContractTest.java';
  if (kind === 'maven-junit') {
    await mkdir(join(snapshotPath, 'src/test/java'), { recursive: true, mode: 0o755 });
    await writeFile(join(snapshotPath, 'pom.xml'), MAVEN_FIXTURE_POM, { mode: 0o444 });
  }
  await writeFile(join(snapshotPath, path), source, { mode: 0o444 });
  const result = await runDockerValidation({ snapshotPath, statePath, testPaths: [path], runtime: runtimes[kind] });
  assert.equal(await readFile(join(snapshotPath, path), 'utf8'), source);
  assert.equal(result.cleanup, 'removed', JSON.stringify(result));
  assert.throws(() => execFileSync('/usr/bin/docker', ['container', 'inspect', result.containerName], { stdio: 'ignore' }));
  return result;
}

for (const kind of ['pytest', 'maven-junit']) {
  for (const success of [true, false]) {
    test(`${kind} executes a real ${success ? 'passing' : 'failing'} assertion offline`, { timeout: 150_000 }, async t => {
      const source = kind === 'pytest' ? `def test_contract():\n    assert ${success ? 'True' : 'False'}, 'framework assertion sentinel'\n`
        : `import org.junit.jupiter.api.Test; import static org.junit.jupiter.api.Assertions.assertTrue; class ContractTest { @Test void contract() { assertTrue(${success}, "framework assertion sentinel"); } }\n`;
      const result = await validate(t, kind, source);
      assert.equal(result.status, success ? 'passed' : 'failed', `${result.stdout}\n${result.stderr}`);
      if (success) assert.match(result.stdout, kind === 'pytest' ? /1 passed/u : /KEEPSEAM_JUNIT_EXECUTED/u);
      else assert.match(result.stdout + result.stderr, /framework assertion sentinel/u);
    });
  }
  for (const empty of [true, false]) {
    test(`${kind} rejects ${empty ? 'no tests' : 'all tests skipped'} as successful validation`, { timeout: 150_000 }, async t => {
      const source = kind === 'pytest' ? empty ? 'VALUE = 1\n' : 'import pytest\n@pytest.mark.skip(reason="synthetic skipped test")\ndef test_contract(): pass\n'
        : empty ? 'class ContractTest {}\n' : 'import org.junit.jupiter.api.Test; import org.junit.jupiter.api.Disabled; class ContractTest { @Disabled @Test void contract() {} }\n';
      const result = await validate(t, kind, source);
      assert.equal(result.status, 'failed', `${result.stdout}\n${result.stderr}`);
      assert.notEqual(result.exitCode, 0);
      assert.match(result.stdout + result.stderr, kind === 'pytest' ? /collect a test|skipped/u : /No tests|must execute a test/u);
    });
  }
}
