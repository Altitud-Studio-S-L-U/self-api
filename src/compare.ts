import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import type { ApiChange, ComparisonReport } from './contracts.js';
import { PlumberError } from './errors.js';
import { loadOpenApi } from './openapi.js';
import release from './oasdiff-release.json' with { type: 'json' };

const execute = promisify(execFile);
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export interface CompareOptions {
  readonly basePath: string;
  readonly revisionPath: string;
  /** An explicitly authorized local executable. Never downloaded by this call. */
  readonly enginePath: string;
}

function engineEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  // Do not inherit provider secrets, OASDIFF_CONFIG, or user configuration paths.
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return environment;
}

async function runEngine(enginePath: string, args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execute(enginePath, args, {
      cwd,
      env: engineEnvironment(),
      shell: false,
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: MAX_OUTPUT_BYTES,
      encoding: 'utf8',
    });
    return stdout;
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (args[0] === 'validate' && code === 1) {
      throw new PlumberError('INVALID_INPUT', 'OpenAPI validation failed. No comparison was produced.');
    }
    // Engine stderr can contain private schema values, paths, and configuration.
    throw new PlumberError('ENGINE_FAILED', 'The comparison engine failed, timed out, or exceeded its output limit.');
  }
}

function parseArray(output: string): unknown[] {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new PlumberError('ENGINE_FAILED', 'The comparison engine returned invalid JSON.');
  }
  if (!Array.isArray(value)) {
    throw new PlumberError('ENGINE_FAILED', 'The comparison engine returned an unexpected report.');
  }
  return value as unknown[];
}

function parseChanges(output: string): ApiChange[] {
  const changes = parseArray(output).map((value): ApiChange => {
    if (
      value === null || typeof value !== 'object' ||
      !('id' in value) || typeof value.id !== 'string' ||
      !('text' in value) || typeof value.text !== 'string' ||
      !('level' in value) || (value.level !== 2 && value.level !== 3) ||
      ('operation' in value && typeof value.operation !== 'string') ||
      ('path' in value && typeof value.path !== 'string')
    ) {
      throw new PlumberError('ENGINE_FAILED', 'The comparison engine returned an unsupported finding.');
    }
    return {
      id: value.id,
      text: value.text,
      level: value.level === 3 ? 'error' : 'warning',
      ...('operation' in value ? { operation: value.operation as string } : {}),
      ...('path' in value ? { path: value.path as string } : {}),
    };
  });
  // Engine traversal order is not evidence: consent must bind the same findings identically on every review.
  return changes.sort((left, right) => {
    const a = JSON.stringify(left), b = JSON.stringify(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

export async function compareOpenApi(options: CompareOptions): Promise<ComparisonReport> {
  const [base, revision] = await Promise.all([
    loadOpenApi(options.basePath),
    loadOpenApi(options.revisionPath),
  ]);
  if (!options.enginePath || /^\\\\|^\/\/|^[a-z][a-z\d+.-]*:\/\//i.test(options.enginePath)) {
    throw new PlumberError('ENGINE_UNAVAILABLE', 'Choose an authorized local oasdiff executable.');
  }
  const enginePath = resolve(options.enginePath);
  try {
    if (!(await stat(enginePath)).isFile()) throw new Error('Not a regular file');
  } catch {
    throw new PlumberError('ENGINE_UNAVAILABLE', 'The configured oasdiff executable is not a regular local file.');
  }

  const temporaryRoot = resolve(tmpdir());
  const directory = await mkdtemp(join(temporaryRoot, 'plumber-'));
  try {
    const version = await runEngine(enginePath, ['--version'], directory);
    if (version.trim() !== `oasdiff version ${release.version}`) {
      throw new PlumberError('ENGINE_UNAVAILABLE', `This build requires oasdiff ${release.version}.`);
    }

    // Compare the captured bytes, never mutable source paths or repository config.
    const baseFile = join(directory, 'base.json');
    const revisionFile = join(directory, 'revision.json');
    const configFile = join(directory, 'config.json');
    await Promise.all([
      writeFile(baseFile, base.json, { mode: 0o600 }),
      writeFile(revisionFile, revision.json, { mode: 0o600 }),
      writeFile(configFile, '{}', { mode: 0o600 }),
    ]);
    const flags = ['--format', 'json', '--allow-external-refs=false', '--config', configFile];
    for (const file of [baseFile, revisionFile]) {
      const validation = parseArray(await runEngine(enginePath, ['validate', ...flags, '--', file], directory));
      if (validation.length > 0) {
        throw new PlumberError('INVALID_INPUT', 'The contract requires validation review. No comparison was produced.');
      }
    }
    const changes = parseChanges(await runEngine(enginePath, ['breaking', ...flags, '--', baseFile, revisionFile], directory));
    return {
      schemaVersion: 1,
      engine: { name: 'oasdiff', version: release.version },
      base: base.metadata,
      revision: revision.metadata,
      contentChanged: base.metadata.sha256 !== revision.metadata.sha256,
      status: changes.length > 0 ? 'breaking-changes' : 'no-breaking-changes',
      changes,
      coverage: 'structural-contract-only',
      consumerImpact: 'not-analyzed',
    };
  } finally {
    const ownedPath = relative(temporaryRoot, directory);
    if (isAbsolute(ownedPath) || ownedPath.includes('..') || !ownedPath.startsWith('plumber-') || ownedPath.includes('/') || ownedPath.includes('\\')) {
      throw new Error('Refusing to remove a temporary path outside the owned workspace');
    }
    await rm(directory, { recursive: true, force: true });
  }
}
