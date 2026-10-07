import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join, parse, resolve, sep } from 'node:path';
import type { LocalSnapshot } from './contracts.js';
import { PlumberError } from './errors.js';

const MAXIMUM_BYTES = 4 * 1024 * 1024;
const MAXIMUM_DEPTH = 128;
const OPENAPI_DIALECT = 'https://spec.openapis.org/oas/3.1/dialect/base';
const SCHEMA_MAPS = new Set([
  'properties', 'patternProperties', '$defs', 'definitions', 'schemas',
  'parameters', 'responses', 'requestBodies', 'headers', 'examples', 'links',
  'callbacks', 'securitySchemes', 'pathItems',
]);
const LITERAL_VALUES = new Set(['example', 'default', 'const', 'enum', 'value']);

function invalid(message: string): never {
  throw new PlumberError('INVALID_INPUT', message);
}

function unsupported(message: string): never {
  throw new PlumberError('UNSUPPORTED_CONTRACT', message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function localPath(filePath: string): string {
  if (typeof filePath !== 'string' || filePath.trim().length === 0 || filePath === '-' || filePath.includes('\0')) {
    invalid('Provide a local JSON file path; stdin is not supported.');
  }
  if (/^[\\/]{2}/.test(filePath)) {
    invalid('UNC, device, and pipe paths are not supported.');
  }
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

async function readLocalFile(filePath: string): Promise<Buffer> {
  const absolutePath = localPath(filePath);
  try {
    const root = parse(absolutePath).root;
    const segments = absolutePath.slice(root.length).split(sep).filter(Boolean);
    let current = root;
    for (let index = 0; index < segments.length; index += 1) {
      current = join(current, segments[index]!);
      const attributes = await lstat(current);
      if (attributes.isSymbolicLink()) {
        invalid('Symbolic links and directory junctions are not supported.');
      }
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
      if (attributes.size > MAXIMUM_BYTES) invalid('OpenAPI input exceeds the 4 MiB limit.');

      const chunks: Buffer[] = [];
      let length = 0;
      for (;;) {
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAXIMUM_BYTES + 1 - length));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
        if (length > MAXIMUM_BYTES) invalid('OpenAPI input exceeds the 4 MiB limit.');
        chunks.push(chunk.subarray(0, bytesRead));
      }
      return Buffer.concat(chunks, length);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof PlumberError) throw error;
    invalid('Could not read the input as a regular local JSON file.');
  }
}

function checkDepth(json: string): void {
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
      if (depth > MAXIMUM_DEPTH) invalid('OpenAPI input exceeds the nesting limit of 128.');
    } else if (character === '}' || character === ']') {
      depth -= 1;
    }
  }
}

function checkReferences(value: unknown, isMap = false): void {
  if (Array.isArray(value)) {
    for (const item of value) checkReferences(item);
    return;
  }
  if (!isObject(value)) return;

  if (!isMap) {
    for (const keyword of ['$dynamicRef', '$dynamicAnchor', '$id']) {
      if (Object.hasOwn(value, keyword)) {
        unsupported(`${keyword} is outside the supported local OpenAPI profile.`);
      }
    }
    if (Object.hasOwn(value, '$schema')) {
      if (typeof value.$schema !== 'string') invalid('$schema must be a string.');
      if (value.$schema !== OPENAPI_DIALECT && value.$schema !== 'https://json-schema.org/draft/2020-12/schema') {
        unsupported('Custom JSON Schema dialects are not supported.');
      }
    }
    for (const keyword of ['$ref', 'operationRef']) {
      if (!Object.hasOwn(value, keyword)) continue;
      const reference = value[keyword];
      if (typeof reference !== 'string') invalid(`${keyword} must be a string.`);
      if (!reference.startsWith('#')) {
        unsupported('Only references within the same document are supported.');
      }
    }
  }

  for (const [key, child] of Object.entries(value)) {
    // Literal examples and schema property names are data, not reference directives.
    if (!isMap && (LITERAL_VALUES.has(key) || (key === 'examples' && Array.isArray(child)))) continue;
    checkReferences(child, !isMap && SCHEMA_MAPS.has(key) && isObject(child));
  }
}

export async function loadOpenApi(filePath: string): Promise<LocalSnapshot> {
  const bytes = await readLocalFile(filePath);
  let json: string;
  try {
    json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    invalid('OpenAPI input must be valid UTF-8.');
  }
  checkDepth(json);

  let document: unknown;
  try {
    document = JSON.parse(json) as unknown;
  } catch {
    invalid('OpenAPI input must be valid JSON.');
  }
  if (!isObject(document)) invalid('OpenAPI input must be a JSON object.');
  if (!Object.hasOwn(document, 'openapi') && Object.hasOwn(document, 'swagger')) {
    unsupported('Swagger documents are not supported; use OpenAPI 3.0 or 3.1.');
  }
  if (typeof document.openapi !== 'string' || !/^\d+\.\d+\.\d+$/.test(document.openapi)) {
    invalid('OpenAPI input must declare a specification version.');
  }
  if (!/^3\.[01]\.\d+$/.test(document.openapi)) {
    unsupported('Only OpenAPI 3.0.x and 3.1.x are supported.');
  }
  if (!isObject(document.info) || typeof document.info.title !== 'string' || typeof document.info.version !== 'string') {
    invalid('OpenAPI input must include info.title and info.version strings.');
  }
  if (!isObject(document.paths)) invalid('OpenAPI input must include a paths object.');
  if (Object.hasOwn(document, 'webhooks')) unsupported('Root webhooks are outside the supported local OpenAPI profile.');
  if (isObject(document.components) && Object.hasOwn(document.components, 'pathItems')) {
    unsupported('Reusable component path items are outside the supported local OpenAPI profile.');
  }
  if (Object.hasOwn(document, 'jsonSchemaDialect') && document.jsonSchemaDialect !== OPENAPI_DIALECT) {
    unsupported('Custom JSON Schema dialects are not supported.');
  }
  checkReferences(document);

  return Object.freeze({
    metadata: Object.freeze({
      sha256: createHash('sha256').update(bytes).digest('hex'),
      byteLength: bytes.length,
      specificationVersion: document.openapi,
      apiVersion: document.info.version,
    }),
    json,
  });
}
