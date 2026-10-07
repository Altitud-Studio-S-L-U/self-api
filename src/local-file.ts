import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join, parse, resolve, sep } from 'node:path';
import { PlumberError } from './errors.js';

const MAXIMUM_ALLOWED_BYTES = 4 * 1024 * 1024;
const MAXIMUM_JSON_DEPTH = 128;

function invalid(message: string): never {
  throw new PlumberError('INVALID_INPUT', message);
}

function localPath(filePath: string): string {
  if (typeof filePath !== 'string' || filePath.trim().length === 0 || filePath === '-' || filePath.includes('\0')) {
    invalid('Provide a local file path; stdin is not supported.');
  }
  if (/^[\\/]{2}/.test(filePath)) invalid('UNC, device, and pipe paths are not supported.');
  const withoutDrive = process.platform === 'win32' && /^[a-z]:[\\/]/i.test(filePath)
    ? filePath.slice(2)
    : filePath;
  if (withoutDrive.includes(':')) {
    invalid('URLs, Git references, drive-relative paths, and alternate data streams are not supported.');
  }
  if (/(?:^|[\\/])(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:[. ]|$)/i.test(filePath)) {
    invalid('Windows device names are not supported.');
  }
  return resolve(filePath);
}

export async function readLocalBytes(filePath: string, maxBytes: number): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAXIMUM_ALLOWED_BYTES) {
    invalid('The local file byte limit must be a positive integer no greater than 4 MiB.');
  }
  const absolutePath = localPath(filePath);
  try {
    const root = parse(absolutePath).root;
    const rootAttributes = await lstat(root);
    if (rootAttributes.isSymbolicLink() || !rootAttributes.isDirectory()) {
      invalid('The local filesystem root must be a directory without symbolic links.');
    }
    const segments = absolutePath.slice(root.length).split(sep).filter(Boolean);
    if (segments.length === 0) invalid('The input must be a regular local file.');
    let current = root;
    for (let index = 0; index < segments.length; index += 1) {
      current = join(current, segments[index]!);
      const attributes = await lstat(current);
      if (attributes.isSymbolicLink()) invalid('Symbolic links and directory junctions are not supported.');
      const isLast = index === segments.length - 1;
      if (isLast ? !attributes.isFile() : !attributes.isDirectory()) {
        invalid('The input must be a regular local file.');
      }
    }

    // A replacement FIFO must not block open; these flags are not portable to Windows.
    const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const handle = await open(absolutePath, flags);
    try {
      const attributes = await handle.stat();
      if (!attributes.isFile()) invalid('The input must be a regular local file.');
      if (attributes.size > maxBytes) invalid('The local file exceeds its configured byte limit.');

      const chunks: Buffer[] = [];
      let length = 0;
      for (;;) {
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - length));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
        if (length > maxBytes) invalid('The local file exceeds its configured byte limit.');
        chunks.push(chunk.subarray(0, bytesRead));
      }
      return Buffer.concat(chunks, length);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof PlumberError) throw error;
    invalid('Could not read the input as a regular local file.');
  }
}

function checkJsonDepth(json: string): void {
  let depth = 0;
  let inString = false;
  for (let index = 0; index < json.length; index += 1) {
    const character = json[index];
    if (inString) {
      if (character === '\\') index += 1;
      else if (character === '"') inString = false;
    } else if (character === '"') {
      inString = true;
    } else if (character === '{' || character === '[') {
      depth += 1;
      if (depth > MAXIMUM_JSON_DEPTH) invalid('JSON input exceeds the nesting limit of 128.');
    } else if (character === '}' || character === ']') {
      depth -= 1;
    }
  }
}

export async function loadLocalJson(filePath: string, maxBytes: number): Promise<unknown> {
  const bytes = await readLocalBytes(filePath, maxBytes);
  let json: string;
  try {
    json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    invalid('JSON input must be valid UTF-8.');
  }
  checkJsonDepth(json);
  try {
    return JSON.parse(json) as unknown;
  } catch {
    invalid('JSON input must be valid JSON.');
  }
}
