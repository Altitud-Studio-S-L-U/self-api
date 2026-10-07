import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const repositoryRoot = resolve(import.meta.dirname, '../..');
export const fixtureRoot = join(repositoryRoot, 'fixtures/payments');
export const developmentRoot = join(repositoryRoot, 'work/local-dev');
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const pathsFor = root => ({ root, provider: join(root, 'provider'), consumer: join(root, 'consumer'), state: join(root, 'state') });

async function createMissing(path, bytes) {
  try { await writeFile(path, bytes, { flag: 'wx', mode: 0o644 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}

export async function seedDevelopment(root = developmentRoot) {
  const paths = pathsFor(resolve(root));
  await mkdir(paths.root, { recursive: true });
  const markerPath = join(paths.root, 'environment.json');
  const expected = { schemaVersion: 1, kind: 'plumber-fictional-local-development', platform: process.platform, root: paths.root };
  try {
    const marker = JSON.parse(await readFile(markerPath, 'utf8'));
    if (JSON.stringify(marker) !== JSON.stringify(expected)) throw new Error('This state belongs to another host path or operating system. Use the original host, or a separate checkout for development.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if ((await readdir(paths.root)).length !== 0) throw new Error('Refusing to seed a nonempty unowned development directory.');
    await writeFile(markerPath, JSON.stringify(expected), { flag: 'wx', mode: 0o600 });
  }
  for (const [directory, mode] of [[paths.provider, 0o755], [paths.consumer, 0o755], [paths.state, 0o700]]) {
    await mkdir(directory, { recursive: true, mode });
    if ((await lstat(directory)).isSymbolicLink()) throw new Error('Development paths cannot be symbolic links.');
    if (process.platform !== 'win32') await chmod(directory, mode);
  }
  if (process.platform !== 'win32' && ((await lstat(paths.state)).mode & 0o077) !== 0) {
    throw new Error('Local worker state requires private POSIX permissions. On WSL use a checkout inside the Linux filesystem, not a Windows drive mounted without permission metadata.');
  }
  await createMissing(join(paths.provider, 'current.json'), await readFile(join(fixtureRoot, 'payments-v1.json')));
  await createMissing(join(paths.provider, 'payments.json'), JSON.stringify([
    { id: 'demo-eur', amountMinor: 2599, currency: 'EUR' },
    { id: 'demo-usd', amountMinor: 1999, currency: 'USD' },
  ], null, 2));
  for (const name of await readdir(join(fixtureRoot, 'consumer'))) {
    await createMissing(join(paths.consumer, name), await readFile(join(fixtureRoot, 'consumer', name)));
  }
  return paths;
}

export async function selectProviderVersion(version, root = developmentRoot) {
  if (!['v1', 'v2'].includes(version)) throw new Error('Select v1 or v2.');
  const paths = await seedDevelopment(root);
  const bytes = await readFile(join(fixtureRoot, `payments-${version}.json`));
  const temporary = join(paths.provider, `.version-${randomUUID()}.json`);
  await writeFile(temporary, bytes, { flag: 'wx', mode: 0o644 });
  await rename(temporary, join(paths.provider, 'current.json'));
  return { version: JSON.parse(bytes).info.version, sha256: hash(bytes) };
}
