import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import { dirname, join, parse, resolve, sep } from 'node:path';
import { PlumberError } from './errors.js';

const MAXIMUM_FILE_BYTES = 1024 * 1024;
const MAXIMUM_TOTAL_BYTES = 16 * 1024 * 1024;
const MAXIMUM_FILES = 500;
const MAXIMUM_ENTRIES = 2000;
const MAXIMUM_DEPTH = 20;
const EXCLUDED_DIRECTORIES = new Set([
  'node_modules', '.git', '.plumber', 'work', 'dist', 'build', 'coverage', 'vendor', '.next', '__pycache__',
]);
const SOURCE_EXTENSION = /\.(?:tsx?|jsx?|mts|cts|mjs|cjs|py|java)$/i;
const DECLARATION_EXTENSION = /\.d\.(?:ts|mts|cts)$/i;

export function isJavaScriptConsumerPath(path: string): boolean {
  return /\.(?:tsx?|jsx?|mts|cts|mjs|cjs)$/iu.test(path);
}

export function isConsumerTestPath(path: string): boolean {
  return /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:test|spec)\.[^.]+$/iu.test(path)
    || /(?:^|\/)test_[^/]+\.py$|(?:^|\/)[^/]+_test\.py$|(?:^|\/)[^/]*(?:Test|Tests)\.java$/u.test(path);
}

function capturedFilename(name: string): boolean {
  return !name.startsWith('.') && !DECLARATION_EXTENSION.test(name)
    && (name === 'package.json' || SOURCE_EXTENSION.test(name));
}

/** Shared inspection profile for regular Git tree paths; filesystem safety is checked separately. */
export function isCapturedConsumerPath(path: string): boolean {
  if (typeof path !== 'string' || /[\\\u0000]/u.test(path)) return false;
  const parts = path.split('/');
  if (parts.length - 1 > MAXIMUM_DEPTH || parts.some(part => !part || part === '.' || part === '..')) return false;
  return parts.slice(0, -1).every(part => !part.startsWith('.') && !EXCLUDED_DIRECTORIES.has(part.toLowerCase()))
    && capturedFilename(parts.at(-1)!);
}

export interface ConsumerFile {
  readonly path: string;
  readonly sha256: string;
  readonly text: string;
}

export interface SkippedConsumerEntry {
  readonly path: string;
  readonly reason: string;
}

export interface ConsumerCapture {
  readonly files: readonly ConsumerFile[];
  readonly manifests: readonly ConsumerFile[];
  readonly skipped: readonly SkippedConsumerEntry[];
  readonly digest: string;
}

interface Candidate {
  readonly absolutePath: string;
  readonly path: string;
  readonly manifest: boolean;
  readonly attributes: BigIntStats;
}

function invalid(message: string): never {
  throw new PlumberError('INVALID_INPUT', message);
}

function localRoot(rootPath: string): string {
  if (typeof rootPath !== 'string' || rootPath.trim().length === 0 || rootPath === '-' || rootPath.includes('\0')) {
    invalid('Provide a local consumer directory.');
  }
  if (/^[\\/]{2}/.test(rootPath)) invalid('UNC, device, and pipe paths are not supported.');
  const withoutDrive = process.platform === 'win32' && /^[a-z]:[\\/]/i.test(rootPath)
    ? rootPath.slice(2)
    : rootPath;
  if (withoutDrive.includes(':')) invalid('URLs, Git references, drive-relative paths, and alternate data streams are not supported.');
  if (/(?:^|[\\/])(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:[. ]|$)/i.test(rootPath)) {
    invalid('Windows device names are not supported.');
  }
  return resolve(rootPath);
}

async function checkDirectoryPath(absolutePath: string): Promise<void> {
  const root = parse(absolutePath).root;
  let current = root;
  for (const segment of ['', ...absolutePath.slice(root.length).split(sep).filter(Boolean)]) {
    if (segment) current = join(current, segment);
    const attributes = await lstat(current, { bigint: true });
    if (attributes.isSymbolicLink()) invalid('Consumer roots and their ancestors must not be symbolic links or junctions.');
    if (!attributes.isDirectory()) invalid('The consumer root and its ancestors must be local directories.');
  }
}

function unchanged(before: BigIntStats, after: BigIntStats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size
    && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
}

function order(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function readCandidate(candidate: Candidate, remainingBytes: number): Promise<Buffer> {
  await checkDirectoryPath(dirname(candidate.absolutePath));
  const current = await lstat(candidate.absolutePath, { bigint: true });
  if (!current.isFile() || current.isSymbolicLink() || !unchanged(candidate.attributes, current)) {
    invalid('A consumer file changed during capture; retry with a stable directory.');
  }
  // O_NONBLOCK prevents a concurrently substituted FIFO from blocking open on Unix.
  const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const handle = await open(candidate.absolutePath, flags);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || !unchanged(current, before)) {
      invalid('A consumer file changed during capture; retry with a stable directory.');
    }
    if (before.size > BigInt(MAXIMUM_FILE_BYTES)) invalid('A consumer file exceeds the 1 MiB limit.');
    if (before.size > BigInt(remainingBytes)) invalid('Consumer files exceed the total 16 MiB limit.');

    const chunks: Buffer[] = [];
    let length = 0;
    const limit = Math.min(MAXIMUM_FILE_BYTES, remainingBytes);
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, limit + 1 - length));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
      if (length > MAXIMUM_FILE_BYTES) invalid('A consumer file exceeds the 1 MiB limit.');
      if (length > remainingBytes) invalid('Consumer files exceed the total 16 MiB limit.');
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = await handle.stat({ bigint: true });
    await checkDirectoryPath(dirname(candidate.absolutePath));
    const finalPath = await lstat(candidate.absolutePath, { bigint: true });
    if (!unchanged(before, after) || !finalPath.isFile() || finalPath.isSymbolicLink() || !unchanged(after, finalPath)) {
      invalid('A consumer file changed during capture; retry with a stable directory.');
    }
    return Buffer.concat(chunks, length);
  } finally {
    await handle.close();
  }
}

export async function captureConsumer(rootPath: string): Promise<ConsumerCapture> {
  const root = localRoot(rootPath);
  try {
    await checkDirectoryPath(root);
    const candidates: Candidate[] = [];
    const skipped: SkippedConsumerEntry[] = [];
    let entryCount = 0;

    async function visit(absolutePath: string, relativePath: string, depth: number): Promise<void> {
      if (depth > MAXIMUM_DEPTH) invalid('Consumer directory depth exceeds the limit of 20.');
      await checkDirectoryPath(absolutePath);
      const before = await lstat(absolutePath, { bigint: true });
      const directory = await opendir(absolutePath);
      const names: string[] = [];
      for await (const entry of directory) {
        entryCount += 1;
        if (entryCount > MAXIMUM_ENTRIES) invalid('Consumer directory entries exceed the limit of 2000.');
        names.push(entry.name);
      }
      const after = await lstat(absolutePath, { bigint: true });
      if (!after.isDirectory() || after.isSymbolicLink() || !unchanged(before, after)) {
        invalid('A consumer directory changed during capture; retry with a stable directory.');
      }

      for (const name of names.sort(order)) {
        const path = relativePath ? `${relativePath}/${name}` : name;
        const absoluteEntry = join(absolutePath, name);
        const attributes = await lstat(absoluteEntry, { bigint: true });
        let reason: string | undefined;
        if (attributes.isSymbolicLink()) reason = 'symbolic-link';
        else if (attributes.isDirectory()) {
          if (EXCLUDED_DIRECTORIES.has(name.toLowerCase())) reason = 'excluded-directory';
          else if (name.startsWith('.')) reason = 'hidden-directory';
          else {
            await visit(absoluteEntry, path, depth + 1);
            continue;
          }
        } else if (!attributes.isFile()) reason = 'non-regular-file';
        else if (name.startsWith('.')) reason = 'hidden-file';
        else if (DECLARATION_EXTENSION.test(name)) reason = 'declaration-file';
        else if (!capturedFilename(name)) reason = 'unsupported-extension';
        else {
          if (candidates.length >= MAXIMUM_FILES) invalid('Consumer source and manifest files exceed the limit of 500.');
          candidates.push({ absolutePath: absoluteEntry, path, manifest: name === 'package.json', attributes });
          continue;
        }
        skipped.push(Object.freeze({ path, reason }));
      }
    }

    await visit(root, '', 0);
    const files: ConsumerFile[] = [];
    const manifests: ConsumerFile[] = [];
    let totalBytes = 0;
    for (const candidate of candidates.sort((left, right) => order(left.path, right.path))) {
      const bytes = await readCandidate(candidate, MAXIMUM_TOTAL_BYTES - totalBytes);
      totalBytes += bytes.length;
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch {
        invalid('Consumer source and manifest files must be valid UTF-8.');
      }
      const captured = Object.freeze({ path: candidate.path, sha256: createHash('sha256').update(bytes).digest('hex'), text });
      (candidate.manifest ? manifests : files).push(captured);
    }
    const manifest = [...files, ...manifests]
      .sort((left, right) => order(left.path, right.path))
      .map(({ path, sha256 }) => [path, sha256]);
    return Object.freeze({
      files: Object.freeze(files),
      manifests: Object.freeze(manifests),
      skipped: Object.freeze(skipped.sort((left, right) => order(left.path, right.path))),
      digest: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    });
  } catch (error) {
    if (error instanceof PlumberError) throw error;
    invalid('Could not capture the consumer directory as regular local files.');
  }
}
