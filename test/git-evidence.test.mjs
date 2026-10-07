import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { delimiter, isAbsolute, join, relative, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { captureConsumer } from '../dist/consumer-files.js';
import { captureGitEvidence, createGitEvidenceCapture } from '../dist/git-evidence.js';

const root = resolve(import.meta.dirname, '..');
const work = join(root, 'work/test-git-evidence');
const hash = value => createHash('sha256').update(value).digest('hex');
const gitName = process.platform === 'win32' ? 'git.exe' : 'git';
let gitPath;
for (const directory of (process.env.PATH ?? '').split(delimiter)) {
  try {
    const candidate = await realpath(resolve(directory, gitName));
    if ((await lstat(candidate)).isFile()) { gitPath = candidate; break; }
  }
  catch {}
}
assert(gitPath, 'The Git evidence suite requires a trusted local Git binary.');

function git(directory, args, input) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  const result = spawnSync(gitPath, ['-c', 'core.autocrlf=false', '-c', 'core.hooksPath=', '-c', 'commit.gpgSign=false', ...args], {
    cwd: directory, env: { ...inherited, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_ALLOW_PROTOCOL: '' },
    input, encoding: 'utf8', shell: false, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trimEnd();
}

async function fixture(t, files = { 'api.ts': "export const call = () => fetch('https://api.example.invalid/v1');\n", 'package.json': '{"name":"fixture","private":true}\n' }) {
  await mkdir(work, { recursive: true });
  const directory = await mkdtemp(join(work, 'case-'));
  t.after(async () => {
    const owned = relative(work, directory);
    assert(!isAbsolute(owned) && owned.startsWith('case-') && !owned.includes('..'));
    await rm(directory, { recursive: true, force: true });
  });
  git(directory, ['init', '--object-format=sha1', '--initial-branch=main', '--template=']);
  git(directory, ['config', 'user.email', 'fixture@example.invalid']);
  git(directory, ['config', 'user.name', 'Fixture']);
  for (const [path, contents] of Object.entries(files)) {
    const absolute = join(directory, path);
    await mkdir(resolve(absolute, '..'), { recursive: true });
    await writeFile(absolute, contents);
  }
  git(directory, ['add', '--all']);
  git(directory, ['commit', '-m', 'Fixture']);
  return { directory, options: { consumerRoot: directory, gitPath } };
}

test('Git evidence binds exact HEAD, tree and all captured source/manifests without writing the index', async t => {
  const { directory, options } = await fixture(t, { 'src/a.ts': 'export const a = 1;\n', 'pkg/package.json': '{}\n', 'test.mjs': 'export {};\n' });
  const index = await readFile(join(directory, '.git/index'));
  const captured = await captureConsumer(directory);
  const evidence = await captureGitEvidence({ ...options, expectedConsumerDigest: captured.digest });
  assert.equal(evidence.headSha, git(directory, ['rev-parse', 'HEAD']));
  assert.equal(evidence.treeSha, git(directory, ['rev-parse', 'HEAD^{tree}']));
  assert.equal(evidence.consumerDigest, captured.digest);
  const canonical = process.platform === 'win32' ? directory.toLowerCase() : directory;
  assert.equal(evidence.canonicalRootId, hash(canonical));
  assert.deepEqual(evidence.files.map(file => file.path), ['pkg/package.json', 'src/a.ts', 'test.mjs']);
  for (const file of evidence.files) {
    assert.equal(file.gitBlobId, git(directory, ['rev-parse', `HEAD:${file.path}`]));
    assert.equal(file.sha256, hash(await readFile(join(directory, file.path))));
    assert.equal(file.mode, '100644');
  }
  assert.deepEqual(await readFile(join(directory, '.git/index')), index);
  assert(Object.isFrozen(evidence));
});

test('untracked, ignored, changed and deleted captured files fail bidirectional evidence', async t => {
  for (const change of ['new-source', 'ignored-source', 'changed-source', 'deleted-source', 'new-manifest', 'changed-manifest', 'deleted-manifest']) {
    await t.test(change, async t => {
      const { directory, options } = await fixture(t);
      if (change === 'new-source') await writeFile(join(directory, 'new.ts'), 'export {};\n');
      if (change === 'ignored-source') {
        await writeFile(join(directory, '.gitignore'), 'ignored.ts\n');
        await writeFile(join(directory, 'ignored.ts'), 'export {};\n');
      }
      if (change === 'changed-source') await writeFile(join(directory, 'api.ts'), 'export const changed = true;\n');
      if (change === 'deleted-source') await rm(join(directory, 'api.ts'));
      if (change === 'new-manifest') {
        await mkdir(join(directory, 'nested'));
        await writeFile(join(directory, 'nested/package.json'), '{}\n');
      }
      if (change === 'changed-manifest') await writeFile(join(directory, 'package.json'), '{"name":"changed"}\n');
      if (change === 'deleted-manifest') await rm(join(directory, 'package.json'));
      await assert.rejects(captureGitEvidence(options), /match HEAD|match raw HEAD/);
    });
  }
});

test('shared capture exclusions stay outside evidence while captured executable modes are preserved', async t => {
  const { directory, options } = await fixture(t, {
    'run.mjs': 'export {};\n', 'readme.md': 'text', 'api.d.ts': 'declare const a: string;\n',
    'dist/generated.ts': 'export {};\n', '.hidden/hidden.ts': 'export {};\n',
    'vendor/lib.ts': 'export {};\n', 'node_modules/lib/index.ts': 'export {};\n',
  });
  git(directory, ['update-index', '--chmod=+x', 'run.mjs']);
  git(directory, ['commit', '-m', 'Executable fixture']);
  await writeFile(join(directory, 'dist/generated.ts'), 'uncommitted ignored generated code');
  await rm(join(directory, 'api.d.ts'));
  const evidence = await captureGitEvidence(options);
  assert.deepEqual(evidence.files.map(({ path, mode }) => ({ path, mode })), [{ path: 'run.mjs', mode: '100755' }]);
});

test('staged captured changes are rejected even when worktree bytes still match HEAD', async t => {
  for (const change of ['changed', 'added', 'deleted', 'mode', 'unmerged']) {
    await t.test(change, async t => {
      const { directory, options } = await fixture(t);
      const original = await readFile(join(directory, 'api.ts'));
      if (change === 'changed') {
        await writeFile(join(directory, 'api.ts'), 'export const staged = true;\n');
        git(directory, ['add', 'api.ts']);
        await writeFile(join(directory, 'api.ts'), original);
      }
      if (change === 'added') {
        await writeFile(join(directory, 'new.ts'), 'export {};\n');
        git(directory, ['add', 'new.ts']);
        await rm(join(directory, 'new.ts'));
      }
      if (change === 'deleted') git(directory, ['rm', '--cached', 'api.ts']);
      if (change === 'mode') git(directory, ['update-index', '--chmod=+x', 'api.ts']);
      if (change === 'unmerged') {
        const blob = git(directory, ['rev-parse', 'HEAD:api.ts']);
        git(directory, ['update-index', '--index-info'], `0 ${'0'.repeat(40)}\tapi.ts\n100644 ${blob} 1\tapi.ts\n100644 ${blob} 2\tapi.ts\n100644 ${blob} 3\tapi.ts\n`);
      }
      await assert.rejects(captureGitEvidence(options), /index entries|merge conflicts/);
    });
  }
});

test('staged files outside the capture profile do not claim a globally clean checkout', async t => {
  const { directory, options } = await fixture(t, { 'api.ts': 'export {};\n', 'readme.md': 'before\n' });
  await writeFile(join(directory, 'readme.md'), 'staged\n');
  git(directory, ['add', 'readme.md']);
  assert.deepEqual((await captureGitEvidence(options)).files.map(file => file.path), ['api.ts']);
});

test('captured index changes during inspection invalidate evidence without refreshing or overwriting it', async t => {
  const { directory, options } = await fixture(t);
  const inspect = createGitEvidenceCapture({ spawn: (binary, args, processOptions) => {
    const child = spawn(binary, args, processOptions);
    if (args.includes('cat-file')) child.once('close', () => git(directory, ['update-index', '--chmod=+x', 'api.ts']));
    return child;
  } });
  await assert.rejects(inspect(options), /changed during inspection/);
  assert.match(git(directory, ['ls-files', '--stage', 'api.ts']), /^100755 /);
});

test('BOM and non-ASCII source bytes are compared exactly without line-ending normalization', async t => {
  const { directory, options } = await fixture(t, { 'api.ts': '\ufeffexport const label = "á💧";\n' });
  assert.equal((await captureGitEvidence(options)).files[0].sha256, hash(await readFile(join(directory, 'api.ts'))));
  await writeFile(join(directory, 'api.ts'), '\ufeffexport const label = "á💧";\r\n');
  await assert.rejects(captureGitEvidence(options), /raw HEAD blobs exactly/);
});

test('stale digests, relative executables and non-repository roots are rejected', async t => {
  const { directory, options } = await fixture(t);
  await assert.rejects(captureGitEvidence({ ...options, expectedConsumerDigest: '0'.repeat(64) }), /changed since/);
  await assert.rejects(captureGitEvidence({ ...options, expectedConsumerDigest: 'not-a-hash' }), /SHA-256/);
  await assert.rejects(captureGitEvidence({ ...options, gitPath: 'git' }), /absolute local Git/);
  await mkdir(join(directory, 'sub'));
  await assert.rejects(captureGitEvidence({ ...options, consumerRoot: join(directory, 'sub') }), /local Git worktree/);
});

test('linked worktrees and bare repositories are rejected by the explicit .git directory profile', async t => {
  const { directory, options } = await fixture(t);
  const linked = join(directory, 'work', 'linked');
  await mkdir(join(directory, 'work'));
  git(directory, ['worktree', 'add', '--detach', linked]);
  await assert.rejects(captureGitEvidence({ ...options, consumerRoot: linked }), /local .git directory/);
  const bare = join(directory, 'work', 'bare');
  git(directory, ['init', '--bare', '--template=', bare]);
  await assert.rejects(captureGitEvidence({ ...options, consumerRoot: bare }), /local Git worktree/);
});

test('Git config includes are rejected before Git starts or reads their destinations', async t => {
  for (const section of ['[include]\npath = /outside/never-read\n', '[includeIf "gitdir:*"]\npath = /outside/never-read\n', '[include.path]\nvalue = /outside/never-read\n']) {
    await t.test(section.split('\n')[0], async t => {
      const { directory, options } = await fixture(t);
      const configPath = join(directory, '.git/config');
      await writeFile(configPath, `${await readFile(configPath, 'utf8')}\n${section}`);
      let starts = 0;
      const inspect = createGitEvidenceCapture({ spawn: () => { starts += 1; throw new Error('must not launch'); } });
      await assert.rejects(inspect(options), /configuration includes/);
      assert.equal(starts, 0);
    });
  }
});

test('external object stores and additional worktree config are rejected before Git starts', async t => {
  for (const path of ['objects/info/alternates', 'objects/info/http-alternates', 'info/grafts', 'commondir', 'config.worktree']) {
    await t.test(path, async t => {
      const { directory, options } = await fixture(t);
      await mkdir(resolve(join(directory, '.git', path), '..'), { recursive: true });
      await writeFile(join(directory, '.git', path), '/outside/never-read\n');
      let starts = 0;
      const inspect = createGitEvidenceCapture({ spawn: () => { starts += 1; throw new Error('must not launch'); } });
      await assert.rejects(inspect(options), /External Git object stores/);
      assert.equal(starts, 0);
    });
  }
});

test('Gitlinks and symlink tree entries are rejected without following or fetching them', async t => {
  for (const mode of ['160000', '120000']) {
    await t.test(mode, async t => {
      const { directory, options } = await fixture(t);
      const id = mode === '160000' ? git(directory, ['rev-parse', 'HEAD']) : git(directory, ['hash-object', '-w', '--stdin'], '/outside/never-read');
      git(directory, ['update-index', '--add', '--cacheinfo', `${mode},${id},external`]);
      git(directory, ['commit', '-m', 'Unsupported fixture']);
      await assert.rejects(captureGitEvidence(options), /Git symlinks and submodules/);
    });
  }
});

test('SHA-256 repositories fail explicitly', async t => {
  const { directory, options } = await fixture(t);
  const target = join(directory, 'work', 'sha256');
  await mkdir(target, { recursive: true });
  git(target, ['init', '--object-format=sha256', '--template=']);
  await assert.rejects(captureGitEvidence({ ...options, consumerRoot: target }), /repository profile|SHA-1/);
});

test('the process boundary uses no shell, ambient credentials, lazy fetch, replacement objects or writable plumbing', async t => {
  const { options } = await fixture(t);
  const commands = [];
  const inspect = createGitEvidenceCapture({ spawn: (binary, args, processOptions) => {
    assert.equal(binary, gitPath);
    assert.equal(processOptions.shell, false);
    assert.equal(processOptions.windowsHide, true);
    assert.equal(processOptions.env.GIT_CONFIG_NOSYSTEM, '1');
    assert.equal(processOptions.env.GIT_ALLOW_PROTOCOL, '');
    assert.equal(processOptions.env.GIT_NO_LAZY_FETCH, '1');
    assert.equal(processOptions.env.GIT_NO_REPLACE_OBJECTS, '1');
    for (const key of Object.keys(processOptions.env)) assert(!/TOKEN|SECRET|PASSWORD|ASKPASS|SSH|CONFIG_COUNT|TRACE/u.test(key));
    for (const flag of ['--no-pager', '--no-replace-objects', '--no-lazy-fetch', '--no-optional-locks', 'core.fsmonitor=false', 'protocol.allow=never']) assert(args.includes(flag));
    commands.push(args);
    return spawn(binary, args, processOptions);
  } });
  await inspect(options);
  assert(commands.some(args => args.includes('cat-file') && args.includes('--batch')));
  assert(commands.every(args => !args.some(arg => ['status', 'checkout', 'diff', 'fetch', 'push', 'add', '--filters', '--textconv', '--follow-symlinks'].includes(arg))));
});

test('HEAD moving after raw blob reads invalidates evidence even when source bytes stay unchanged', async t => {
  const { directory, options } = await fixture(t);
  const inspect = createGitEvidenceCapture({ spawn: (binary, args, processOptions) => {
    const child = spawn(binary, args, processOptions);
    if (args.includes('cat-file')) child.once('close', () => git(directory, ['commit', '--allow-empty', '-m', 'Concurrent fixture']));
    return child;
  } });
  await assert.rejects(inspect(options), /changed during inspection/);
});

test('consumer changes after raw blob reads invalidate the second capture', async t => {
  const { directory, options } = await fixture(t);
  const inspect = createGitEvidenceCapture({ spawn: (binary, args, processOptions) => {
    const child = spawn(binary, args, processOptions);
    if (args.includes('cat-file')) child.once('close', () => {
      const changed = spawnSync(process.execPath, ['-e', "require('node:fs').writeFileSync(process.argv[1], 'export const changed = true;\\n')", join(directory, 'api.ts')], { windowsHide: true });
      assert.equal(changed.status, 0);
    });
    return child;
  } });
  await assert.rejects(inspect(options), /changed since/);
});

test('replace refs cannot substitute a different blob for the original HEAD evidence', async t => {
  const { directory, options } = await fixture(t);
  const before = await captureGitEvidence(options);
  const original = before.files.find(file => file.path === 'api.ts').gitBlobId;
  const replacement = git(directory, ['hash-object', '-w', '--stdin'], 'export const replacement = true;\n');
  git(directory, ['replace', original, replacement]);
  assert.deepEqual(await captureGitEvidence(options), before);
});

test('missing promisor blobs fail locally without invoking a remote helper', async t => {
  const { directory, options } = await fixture(t);
  const blob = git(directory, ['rev-parse', 'HEAD:api.ts']);
  await rm(join(directory, '.git/objects', blob.slice(0, 2), blob.slice(2)));
  git(directory, ['config', 'remote.origin.url', 'ext::must-never-run']);
  git(directory, ['config', 'remote.origin.promisor', 'true']);
  git(directory, ['config', 'remote.origin.partialclonefilter', 'blob:none']);
  await assert.rejects(captureGitEvidence(options), /unavailable locally|supported local repository/);
});

function earlyInputClose(output = '') {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.stdin.end = () => {
    queueMicrotask(() => child.stdin.emit('error', Object.assign(new Error('The child closed its input.'), { code: 'EPIPE' })));
    return child.stdin;
  };
  child.kill = () => { queueMicrotask(() => child.emit('close', null)); return true; };
  queueMicrotask(() => {
    child.stdout.end(output);
    setImmediate(() => child.emit('close', 0));
  });
  return child;
}

test('Git commands without input do not open a pipe that can fail after an early input close', async t => {
  const { options } = await fixture(t);
  let versionInput;
  const inspect = createGitEvidenceCapture({ spawn: (binary, args, processOptions) => {
    if (!args.includes('--version')) return spawn(binary, args, processOptions);
    versionInput = processOptions.stdio[0];
    const child = earlyInputClose('git version 2.55.0\n');
    if (versionInput === 'ignore') child.stdin = null;
    return child;
  } });
  const evidence = await inspect(options);
  assert.match(evidence.headSha, /^[a-f0-9]{40}$/);
  assert.equal(versionInput, 'ignore');
});

test('an early input close remains fatal when cat-file requires the requested object IDs', async t => {
  const { options } = await fixture(t);
  let catFileInput;
  const inspect = createGitEvidenceCapture({ spawn: (binary, args, processOptions) => {
    if (!args.includes('cat-file')) return spawn(binary, args, processOptions);
    catFileInput = processOptions.stdio[0];
    return earlyInputClose();
  } });
  await assert.rejects(inspect(options), /Git rejected the local evidence request/);
  assert.equal(catFileInput, 'pipe');
});

function fakeProcess(action) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => { queueMicrotask(() => child.emit('close', null)); return true; };
  queueMicrotask(() => action(child));
  return child;
}

test('command output, aggregate output and total elapsed time are bounded', async t => {
  const { options } = await fixture(t);
  await assert.rejects(createGitEvidenceCapture({ spawn: () => fakeProcess(child => child.stdout.write(Buffer.alloc(70 * 1024))) })(options), /command limit/);
  await assert.rejects(createGitEvidenceCapture({ maximumOutputBytes: 10, spawn: () => fakeProcess(child => child.stderr.write(Buffer.alloc(11))) })(options), /total limit/);
  await assert.rejects(createGitEvidenceCapture({ timeoutMs: 20, spawn: () => fakeProcess(() => {}) })(options), /time limit/);
});
