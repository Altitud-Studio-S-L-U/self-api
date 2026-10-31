import { lstatSync, rmSync } from 'node:fs';

const output = new URL('../dist', import.meta.url);
try {
  if (lstatSync(output).isSymbolicLink()) throw new Error('The build output must not be a symbolic link.');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
// A clean output prevents retired entry points from leaking into packed releases.
rmSync(output, { recursive: true, force: true });
