import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkServicePath, checkWindowsServiceAcl } from '../dist/worker-service-state.js';
import { boundedFile, loadReleaseRoleKeys, writeSignedRelease } from './sign-release-cli.mjs';
import { inspectReleaseForRefresh, refreshSignedRelease, requiredRefreshRoles } from './refresh-release.mjs';

/** Uses only local operator inputs. No HTTP, root replacement, key export or
 * artifact rebuild; the previous signed directory remains unchanged. */
export async function refreshReleaseConfiguration(path, outputParent = resolve(import.meta.dirname, '../work/releases')) {
  const now = Date.now();
  const config = JSON.parse(boundedFile(path, 32768).toString('utf8'));
  if (!config || Object.keys(config).sort().join(',') !== 'manifestSha256,releaseDirectory,roleKeys,rootSha256,schemaVersion' || config.schemaVersion !== 1
    || typeof config.releaseDirectory !== 'string' || !isAbsolute(config.releaseDirectory)) throw new Error('Invalid release refresh configuration.');
  checkServicePath(config.releaseDirectory, 'directory'); checkWindowsServiceAcl(config.releaseDirectory, false);
  const rootBytes = boundedFile(join(config.releaseDirectory, 'metadata/root.json'), 512000);
  const previousBundle = JSON.parse(boundedFile(join(config.releaseDirectory, 'release-bundle.json'), 128 * 1024).toString('utf8'));
  const inspected = inspectReleaseForRefresh({ ...config, rootBytes, previousBundle, now });
  for (const [role, bytes] of Object.entries(inspected.bytes)) {
    if (!boundedFile(join(config.releaseDirectory, `metadata/${role}.json`), 16384).equals(bytes)) throw new Error('Signed directory differs from its previous bundle.');
  }
  const targets = new Map(Object.keys(inspected.descriptors).map(target => [target,
    boundedFile(join(config.releaseDirectory, 'targets', target), inspected.descriptors[target].length)]));
  const nativeReceipts = [];
  for (const artifact of inspected.manifest.artifacts) {
    const receiptPath = join(config.releaseDirectory, 'native-receipts', `${artifact.fileName}.signing.json`);
    try { nativeReceipts.push(JSON.parse(boundedFile(receiptPath, 8192).toString('utf8'))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const signed = refreshSignedRelease({ ...config, rootBytes, previousBundle, targets, now,
    roleKeys: loadReleaseRoleKeys(config.roleKeys, requiredRefreshRoles(inspected, now)) });
  return writeSignedRelease(signed, outputParent, { prefix: 'refreshed', nativeReceipts });
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (process.argv.length !== 4 || process.argv[2] !== '--config') throw new Error('Usage: node tooling/refresh-release-cli.mjs --config /absolute/operator/refresh.json');
  try { console.log(JSON.stringify(await refreshReleaseConfiguration(process.argv[3]))); }
  catch { console.error('Release metadata refresh failed; nothing was published. Check pinned identity, original bytes, key permissions, versions and root validity.'); process.exitCode = 1; }
}
