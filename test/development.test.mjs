import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runDevelopment } from '../tooling/development.mjs';

test('development status describes operational commands without loading a delivery roadmap', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../tooling/development.mjs', import.meta.url)), 'status'], {
    cwd: fileURLToPath(new URL('../tooling', import.meta.url)),
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /Build: pnpm build/u);
  assert.match(result.stdout, /Validation: pnpm dev:check/u);
  assert.match(result.stdout, /Local laboratory: pnpm dev:local --help/u);
  assert.match(result.stdout, /CLI: pnpm keepseam --help/u);
  assert.match(result.stdout, /Technical documentation: docs\/technical-guide\.pdf/u);
  assert.doesNotMatch(result.stdout, /Next implementation|planned|in-progress|milestone|delivery\.json/u);
});

test('development check propagates success and failures without claiming completion', async () => {
  for (const exitCode of [0, 17]) {
    let stderr = '';
    let stdout = '';
    let calls = 0;
    const code = await runDevelopment(['check'], {
      runCheck: async () => { calls += 1; return exitCode; },
      stdout: text => { stdout += text; },
      stderr: text => { stderr += text; },
    });
    assert.equal(code, exitCode);
    assert.equal(calls, 1);
    if (exitCode === 0) {
      assert.equal(stderr, '');
      assert.match(stdout, /Checks passed/u);
    } else {
      assert.equal(stdout, '');
      assert.match(stderr, /Checks failed \(exit 17\)/u);
    }
    assert.doesNotMatch(stdout + stderr, /completed|Delivery|milestone/u);
  }
});

test('development harness rejects extra command arguments without starting checks', async () => {
  let called = false;
  const code = await runDevelopment(['check', '--unexpected'], {
    runCheck: async () => { called = true; return 0; },
    stdout: () => {},
    stderr: () => {},
  });
  assert.equal(code, 2);
  assert.equal(called, false);
});
