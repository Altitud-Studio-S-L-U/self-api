import { authenticatedReleaseMetadata, canonicalTuf, pinnedReleaseRoot, releaseDescriptor,
  releaseHash, releaseMetadataVersions, requireImportBundleBounds, requireReleaseValue as requireValue, signedReleaseEnvelope } from './release-tuf.mjs';

const hour = 3600000;
const metadataRoles = ['targets', 'snapshot', 'timestamp'];
const same = (left, right) => canonicalTuf(left) === canonicalTuf(right);
const closed = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const safePath = value => typeof value === 'string' && value.length <= 256 && value.split('/').every(segment =>
  /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(segment) && !segment.includes('..') && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu.test(segment));

/** Authenticates historical bytes even when their metadata has expired. The
 * exact root and release manifest are independently pinned by the operator. */
export function inspectReleaseForRefresh({ rootBytes, rootSha256, manifestSha256, previousBundle, now = Date.now() }) {
  const root = pinnedReleaseRoot(rootBytes, rootSha256, now);
  requireValue(closed(previousBundle, ['manifest', 'metadata']) && typeof previousBundle.manifest === 'string'
    && closed(previousBundle.metadata, metadataRoles) && metadataRoles.every(role => typeof previousBundle.metadata[role] === 'string'), 'Invalid previous release bundle.');
  requireImportBundleBounds(previousBundle);
  requireValue(releaseHash(previousBundle.manifest) === manifestSha256, 'Pinned release manifest mismatch.');
  const manifest = JSON.parse(previousBundle.manifest);
  requireValue(manifest?.schemaVersion === 1 && /^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/u.test(manifest.version)
    && /^[a-f0-9]{40}$/u.test(manifest.sourceRevision) && Number.isSafeInteger(manifest.sequence) && manifest.sequence >= 1 && manifest.sequence <= 2147483646
    && Array.isArray(manifest.artifacts) && manifest.artifacts.length >= 1 && manifest.artifacts.length <= 12 && manifest.documentation, 'Invalid pinned release identity.');
  const bytes = Object.fromEntries(metadataRoles.map(role => [role, Buffer.from(previousBundle.metadata[role])]));
  const metadata = Object.fromEntries(metadataRoles.map(role => [role, authenticatedReleaseMetadata(root, role, bytes[role])]));
  for (const role of metadataRoles) requireValue(closed(metadata[role], ['_type', 'spec_version', 'version', 'expires', role === 'targets' ? 'targets' : 'meta']), 'Unsupported historical release metadata fields.');
  requireValue(same(metadata.snapshot.meta, { 'targets.json': releaseDescriptor(bytes.targets, metadata.targets.version) })
    && same(metadata.timestamp.meta, { 'snapshot.json': releaseDescriptor(bytes.snapshot, metadata.snapshot.version) }), 'Historical metadata references do not match authenticated bytes.');
  const descriptors = metadata.targets.targets;
  requireValue(descriptors && typeof descriptors === 'object' && !Array.isArray(descriptors)
    && Object.keys(descriptors).length <= 16, 'Invalid release target descriptors.');
  for (const [path, descriptor] of Object.entries(descriptors)) requireValue(safePath(path)
    && closed(descriptor, ['length', 'hashes']) && Number.isSafeInteger(descriptor.length) && descriptor.length >= 1 && descriptor.length <= 64 * 1024 * 1024
    && closed(descriptor.hashes, ['sha256']) && /^[a-f0-9]{64}$/u.test(descriptor.hashes.sha256), 'Invalid release target path or descriptor.');
  const expectedTargets = ['release-manifest.json', 'channels/stable.json'];
  const platforms = new Set();
  for (const record of [...manifest.artifacts, manifest.documentation]) {
    requireValue(record && safePath(record.target) && typeof record.fileName === 'string' && !record.fileName.includes('/')
      && record.target.endsWith(`/${record.fileName}`) && descriptors[record.target]?.length === record.sizeBytes
      && descriptors[record.target]?.hashes.sha256 === record.sha256, 'Release target differs from the pinned manifest.');
    expectedTargets.push(record.target);
  }
  for (const artifact of manifest.artifacts) {
    const platform = `${artifact.os}:${artifact.arch}`;
    requireValue(!platforms.has(platform), 'Duplicate release platform.'); platforms.add(platform);
  }
  requireValue(new Set(expectedTargets).size === expectedTargets.length
    && same(Object.keys(descriptors).sort(), expectedTargets.sort()), 'Unexpected or missing release targets.');
  requireValue(same(descriptors['release-manifest.json'], releaseDescriptor(Buffer.from(previousBundle.manifest))), 'Historical metadata does not bind the pinned manifest.');
  return { root, manifest, metadata, bytes, descriptors };
}

export function requiredRefreshRoles(previous, now) {
  const targets = Date.parse(previous.metadata.targets.expires) < now + hour;
  const snapshot = targets || Date.parse(previous.metadata.snapshot.expires) < now + hour;
  return [...(targets ? ['targets'] : []), ...(snapshot ? ['snapshot'] : []), 'timestamp'];
}

/** Renews only metadata. Artifacts, product identity, trust and channel bytes
 * remain fixed; a new product version must use the separate signing command. */
export function refreshSignedRelease(options) {
  const { rootBytes, rootSha256, manifestSha256, previousBundle, roleKeys, targets, now = Date.now() } = options;
  const previous = inspectReleaseForRefresh({ rootBytes, rootSha256, manifestSha256, previousBundle, now });
  requireValue(targets instanceof Map && targets.size === Object.keys(previous.descriptors).length, 'Unexpected or missing release target bytes.');
  for (const [path, descriptor] of Object.entries(previous.descriptors)) {
    const bytes = targets.get(path);
    requireValue(Buffer.isBuffer(bytes) && same(releaseDescriptor(bytes), descriptor), 'Release target bytes changed.');
  }
  const channel = JSON.parse(targets.get('channels/stable.json').toString('utf8'));
  const sdk = previous.manifest.artifacts.find(value => value.os === 'any' && value.arch === 'any');
  requireValue(sdk && closed(channel, ['schemaVersion', 'channel', 'version', 'sequence', 'artifact', 'minimumNodeVersion'])
    && channel.schemaVersion === 1 && channel.channel === 'stable' && channel.version === previous.manifest.version
    && channel.sequence === previous.manifest.sequence && /^\d+\.\d+\.\d+$/u.test(channel.minimumNodeVersion)
    && same(channel.artifact, { target: sdk.target, sha256: sdk.sha256, byteLength: sdk.sizeBytes }), 'Historical update channel differs from its pinned release.');
  const expiry = duration => new Date(Math.min(now + duration, Date.parse(previous.root.expires))).toISOString();
  const versions = releaseMetadataVersions(Object.fromEntries(metadataRoles.map(role => [role, previous.metadata[role].version])));
  const required = requiredRefreshRoles(previous, now);
  const metadata = new Map(Object.entries(previous.bytes).map(([role, bytes]) => [`${role}.json`, bytes]));
  const renew = (role, duration, fields) => {
    versions[role]++;
    releaseMetadataVersions(versions);
    metadata.set(`${role}.json`, signedReleaseEnvelope(previous.root, roleKeys, role, {
      ...previous.metadata[role], ...fields, version: versions[role], expires: expiry(duration),
    }));
  };
  // Preserve still-useful roles exactly, including signatures and cache versions.
  if (required.includes('targets')) renew('targets', 7 * 24 * hour, {});
  if (required.includes('snapshot')) renew('snapshot', 24 * hour,
    { meta: { 'targets.json': releaseDescriptor(metadata.get('targets.json'), versions.targets) } });
  renew('timestamp', hour, { meta: { 'snapshot.json': releaseDescriptor(metadata.get('snapshot.json'), versions.snapshot) } });
  const importBundle = { manifest: previousBundle.manifest,
    metadata: Object.fromEntries(metadataRoles.map(role => [role, metadata.get(`${role}.json`).toString('utf8')])) };
  requireImportBundleBounds(importBundle, { refresh: true });
  return { manifest: previous.manifest, root: rootBytes, targets: new Map(targets), metadata, importBundle };
}
