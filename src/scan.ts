import { captureConsumer, type ConsumerCapture } from './consumer-files.js';
import { createHash } from 'node:crypto';
import type { ConsumerInventory } from './consumer-contracts.js';
import { inspectSource } from './inspect-source.js';
import { PlumberError } from './errors.js';

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Reads source and package metadata. Does not resolve imports or run project tools. */
export async function scanConsumer(rootPath: string): Promise<ConsumerInventory> {
  return scanCapturedConsumer(await captureConsumer(rootPath));
}

/** Analyzes captured strings without resolving imports or reading the live consumer. */
export function scanCapturedConsumer(captured: ConsumerCapture): ConsumerInventory {
  const inspections = captured.files.map(inspectSource);
  const packages: ConsumerInventory['packages'][number][] = [];
  const validationCandidates: ConsumerInventory['validationCandidates'][number][] = [];
  for (const manifest of captured.manifests) {
    let data: unknown;
    try { data = JSON.parse(manifest.text); }
    catch { throw new PlumberError('INVALID_INPUT', 'A captured package manifest is not valid JSON.'); }
    if (!object(data)) throw new PlumberError('INVALID_INPUT', 'A captured package manifest must be an object.');
    const dependencies: ConsumerInventory['packages'][number]['dependencies'][number][] = [];
    for (const [key, kind] of [
      ['dependencies', 'runtime'], ['devDependencies', 'development'],
      ['optionalDependencies', 'optional'], ['peerDependencies', 'peer'],
    ] as const) {
      const group = data[key];
      if (group === undefined) continue;
      if (!object(group)) throw new PlumberError('INVALID_INPUT', 'Package dependency declarations must be objects.');
      for (const name of Object.keys(group).sort()) {
        const range = group[name];
        if (typeof range !== 'string') throw new PlumberError('INVALID_INPUT', 'Package dependency ranges must be strings.');
        // Git/URL/file specifiers can embed credentials or private filesystem paths.
        const safeRange = /^(?:[\dvVxX*~^<>=|.+\s-]+|latest|next|beta|alpha|canary)$/u.test(range) ? range : null;
        dependencies.push({ name, range: safeRange, kind });
      }
    }
    packages.push({ manifest: manifest.path, dependencies });
    if (data.scripts !== undefined) {
      if (!object(data.scripts)) throw new PlumberError('INVALID_INPUT', 'Package scripts must be an object.');
      for (const script of Object.keys(data.scripts).sort()) {
        const command = data.scripts[script];
        if (typeof command !== 'string') throw new PlumberError('INVALID_INPUT', 'Package scripts must be strings.');
        if (/^(?:test|lint|typecheck|check|build)(?::[a-zA-Z0-9_-]+)*$/u.test(script)) {
          validationCandidates.push({ manifest: manifest.path, script, commandSha256: createHash('sha256').update(command).digest('hex'), execution: 'not-authorized' });
        }
      }
    }
  }
  return {
    schemaVersion: 1,
    digest: captured.digest,
    files: [...captured.files, ...captured.manifests].map(({ path, sha256 }) => ({ path, sha256 }))
      .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
    calls: inspections.flatMap(item => item.calls),
    imports: inspections.flatMap(item => item.imports),
    issues: inspections.flatMap(item => item.issues),
    skipped: captured.skipped,
    packages,
    validationCandidates,
    coverage: 'bounded-native-fetch-syntax',
    codeExecuted: false,
  };
}
