import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { runPublicationCli } from '../dist/publication-cli.js';
import { PlumberError } from '../dist/errors.js';

const id = '1'.repeat(64);
const gitPath = resolve('trusted tools', process.platform === 'win32' ? 'git.exe' : 'git');
const enginePath = resolve('trusted tools', process.platform === 'win32' ? 'oasdiff.exe' : 'oasdiff');
const args = ['publication-plan', id, '--state', 'private state', '--git', gitPath,
  '--repository', 'Altitud-Studio-S-L-U/plumber', '--base', 'main', '--engine', enginePath];
const candidate = {
  schemaVersion: 1, id: '2'.repeat(64), status: 'requires-remote-verification',
  authorization: 'not-granted', publication: 'not-started',
  validation: { intentId: id, requestId: '3'.repeat(64), receiptId: 'c49370c9-14e8-4470-b41d-bc3861a20504', status: 'passed' },
  evidence: { planId: 'b'.repeat(64), executionDigest: 'c'.repeat(64), policyDigest: 'd'.repeat(64), outcomeDigest: 'e'.repeat(64) },
  git: { canonicalRootId: '4'.repeat(64), headSha: '5'.repeat(40), treeSha: '6'.repeat(40), consumerDigest: '7'.repeat(64) },
  destination: { host: 'github.com', owner: 'Altitud-Studio-S-L-U', name: 'plumber', baseBranch: 'main', verified: false },
  headBranch: 'feat/api-123456789abc',
  files: [{ path: 'orders.mjs', mode: '100644', gitBlobId: '8'.repeat(40), beforeSha256: '9'.repeat(64),
    afterSha256: 'a'.repeat(64), before: 'private original source', after: 'private replacement source' }],
  pullRequest: { title: 'Update order integration', body: 'private drafted body', draft: true },
  consumerModified: false,
};

async function capture(commandArgs = args, prepare = async () => candidate) {
  let stdout = '';
  let stderr = '';
  const calls = [];
  const code = await runPublicationCli(commandArgs, {
    prepare: async input => { calls.push(input); return prepare(input); },
    stdout: text => { stdout += text; }, stderr: text => { stderr += text; },
  });
  return { code, stdout, stderr, calls };
}

test('publication-plan prepares only the supplied local candidate and identifies the unverified destination', async () => {
  const result = await capture();
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(result.calls, [{ statePath: 'private state', intentId: id, gitPath, enginePath,
    repository: 'Altitud-Studio-S-L-U/plumber', baseBranch: 'main' }]);
  assert.match(result.stdout, /requires-remote-verification/u);
  assert.ok(result.stdout.includes(candidate.git.headSha));
  assert.ok(result.stdout.includes(candidate.git.treeSha));
  assert.match(result.stdout, /Repository destination \(not verified\): github.com\/Altitud-Studio-S-L-U\/plumber/u);
  assert.match(result.stdout, /Base branch \(not verified\): main/u);
  assert.ok(result.stdout.includes(candidate.pullRequest.title));
  assert.ok(result.stdout.includes(candidate.files[0].beforeSha256));
  assert.ok(result.stdout.includes(candidate.files[0].afterSha256));
  assert.match(result.stdout, /Authorization: not granted\. Publication: not started/u);
  assert.match(result.stdout, /No network access or GitHub writes\. Live consumer unchanged/u);
  assert.doesNotMatch(result.stdout, /Type the exact|authorize one attempt|Approval receipt/u);
});

test('default text omits source previews and the PR body; explicit JSON retains the private candidate', async () => {
  const text = await capture();
  for (const privateText of [candidate.files[0].before, candidate.files[0].after, candidate.pullRequest.body]) {
    assert.ok(!text.stdout.includes(privateText));
    assert.ok(!text.stderr.includes(privateText));
  }
  const json = await capture([...args, '--json']);
  assert.equal(json.code, 0);
  assert.deepEqual(JSON.parse(json.stdout), candidate);
  assert.equal(json.calls.length, 1);
});

test('invalid, duplicate or additional action arguments fail before preparing anything', async () => {
  for (const commandArgs of [
    [], ['publication-plan'], ['publish', ...args.slice(1)], [...args, 'extra'],
    [...args, '--yes'], [...args, '--approve'], [...args, '--push'], [...args, '--force'],
    [...args, '--json=true'], [...args, '--json', '--json'], [...args, '--state', 'another'],
    [...args, '--git', gitPath], [...args, '--engine', enginePath], [...args, '--repository', 'Other/repo'], [...args, '--base', 'other'],
    args.filter((_, index) => index !== 2 && index !== 3),
    args.filter((_, index) => index !== 4 && index !== 5),
    args.filter((_, index) => index !== 6 && index !== 7),
    args.filter((_, index) => index !== 8 && index !== 9),
    args.filter((_, index) => index !== 10 && index !== 11),
    args.map((value, index) => index === 1 ? 'invalid-id' : value),
    args.map((value, index) => index === 3 ? ' ' : value),
    args.map((value, index) => index === 5 ? 'relative/git' : value),
    args.map((value, index) => index === 7 ? 'https://github.com/owner/repo' : value),
    args.map((value, index) => index === 7 ? 'owner/repo/extra' : value),
    args.map((value, index) => index === 9 ? ' ' : value),
    args.map((value, index) => index === 11 ? ' ' : value),
  ]) {
    const result = await capture(commandArgs);
    assert.equal(result.code, 2, JSON.stringify(commandArgs));
    assert.deepEqual(result.calls, [], JSON.stringify(commandArgs));
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error.code, 'INVALID_INPUT');
  }
});

test('terminal controls in candidate presentation are escaped in text and explicit JSON', async () => {
  const hostile = { ...candidate,
    pullRequest: { ...candidate.pullRequest, title: 'Review\u001b[2J\u202espoof' },
    files: [{ ...candidate.files[0], path: 'orders\u0008\u2066.mjs', after: 'private\u001b[2J\u202esource' }],
    destination: { ...candidate.destination, owner: 'owner\u000dspoof', name: 'repo\u009bspoof', baseBranch: 'main\u2028spoof' },
  };
  const text = await capture(args, async () => hostile);
  assert.equal(text.code, 0);
  assert.doesNotMatch(text.stdout, /[\u0008\u000d\u001b\u009b\u2028\u202e\u2066]/u);
  assert.match(text.stdout, /Review\\u001b\[2J\\u202espoof/u);
  assert.ok(!text.stdout.includes('private'));
  const json = await capture([...args, '--json'], async () => hostile);
  assert.doesNotMatch(json.stdout, /[\u0008\u000d\u001b\u009b\u2028\u202e\u2066]/u);
  assert.deepEqual(JSON.parse(json.stdout), hostile);
});

test('SDK failures return sanitized JSON without exposing unexpected errors or partial candidates', async () => {
  const unexpected = await capture([...args, '--json'], async () => { throw new Error('credential=private-token\u001b[2J'); });
  assert.equal(unexpected.code, 2);
  assert.equal(unexpected.stdout, '');
  assert.deepEqual(JSON.parse(unexpected.stderr), { error: { code: 'ENGINE_FAILED', message: 'Publication proposal failed unexpectedly.' } });
  assert.doesNotMatch(unexpected.stderr, /private-token|credential|stack/u);
  const known = await capture(args, async () => { throw new PlumberError('INVALID_INPUT', 'Evidence changed\u001b[2J\u202e'); });
  assert.equal(known.code, 2);
  assert.equal(known.stdout, '');
  assert.equal(JSON.parse(known.stderr).error.code, 'INVALID_INPUT');
  assert.doesNotMatch(known.stderr, /[\u001b\u202e]/u);
});
