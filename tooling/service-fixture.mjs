import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { registerSourceSubscription } from '../dist/index.js';

/** Creates only a caller-owned test fixture; never installs a service or changes ACLs. */
export async function createServiceFixture(directory) {
  if (!isAbsolute(directory)) throw new Error('A service fixture requires an absolute owned directory.');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const statePath = join(directory, 'state');
  const baselinePath = join(directory, 'baseline.json');
  const sourcePath = join(directory, 'source.json');
  const configPath = join(directory, 'worker.json');
  const schema = JSON.stringify({ type: 'object', properties: { id: { type: 'string' } }, required: ['id'] });
  await writeFile(baselinePath, schema, { flag: 'wx', mode: 0o600 });
  await writeFile(sourcePath, schema, { flag: 'wx', mode: 0o600 });
  const subscription = await registerSourceSubscription({ statePath, sourcePath, baselinePath, kind: 'json-schema', direction: 'input', label: 'Fictional service lifecycle fixture' });
  await writeFile(configPath, JSON.stringify({ schemaVersion: 1, statePath, sources: { intervalMs: 1000 }, allowHttp: false }), { flag: 'wx', mode: 0o600 });
  return { configPath, statePath, subscriptionId: subscription.id, sourcePath };
}
