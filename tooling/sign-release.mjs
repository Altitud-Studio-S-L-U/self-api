import { releaseHash as sha256, releaseDescriptor as descriptor, requireReleaseValue as requireValue,
  pinnedReleaseRoot, signedReleaseEnvelope, releaseMetadataVersions, requireReleaseBundleBounds } from './release-tuf.mjs';
export { canonicalTuf } from './release-tuf.mjs';

/** Produces inert metadata, never publishes it or provisions a trust root. Role
 * keys must be supplied independently by the operator's signing environment. */
export function buildSignedRelease({ rootBytes, rootSha256, roleKeys, version, sequence, sourceRevision, artifacts, documentation, notes, requirements, metadataVersions, now = Date.now() }) {
  const root = pinnedReleaseRoot(rootBytes, rootSha256, now);
  const versions = releaseMetadataVersions(metadataVersions === undefined ? { targets: sequence, snapshot: sequence, timestamp: sequence } : metadataVersions);
  requireValue(/^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/u.test(version)
    && Number.isSafeInteger(sequence) && sequence >= 1 && sequence <= 2147483646 && /^[a-f0-9]{40}$/u.test(sourceRevision), 'Invalid release identity.');
  requireValue(Array.isArray(artifacts) && artifacts.length >= 1 && artifacts.length <= 12, 'A signed release needs bounded artifacts.');
  for(const [value,limit] of [[notes,4000],[requirements,2000]])requireValue(value && Object.keys(value).sort().join(',')==='en,es' && ['es','en'].every(locale=>typeof value[locale]==='string' && value[locale].trim().length>0 && value[locale].length<=limit && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ud800-\udfff]/u.test(value[locale])),'Invalid bilingual release text.');
  const targets = new Map(), platforms = new Set();
  const records = artifacts.map(artifact => {
    requireValue(['any','linux','macos','windows'].includes(artifact.os) && ['any','x64','arm64'].includes(artifact.arch)
      && (artifact.os==='any')===(artifact.arch==='any')
      && /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.(?:tgz|zip|tar\.gz)$/u.test(artifact.fileName) && !artifact.fileName.includes('..')
      && Buffer.isBuffer(artifact.bytes) && artifact.bytes.length >= 1 && artifact.bytes.length <= 64*1024*1024, 'Invalid release artifact.');
    const platform = `${artifact.os}:${artifact.arch}`;
    requireValue(!platforms.has(platform), 'Duplicate release platform.'); platforms.add(platform);
    const isSdk = artifact.os === 'any' && artifact.arch === 'any';
    requireValue(!isSdk || artifact.fileName === `self-managed-api-${version}.tgz`, 'SDK target name must be canonical.');
    const target = isSdk ? `packages/self-managed-api/${version}/${artifact.fileName}` : `workers/${version}/${artifact.fileName}`;
    requireValue(!targets.has(target), 'Duplicate artifact target.'); targets.set(target, artifact.bytes);
    const nativeSignature = artifact.nativeSignature ?? { kind: isSdk || artifact.os === 'linux' ? 'not-required' : 'none', verified: false, publisher: null };
    requireValue(Object.keys(nativeSignature).sort().join(',') === 'kind,publisher,verified'
      && ['not-required','none','authenticode','developer-id-notarized'].includes(nativeSignature.kind)
      && typeof nativeSignature.verified === 'boolean' && (nativeSignature.publisher === null || typeof nativeSignature.publisher === 'string' && nativeSignature.publisher.length >= 1 && nativeSignature.publisher.length <= 256), 'Invalid native signing receipt.');
    // A signature assertion comes only from the trusted build's OS verifier,
    // not from filenames, checksums or a certificate being merely configured.
    const requiredKind = artifact.os === 'windows' ? 'authenticode' : artifact.os === 'macos' ? 'developer-id-notarized' : 'not-required';
    const eligible = requiredKind === 'not-required' || nativeSignature.kind === requiredKind && nativeSignature.verified && !!nativeSignature.publisher;
    return { os: artifact.os, arch: artifact.arch, fileName: artifact.fileName, target, sha256: sha256(artifact.bytes), sizeBytes: artifact.bytes.length, nativeSignature, eligible };
  });
  const sdk = records.find(record => record.os === 'any' && record.arch === 'any');
  requireValue(sdk && sdk.sizeBytes <= 32*1024*1024, 'The current updater requires its signed SDK target.');
  requireValue(Buffer.isBuffer(documentation) && documentation.length>=5 && documentation.length<=8*1024*1024 && documentation.subarray(0,5).toString()==='%PDF-', 'A release needs its version-bound technical PDF.');
  const documentFileName=`self-managed-api-${version}-technical-guide.pdf`,documentTarget=`documentation/${version}/${documentFileName}`;
  targets.set(documentTarget,documentation);
  const manifest = { schemaVersion: 1, version, sequence, sourceRevision, notes, requirements,
    publicationEligible: records.every(record => record.eligible), artifacts: records.map(({ eligible, ...record }) => record),
    documentation:{fileName:documentFileName,target:documentTarget,sha256:sha256(documentation),sizeBytes:documentation.length} };
  targets.set('release-manifest.json', Buffer.from(JSON.stringify(manifest)));
  targets.set('channels/stable.json', Buffer.from(JSON.stringify({ schemaVersion: 1, channel: 'stable', version, sequence,
    artifact: { target: sdk.target, sha256: sdk.sha256, byteLength: sdk.sizeBytes }, minimumNodeVersion: '24.21.0' })));
  const expiration = days => new Date(Math.min(now + days*86400000, Date.parse(root.expires))).toISOString();
  const envelope = (role, signed) => signedReleaseEnvelope(root, roleKeys, role, signed);
  const targetsBytes = envelope('targets', { _type: 'targets', spec_version: '1.0.31', version: versions.targets, expires: expiration(7),
    targets: Object.fromEntries([...targets].map(([path, bytes]) => [path, descriptor(bytes)])) });
  const snapshot = envelope('snapshot', { _type: 'snapshot', spec_version: '1.0.31', version: versions.snapshot, expires: expiration(1), meta: { 'targets.json': descriptor(targetsBytes, versions.targets) } });
  const timestamp = envelope('timestamp', { _type: 'timestamp', spec_version: '1.0.31', version: versions.timestamp, expires: expiration(1/24), meta: { 'snapshot.json': descriptor(snapshot, versions.snapshot) } });
  const releaseBundle = { manifest: targets.get('release-manifest.json').toString('utf8'), channel: targets.get('channels/stable.json').toString('utf8'), metadata: { targets: targetsBytes.toString('utf8'), snapshot: snapshot.toString('utf8'), timestamp: timestamp.toString('utf8') } };
  // Bound UTF-8 bytes, including localized text and JSON escaping, independently
  // of any hosting provider used to publish the static repository.
  requireReleaseBundleBounds(releaseBundle);
  return { manifest, root: rootBytes, metadata: new Map([['targets.json', targetsBytes], ['snapshot.json', snapshot], ['timestamp.json', timestamp]]), targets, releaseBundle };
}
