import { inspectReleaseForRefresh } from './refresh-release.mjs';
import { releaseHash, requireReleaseValue as requireValue } from './release-tuf.mjs';

/** Transport paths follow the pinned root. Canonical operator inputs are kept
 * outside this tree so a consistent repository cannot expose mutable aliases. */
export function releaseRepositoryFiles(release, { now = Date.now() } = {}) {
  const { root, metadata, descriptors } = inspectReleaseForRefresh({ rootBytes: release.root,
    rootSha256: releaseHash(release.root), manifestSha256: releaseHash(release.releaseBundle.manifest),
    previousBundle: release.releaseBundle, now });
  requireValue(JSON.stringify(release.manifest) === release.releaseBundle.manifest
    && release.metadata instanceof Map && release.metadata.size === 3
    && release.targets instanceof Map && release.targets.size === Object.keys(descriptors).length,
  'Repository differs from its signed release.');
  const files = new Map([[`metadata/${root.version}.root.json`, release.root]]);
  for (const role of ['targets', 'snapshot', 'timestamp']) {
    const bytes = release.metadata.get(`${role}.json`);
    requireValue(Buffer.isBuffer(bytes) && bytes.equals(Buffer.from(release.releaseBundle.metadata[role])), 'Repository metadata differs from its signed bundle.');
    const name = root.consistent_snapshot && role !== 'timestamp' ? `${metadata[role].version}.${role}.json` : `${role}.json`;
    files.set(`metadata/${name}`, bytes);
  }
  for (const [path, descriptor] of Object.entries(descriptors)) {
    const bytes = release.targets.get(path);
    requireValue(Buffer.isBuffer(bytes) && bytes.length === descriptor.length
      && releaseHash(bytes) === descriptor.hashes.sha256, 'Repository target differs from its signed descriptor.');
    const split = path.lastIndexOf('/');
    const name = root.consistent_snapshot ? `${path.slice(0, split + 1)}${descriptor.hashes.sha256}.${path.slice(split + 1)}` : path;
    const destination = `targets/${name}`;
    requireValue(!files.has(destination), 'Duplicate repository path.');
    files.set(destination, bytes);
  }
  return files;
}
