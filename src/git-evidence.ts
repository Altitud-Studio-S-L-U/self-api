import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { captureConsumer, isCapturedConsumerPath, type ConsumerCapture } from './consumer-files.js';
import { PlumberError } from './errors.js';

export interface GitEvidenceOptions {
  readonly consumerRoot: string;
  readonly gitPath: string;
  readonly expectedConsumerDigest?: string;
}

export interface GitEvidenceFile {
  readonly path: string;
  readonly gitBlobId: string;
  readonly mode: '100644' | '100755';
  readonly sha256: string;
}

export interface GitEvidence {
  readonly schemaVersion: 1;
  readonly headSha: string;
  readonly treeSha: string;
  readonly canonicalRootId: string;
  readonly consumerDigest: string;
  readonly files: readonly GitEvidenceFile[];
}

interface Dependencies {
  readonly spawn?: typeof spawn;
  readonly timeoutMs?: number;
  readonly maximumOutputBytes?: number;
}

const HASH = /^[a-f0-9]{64}$/u;
const OBJECT_ID = /^[a-f0-9]{40}$/u;
const MAX_OUTPUT = 20 * 1024 * 1024;
const MAX_BLOBS = 16 * 1024 * 1024 + 64 * 1024;
const MAX_TREE = 1024 * 1024;
const MAX_METADATA = 64 * 1024;

function invalid(message: string): never { throw new PlumberError('INVALID_INPUT', message); }
function order(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function sha256(bytes: Buffer | string): string { return createHash('sha256').update(bytes).digest('hex'); }
function canonical(path: string): string { return process.platform === 'win32' ? path.toLowerCase() : path; }

function decode(bytes: Buffer): string {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { invalid('Git metadata must be valid UTF-8.'); }
}

async function regularBytes(path: string): Promise<Buffer> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_METADATA) {
    invalid('Git metadata must be bounded regular local files.');
  }
  const handle = await open(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) invalid('Git metadata changed during inspection.');
    const bytes = Buffer.alloc(MAX_METADATA + 1);
    let length = 0;
    for (;;) {
      const result = await handle.read(bytes, length, bytes.length - length, null);
      length += result.bytesRead;
      if (length > MAX_METADATA) invalid('Git metadata exceeds its limit.');
      if (result.bytesRead === 0) break;
    }
    const after = await handle.stat();
    const current = await lstat(path);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || current.isSymbolicLink() || current.ino !== after.ino || current.dev !== after.dev) {
      invalid('Git metadata changed during inspection.');
    }
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}

async function rejectExisting(path: string): Promise<void> {
  try { await lstat(path); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  invalid('External Git object stores, grafts, and linked worktrees are not supported.');
}

async function inspectRepository(root: string): Promise<Buffer> {
  const gitDirectory = join(root, '.git');
  for (const path of [gitDirectory, join(gitDirectory, 'objects'), join(gitDirectory, 'objects/info'), join(gitDirectory, 'objects/pack')]) {
    const attributes = await lstat(path);
    if (attributes.isSymbolicLink() || !attributes.isDirectory()) {
      invalid('Git evidence requires a local .git directory without linked worktrees or symbolic links.');
    }
  }
  for (const path of ['commondir', 'config.worktree', 'objects/info/alternates', 'objects/info/http-alternates', 'info/grafts']) {
    await rejectExisting(join(gitDirectory, path));
  }
  const config = await regularBytes(join(gitDirectory, 'config'));
  // Reject include sections before Git can follow them, including the deprecated dotted form.
  if (/\[\s*include(?:if)?(?:[\s.\]"])/iu.test(decode(config))) {
    invalid('Git configuration includes are not supported by the local publication profile.');
  }
  return config;
}

function environment(gitPath: string): NodeJS.ProcessEnv {
  const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const env: NodeJS.ProcessEnv = {
    PATH: dirname(gitPath), LANG: 'C', LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: nullDevice, GIT_CONFIG_GLOBAL: nullDevice,
    GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: '', GIT_PROTOCOL_FROM_USER: '0',
    GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0',
  };
  if (process.platform === 'win32') {
    for (const key of ['SystemRoot', 'WINDIR']) if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function checkCapture(capture: ConsumerCapture, expected?: string): void {
  if (expected !== undefined && capture.digest !== expected) invalid('The consumer changed since the reviewed evidence.');
  if (capture.skipped.some(entry => entry.reason === 'symbolic-link' || entry.reason === 'non-regular-file')) {
    invalid('Symbolic links and non-regular consumer entries are outside the publication profile.');
  }
}

function parseTree(bytes: Buffer): Array<Omit<GitEvidenceFile, 'sha256'>> {
  const text = decode(bytes);
  if (text && !text.endsWith('\0')) invalid('Git returned incomplete tree evidence.');
  const records = text ? text.slice(0, -1).split('\0') : [];
  if (records.length > 2000) invalid('Git tree evidence exceeds the limit of 2000 entries.');
  const paths = new Set<string>();
  const files: Array<Omit<GitEvidenceFile, 'sha256'>> = [];
  for (const record of records) {
    const match = /^(100644|100755|120000|160000) (blob|commit) ([a-f0-9]{40})\t(.+)$/u.exec(record);
    if (!match) invalid('Git returned unsupported tree evidence.');
    const mode = match[1]!;
    const type = match[2]!;
    const gitBlobId = match[3]!;
    const path = match[4]!;
    if (mode === '120000' || mode === '160000' || type !== 'blob') invalid('Git symlinks and submodules are outside the publication profile.');
    if (/[\\\u0000-\u001f\u007f]/u.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) {
      invalid('Git tree paths are outside the supported local path profile.');
    }
    const key = process.platform === 'win32' ? path.toLowerCase() : path;
    if (paths.has(key)) invalid('Git tree contains ambiguous paths.');
    paths.add(key);
    if (isCapturedConsumerPath(path)) files.push({ path, gitBlobId, mode: mode as GitEvidenceFile['mode'] });
  }
  if (files.length > 500) invalid('Git capture exceeds the limit of 500 files.');
  return files.sort((a, b) => order(a.path, b.path));
}

function parseBlobs(bytes: Buffer, ids: readonly string[]): Map<string, string> {
  const hashes = new Map<string, string>();
  let offset = 0;
  let total = 0;
  for (const id of ids) {
    const newline = bytes.indexOf(10, offset);
    if (newline < 0 || newline - offset > 100) invalid('Git returned incomplete blob evidence.');
    const header = bytes.subarray(offset, newline).toString('ascii');
    const match = /^([a-f0-9]{40}) blob (0|[1-9]\d*)$/u.exec(header);
    if (!match || match[1] !== id) invalid('A required Git blob is unavailable locally.');
    const length = Number(match[2]);
    total += length;
    if (!Number.isSafeInteger(length) || length > 1024 * 1024 || total > 16 * 1024 * 1024) invalid('Git blobs exceed the consumer capture limits.');
    offset = newline + 1;
    if (offset + length >= bytes.length || bytes[offset + length] !== 10) invalid('Git returned incomplete blob evidence.');
    const blob = bytes.subarray(offset, offset + length);
    const objectId = createHash('sha1').update(`blob ${length}\0`).update(blob).digest('hex');
    if (objectId !== id) invalid('Git blob content does not match its object ID.');
    hashes.set(id, sha256(blob));
    offset += length + 1;
  }
  if (offset !== bytes.length) invalid('Git returned unexpected blob evidence.');
  return hashes;
}

function parseIndex(bytes: Buffer): Array<Omit<GitEvidenceFile, 'sha256'>> {
  const text = decode(bytes);
  if (text && !text.endsWith('\0')) invalid('Git returned incomplete index evidence.');
  const records = text ? text.slice(0, -1).split('\0') : [];
  if (records.length > 2000) invalid('Git index evidence exceeds the limit of 2000 entries.');
  const files: Array<Omit<GitEvidenceFile, 'sha256'>> = [];
  for (const record of records) {
    const match = /^(100644|100755|120000|160000) ([a-f0-9]{40}) ([0-3])\t(.+)$/u.exec(record);
    if (!match) invalid('Git returned unsupported index evidence.');
    const path = match[4]!;
    if (!isCapturedConsumerPath(path)) continue;
    if (match[3] !== '0' || (match[1] !== '100644' && match[1] !== '100755')) {
      invalid('Captured Git index entries must be regular files without merge conflicts.');
    }
    files.push({ path, gitBlobId: match[2]!, mode: match[1] });
  }
  return files.sort((a, b) => order(a.path, b.path));
}

/** Process seam for bounded local tests; not exported by the public package entry point. */
export function createGitEvidenceCapture(dependencies: Dependencies = {}): (options: GitEvidenceOptions) => Promise<GitEvidence> {
  const launch = dependencies.spawn ?? spawn;
  const timeoutMs = dependencies.timeoutMs ?? 30_000;
  const maximumOutputBytes = dependencies.maximumOutputBytes ?? MAX_OUTPUT;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000
    || !Number.isInteger(maximumOutputBytes) || maximumOutputBytes < 1 || maximumOutputBytes > MAX_OUTPUT) {
    invalid('Git inspection limits must be positive and bounded.');
  }
  return async options => {
    try {
      if (typeof options.gitPath !== 'string' || !isAbsolute(options.gitPath) || /[\u0000-\u001f\u007f]/u.test(options.gitPath)
        || /^[\\/]{2}/u.test(options.gitPath)) invalid('Provide an explicitly trusted absolute local Git executable.');
      if (options.expectedConsumerDigest !== undefined && !HASH.test(options.expectedConsumerDigest)) invalid('Expected consumer digest must be a SHA-256 value.');
      const executable = await lstat(options.gitPath);
      if (!executable.isFile() || executable.isSymbolicLink()) invalid('The trusted Git executable must be a regular local file.');
      const initial = await captureConsumer(options.consumerRoot);
      checkCapture(initial, options.expectedConsumerDigest);
      const root = await realpath(resolve(options.consumerRoot));
      const configBefore = await inspectRepository(root);
      const deadline = Date.now() + timeoutMs;
      let outputBytes = 0;
      const fixed = ['--no-pager', '--no-replace-objects', '--no-lazy-fetch', '--no-optional-locks',
        '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=', '-c', 'core.commitGraph=false',
        '-c', 'protocol.allow=never', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0'];
      const run = async (args: string[], maxBytes: number, input?: string): Promise<Buffer> => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) invalid('Git evidence inspection exceeded its time limit.');
        return new Promise<Buffer>((accept, reject) => {
          const chunks: Buffer[] = [];
          let length = 0;
          let failure: string | undefined;
          let settled = false;
          const child = launch(options.gitPath, [...fixed, ...args], {
            cwd: root, env: environment(options.gitPath), shell: false, windowsHide: true,
            stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
          });
          const finish = (error?: string): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error) reject(new PlumberError('INVALID_INPUT', error));
            else accept(Buffer.concat(chunks, length));
          };
          const fail = (message: string): void => {
            failure ??= message;
            child.kill('SIGKILL');
          };
          const timer = setTimeout(() => { fail('Git evidence inspection exceeded its time limit.'); finish(failure); }, remaining);
          const count = (chunk: Buffer): boolean => {
            outputBytes += chunk.length;
            if (outputBytes > maximumOutputBytes) { fail('Git evidence output exceeds its total limit.'); return false; }
            return failure === undefined;
          };
          child.stdout!.on('data', (chunk: Buffer) => {
            if (!count(chunk)) return;
            length += chunk.length;
            if (length > maxBytes) { fail('Git evidence output exceeds its command limit.'); return; }
            chunks.push(chunk);
          });
          child.stderr!.on('data', (chunk: Buffer) => { count(chunk); });
          child.once('error', () => finish('The trusted Git executable could not inspect local evidence.'));
          child.once('close', code => finish(failure ?? (code === 0 ? undefined : 'Git could not inspect the supported local repository profile.')));
          if (input !== undefined) {
            child.stdin!.on('error', () => { fail('Git rejected the local evidence request.'); });
            child.stdin!.end(input);
          }
        });
      };
      const text = async (args: string[]): Promise<string> => decode(await run(args, MAX_METADATA)).trimEnd();
      if (!/^git version \d+\.\d+/u.test(await text(['--version']))) invalid('Git did not confirm support for the required read-only options.');
      const configValues = decode(await run(['config', '--file', join(root, '.git/config'), '--no-includes', '--null', '--list'], MAX_METADATA));
      for (const record of configValues.split('\0').filter(Boolean)) {
        const separator = record.indexOf('\n');
        const key = (separator < 0 ? record : record.slice(0, separator)).toLowerCase();
        const value = separator < 0 ? '' : record.slice(separator + 1);
        if (key.startsWith('include.') || key.startsWith('includeif.') || key === 'core.worktree'
          || (key.startsWith('extensions.') && (key !== 'extensions.objectformat' || value !== 'sha1'))) {
          invalid('Git configuration is outside the supported local repository profile.');
        }
      }
      if (await text(['rev-parse', '--is-bare-repository']) !== 'false'
        || canonical(await realpath(await text(['rev-parse', '--show-toplevel']))) !== canonical(root)
        || await text(['rev-parse', '--show-object-format']) !== 'sha1') invalid('Use the exact root of a non-bare SHA-1 Git worktree.');
      const headSha = await text(['rev-parse', '--verify', 'HEAD^{commit}']);
      if (!OBJECT_ID.test(headSha)) invalid('Git HEAD is not an available SHA-1 commit.');
      const treeSha = await text(['rev-parse', '--verify', `${headSha}^{tree}`]);
      if (!OBJECT_ID.test(treeSha)) invalid('Git HEAD has no supported tree.');
      const entries = parseTree(await run(['ls-tree', '-r', '-z', '--full-tree', treeSha], MAX_TREE));
      const indexEntries = parseIndex(await run(['ls-files', '--stage', '-z', '--full-name'], MAX_TREE));
      if (JSON.stringify(indexEntries) !== JSON.stringify(entries)) {
        invalid('Captured Git index entries must match HEAD; review staged source or manifest changes.');
      }
      const captured = [...initial.files, ...initial.manifests].sort((a, b) => order(a.path, b.path));
      if (entries.length !== captured.length || entries.some((entry, index) => entry.path !== captured[index]?.path)) {
        invalid('Captured source and manifests must match HEAD in both directions; review added or deleted files.');
      }
      const ids = [...new Set(entries.map(entry => entry.gitBlobId))];
      const hashes = ids.length ? parseBlobs(await run(['cat-file', '--batch'], MAX_BLOBS, `${ids.join('\n')}\n`), ids) : new Map<string, string>();
      const files = entries.map((entry, index): GitEvidenceFile => {
        const hash = hashes.get(entry.gitBlobId);
        if (hash !== captured[index]!.sha256) invalid('Captured source must match raw HEAD blobs exactly; filters and line-ending normalization are not applied.');
        return Object.freeze({ ...entry, sha256: hash });
      });
      const final = await captureConsumer(root);
      checkCapture(final, initial.digest);
      if (JSON.stringify(final.skipped) !== JSON.stringify(initial.skipped)
        || !(await inspectRepository(root)).equals(configBefore)
        || JSON.stringify(parseIndex(await run(['ls-files', '--stage', '-z', '--full-name'], MAX_TREE))) !== JSON.stringify(indexEntries)
        || await text(['rev-parse', '--verify', 'HEAD^{commit}']) !== headSha) invalid('Git or consumer evidence changed during inspection.');
      if (Date.now() >= deadline) invalid('Git evidence inspection exceeded its time limit.');
      return Object.freeze({ schemaVersion: 1, headSha, treeSha, canonicalRootId: sha256(canonical(root)), consumerDigest: initial.digest, files: Object.freeze(files) });
    } catch (error) {
      if (error instanceof PlumberError) throw error;
      invalid('Could not inspect a complete local Git worktree without external configuration.');
    }
  };
}

/** Captures raw local HEAD evidence; it does not stage, commit, fetch, or publish. */
export const captureGitEvidence = createGitEvidenceCapture();
