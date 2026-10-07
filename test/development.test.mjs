import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runDevelopment } from '../tooling/development.mjs';

const manifestFile = new URL('../tooling/delivery.json', import.meta.url);

test('development status separates pending review from the next implementation milestone', async () => {
  const before = await readFile(manifestFile, 'utf8');
  const { items } = JSON.parse(before);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../tooling/development.mjs', import.meta.url)), 'status'], {
    cwd: fileURLToPath(new URL('../tooling', import.meta.url)),
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  const nextId = result.stdout.match(/^Next implementation: (.+)$/mu)?.[1];
  const next = items.find(item => item.id === nextId);
  if (items.some(item => ['planned', 'in-progress'].includes(item.status))) {
    assert.ok(next && ['planned', 'in-progress'].includes(next.status));
    for (const criterion of next.acceptance) assert.ok(result.stdout.includes(criterion));
  } else {
    assert.equal(nextId, undefined);
  }
  for (const item of items.filter(item => item.status === 'in-review')) {
    assert.notEqual(nextId, item.id);
    if (item.pullRequest) assert.ok(result.stdout.includes(item.pullRequest));
  }
  assert.equal(await readFile(manifestFile, 'utf8'), before);
});

test('development check propagates results without changing delivery state', async () => {
  const before = await readFile(manifestFile, 'utf8');
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
    assert.equal(await readFile(manifestFile, 'utf8'), before);
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
