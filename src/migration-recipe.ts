import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import { isProxy } from 'node:util/types';
import { parse, type ParserPlugin } from '@babel/parser';
import { PlumberError } from './errors.js';

export interface MigrationRecipe {
  readonly schemaVersion: 1;
  readonly summary: string;
  readonly decisions: readonly {
    readonly id: string;
    readonly question: string;
    readonly answer?: string;
  }[];
  readonly files: readonly {
    readonly path: string;
    readonly sha256: string;
    readonly edits: readonly { readonly before: string; readonly after: string }[];
  }[];
}

export interface CapturedMigrationFile {
  readonly path: string;
  readonly sha256: string;
  readonly text: string;
}

export interface RecipePreview {
  readonly summary: string;
  readonly decisions: MigrationRecipe['decisions'];
  readonly status: 'ready-for-review' | 'requires-decision';
  readonly recipeSha256: string;
  readonly requirements: readonly { readonly id: string; readonly question: string }[];
  readonly files: readonly {
    readonly path: string;
    readonly beforeSha256: string;
    readonly afterSha256: string;
    readonly before: string;
    readonly after: string;
  }[];
}

const MAX_RECIPE_BYTES = 1024 * 1024;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);
const SHA256 = /^[a-f0-9]{64}$/u;

function invalid(message: string): never {
  throw new PlumberError('INVALID_INPUT', message);
}

function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || isProxy(value) || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    invalid('Recipe objects must contain plain JSON data.');
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || ![...required, ...optional].includes(key)) ||
    required.some(key => !Object.hasOwn(value, key)) ||
    keys.some(key => !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))) {
    invalid('A recipe object contains missing, unknown, or executable fields.');
  }
  return value as Record<string, unknown>;
}

function dataArray(value: unknown, maximum: number): unknown[] {
  if (value === null || typeof value !== 'object' || isProxy(value) || !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) {
    invalid('Recipe collections must be bounded JSON arrays.');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) {
    invalid('Recipe arrays cannot contain holes, methods, or extra properties.');
  }
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      invalid('Recipe arrays must contain dense data elements, not accessors.');
    }
    result.push(descriptor.value);
  }
  return result;
}

function sourcePath(path: string): void {
  if (!path || path.startsWith('/') || /[\\:\u0000-\u001f\u007f]/u.test(path) ||
    path.split('/').some(segment => segment === '' || segment === '.' || segment === '..') ||
    !SOURCE_EXTENSIONS.has(extname(path).toLowerCase())) {
    invalid('Recipe paths must be relative POSIX paths to supported JavaScript or TypeScript source files.');
  }
}

function normalizeRecipe(input: unknown): MigrationRecipe {
  const recipe = record(input, ['schemaVersion', 'summary', 'decisions', 'files']);
  let textBytes = 0;
  const text = (value: unknown): string => {
    if (typeof value !== 'string') invalid('Recipe text fields must be strings.');
    textBytes += Buffer.byteLength(value, 'utf8');
    if (textBytes > MAX_RECIPE_BYTES) invalid('Recipe exceeds the 1 MiB limit.');
    return value;
  };
  if (recipe.schemaVersion !== 1) invalid('Only migration recipe schema version 1 is supported.');
  const summary = text(recipe.summary);
  if (!summary.trim()) invalid('A recipe summary is required.');
  const inputDecisions = dataArray(recipe.decisions, 100);
  const decisionIds = new Set<string>();
  const decisions = inputDecisions.map((value): MigrationRecipe['decisions'][number] => {
    const decision = record(value, ['id', 'question'], ['answer']);
    const id = text(decision.id);
    const question = text(decision.question);
    if (!id.trim() || !question.trim() || decisionIds.has(id)) {
      invalid('Decisions require unique nonempty identifiers and nonempty questions.');
    }
    decisionIds.add(id);
    return {
      id,
      question,
      ...(Object.hasOwn(decision, 'answer') ? { answer: text(decision.answer) } : {}),
    };
  });
  const inputFiles = dataArray(recipe.files, 50);
  if (inputFiles.length === 0) {
    invalid('A recipe must change between 1 and 50 source files.');
  }
  let editCount = 0;
  const paths = new Set<string>();
  const files = inputFiles.map((value): MigrationRecipe['files'][number] => {
    const file = record(value, ['path', 'sha256', 'edits']);
    const path = text(file.path);
    const sha256 = text(file.sha256);
    sourcePath(path);
    if (paths.has(path)) invalid('A recipe cannot contain duplicate file paths.');
    paths.add(path);
    if (!SHA256.test(sha256)) invalid('Expected file hashes must be lowercase SHA-256 values.');
    const inputEdits = dataArray(file.edits, 100);
    if (inputEdits.length === 0 || (editCount += inputEdits.length) > 100) {
      invalid('A recipe requires at least one edit per file and at most 100 edits in total.');
    }
    const beforeTexts = new Set<string>();
    const edits = inputEdits.map((value): MigrationRecipe['files'][number]['edits'][number] => {
      const edit = record(value, ['before', 'after']);
      const before = text(edit.before);
      const after = text(edit.after);
      if (!before || before === after || beforeTexts.has(before)) {
        invalid('Edits require unique nonempty before text and a different replacement.');
      }
      beforeTexts.add(before);
      return { before, after };
    });
    return { path, sha256, edits };
  });
  return { schemaVersion: 1, summary, decisions, files };
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Persist validated data, never caller-provided accessors or serialization hooks. */
export function serializeMigrationRecipe(input: unknown): string {
  const json = JSON.stringify(normalizeRecipe(input));
  if (Buffer.byteLength(json, 'utf8') > MAX_RECIPE_BYTES) invalid('Recipe exceeds the 1 MiB limit.');
  return json;
}

function checkSyntax(text: string, path: string): void {
  const extension = extname(path).toLowerCase();
  const plugins: ParserPlugin[] = [];
  if (['.ts', '.tsx', '.mts', '.cts'].includes(extension)) plugins.push('typescript');
  if (['.jsx', '.tsx'].includes(extension)) plugins.push('jsx');
  try {
    parse(text, {
      sourceType: ['.cjs', '.cts'].includes(extension) ? 'commonjs' : ['.mjs', '.mts'].includes(extension) ? 'module' : 'unambiguous',
      plugins, errorRecovery: false, attachComment: false, tokens: false,
    });
  } catch {
    invalid('The proposed source cannot be parsed with the supported syntax profile.');
  }
}

export function previewRecipe(recipe: unknown, capturedFiles: readonly CapturedMigrationFile[]): RecipePreview {
  const normalized = normalizeRecipe(recipe);
  const canonical = JSON.stringify(normalized);
  if (Buffer.byteLength(canonical, 'utf8') > MAX_RECIPE_BYTES) invalid('Recipe exceeds the 1 MiB limit.');
  const captured = new Map<string, CapturedMigrationFile>();
  for (const value of dataArray(capturedFiles, 500)) {
    const file = record(value, ['path', 'sha256', 'text']);
    if (typeof file.path !== 'string' || typeof file.sha256 !== 'string' || typeof file.text !== 'string' || captured.has(file.path)) {
      invalid('Captured files must have unique paths.');
    }
    captured.set(file.path, { path: file.path, sha256: file.sha256, text: file.text });
  }
  const files = normalized.files.map((file): RecipePreview['files'][number] => {
    const source = captured.get(file.path);
    if (!source || typeof source.text !== 'string' || typeof source.sha256 !== 'string') {
      invalid('Each recipe file must exist in the captured source files.');
    }
    if (Buffer.byteLength(source.text, 'utf8') > MAX_SOURCE_BYTES) invalid('Source exceeds the 2 MiB limit.');
    if (source.sha256 !== file.sha256 || sha256(source.text) !== source.sha256) {
      invalid('The recipe does not match the captured source content.');
    }
    const positions = file.edits.map(edit => {
      const start = source.text.indexOf(edit.before);
      if (start < 0 || source.text.indexOf(edit.before, start + 1) !== -1) {
        invalid('Every before text must occur exactly once in the original source.');
      }
      return { start, end: start + edit.before.length, after: edit.after };
    }).sort((left, right) => left.start - right.start);
    const pieces: string[] = [];
    let cursor = 0;
    for (const edit of positions) {
      if (edit.start < cursor) invalid('Recipe edits cannot overlap in the original source.');
      pieces.push(source.text.slice(cursor, edit.start), edit.after);
      cursor = edit.end;
    }
    pieces.push(source.text.slice(cursor));
    const after = pieces.join('');
    if (Buffer.byteLength(after, 'utf8') > MAX_SOURCE_BYTES) invalid('Proposed source exceeds the 2 MiB limit.');
    if (after === source.text) invalid('The combined edits must change the original source.');
    checkSyntax(after, file.path);
    return {
      path: file.path,
      beforeSha256: source.sha256,
      afterSha256: sha256(after),
      before: source.text,
      after,
    };
  });
  const requirements = normalized.decisions
    .filter(decision => !decision.answer?.trim())
    .map(decision => ({ id: decision.id, question: decision.question }));
  return {
    summary: normalized.summary,
    decisions: normalized.decisions,
    status: requirements.length > 0 ? 'requires-decision' : 'ready-for-review',
    recipeSha256: sha256(canonical),
    requirements,
    files: requirements.length > 0 ? [] : files,
  };
}
