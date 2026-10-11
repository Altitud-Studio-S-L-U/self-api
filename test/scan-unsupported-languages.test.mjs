import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { scanConsumer } from '../dist/index.js';
import { runCli } from '../dist/cli.js';

async function fixture(t, files) {
  const parent = resolve('work/scan-language-tests');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'consumer-'));
  t.after(async () => {
    const actual = await realpath(root);
    assert.equal(dirname(actual), await realpath(parent));
    assert.ok(basename(actual).startsWith('consumer-'));
    await rm(actual, { recursive: true });
  });
  for (const [name, text] of Object.entries(files)) await writeFile(join(root, name), text);
  return root;
}

for (const name of ['payments.py', 'Payments.java']) {
  test(`a ${name} consumer cannot be reported as a successful empty scan`, async t => {
    const root = await fixture(t, { [name]: 'This source must not be parsed as JavaScript.' });
    const inventory = await scanConsumer(root);
    assert.deepEqual(inventory.files, []);
    assert.deepEqual(inventory.skipped, [{ path: name, reason: 'unsupported-extension' }]);
    assert.deepEqual(inventory.issues, [{ code: 'unsupported-language', location: { file: name, line: 1, column: 1 } }]);
    let stdout = '', stderr = '';
    const code = await runCli(['scan', root], { stdout: text => { stdout += text; }, stderr: text => { stderr += text; } });
    assert.equal(code, 1);
    assert.equal(stderr, '');
    assert.ok(stdout.includes(name));
    assert.match(stdout, /unsupported-language/u);
    assert.match(stdout, /Consumer code executed: no/u);
  });
}

test('mixed repositories retain supported calls while surfacing unsupported Python and Java source', async t => {
  const root = await fixture(t, {
    'payments.mjs': 'async function payment() { const response = await fetch("https://example.test/payments/p42"); const data = await response.json(); return data.amount; }',
    'payments.py': 'raise RuntimeError("must not execute")',
    'Payments.java': 'class Payments {}',
    'fixture.json': '{}', 'README.md': 'not source',
  });
  const inventory = await scanConsumer(root);
  assert.equal(inventory.calls.length, 1);
  assert.equal(inventory.calls[0].resolution, 'resolved');
  assert.deepEqual(inventory.files.map(file => file.path), ['payments.mjs']);
  assert.deepEqual(inventory.issues.map(issue => [issue.code, issue.location.file]), [
    ['unsupported-language', 'Payments.java'], ['unsupported-language', 'payments.py'],
  ]);
  let output = '';
  const exit = await runCli(['scan', root, '--json'], { stdout: text => { output += text; }, stderr: () => {} });
  assert.equal(exit, 1);
  assert.equal(JSON.parse(output).issues.length, 2);
});
