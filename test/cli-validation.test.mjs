import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { runCli } from '../dist/cli.js';

const recipePath = resolve(import.meta.dirname, '../fixtures/orders-migration.json');
const common = ['base.json', 'revision.json', '--consumer', 'consumer', '--engine', 'oasdiff', '--provider-base-url', 'https://orders.example.invalid', '--recipe', recipePath, '--test', 'orders.test.mjs'];
const request = {
  id: 'a'.repeat(64),
  plan: { id: 'b'.repeat(64), summary: 'Explicit proposal', status: 'ready-for-review', authorization: 'not-granted', validation: 'syntax-only', decisions: [], requirements: [],
    files: [{ path: 'orders.mjs', beforeSha256: 'c'.repeat(64), afterSha256: 'd'.repeat(64), before: 'old\u001b[31m\n', after: 'new\u202e\n' }] },
  spec: { profile: { id: 'fixed-profile', network: 'none', command: ['--test', '--test-reporter=tap', '--'] }, testPaths: ['orders.test.mjs'] },
};

async function invoke(args, overrides = {}) {
  let stdout = '';
  let stderr = '';
  const code = await runCli(args, { prepareValidation: async () => request, stdout: text => { stdout += text; }, stderr: text => { stderr += text; }, ...overrides });
  return { code, stdout, stderr };
}

test('validation-plan is read only and approval cancellation never grants or executes', async () => {
  const never = async () => { assert.fail('must not authorize or execute'); };
  const planned = await invoke(['validation-plan', ...common, '--json'], { approveValidation: never, executeValidation: never });
  assert.equal(planned.code, 0);
  assert.deepEqual(JSON.parse(planned.stdout), request);
  const cancelled = await invoke(['approve', ...common, '--state', 'state'], { approveValidation: never, executeValidation: never, confirm: async () => false });
  assert.equal(cancelled.code, 1);
  assert.match(cancelled.stdout, /Approval cancelled/);
  assert.match(cancelled.stdout, /Before: orders.mjs/);
  assert.doesNotMatch(cancelled.stdout, /[\u001b\u202e]/u);
});

test('approval requires a terminal by default and has no piped or --yes bypass', async () => {
  const result = await invoke(['approve', ...common, '--state', 'state'], { approveValidation: async () => assert.fail('must not approve') });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /interactive terminal/);
  for (const args of [
    ['approve', ...common, '--state', 'state', '--yes'],
    ['approve', ...common, '--state', 'state', '--json'],
    ['validate', ...common, '--state', 'state'],
    ['plan', ...common],
  ]) assert.equal((await invoke(args)).code, 2);
});

test('explicit confirmation approves the reviewed request but never starts it', async () => {
  let authorization;
  const result = await invoke(['approve', ...common, '--state', 'state'], {
    confirm: async id => { assert.equal(id, request.id); return true; },
    approveValidation: async input => { authorization = input; return { id: 'receipt-example', expiresAt: 'expiry-example' }; },
    executeValidation: async () => assert.fail('approval is not execution'),
  });
  assert.equal(result.code, 0);
  assert.equal(authorization.expectedRequestId, request.id);
  assert.equal(authorization.origin, 'local-cli');
  assert.deepEqual(authorization.options.testPaths, ['orders.test.mjs']);
  assert.match(result.stdout, /Validation has not started/);
});

test('validation exit codes distinguish complete passing results, baseline failures and blocked execution', async () => {
  for (const [status, expected] of [['passed', 0], ['improved', 1], ['regression', 1], ['failed', 1], ['blocked', 2]]) {
    const report = { status, baseline: { status: 'failed', stdout: 'private-log' }, consumerModified: false };
    const result = await invoke(['validate', ...common, '--state', 'state', '--approval', 'receipt-example'], {
      executeValidation: async input => { assert.equal(input.receiptId, 'receipt-example'); return report; },
    });
    assert.equal(result.code, expected);
    assert.doesNotMatch(result.stdout, /private-log/);
    assert.match(result.stdout, new RegExp(`Validation: ${status}`));
  }
});
