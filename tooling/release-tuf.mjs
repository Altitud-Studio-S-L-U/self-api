import { createHash, createPublicKey, sign, verify } from 'node:crypto';

export const releaseHash = bytes => createHash('sha256').update(bytes).digest('hex');
function boundedTufObject(value) {
  const pending = [{ value, depth: 0 }]; let count = 0;
  while (pending.length) {
    const entry = pending.pop();
    if (++count > 4096 || entry.depth > 16) throw new Error('Release metadata exceeds bounded TUF structure.');
    if (entry.value && typeof entry.value === 'object') {
      const children = Object.values(entry.value);
      if (children.length + pending.length + count > 4096) throw new Error('Release metadata exceeds bounded TUF structure.');
      for (const child of children) pending.push({ value: child, depth: entry.depth + 1 });
    }
  }
}
const canonicalValue = value => Array.isArray(value) ? `[${value.map(canonicalValue).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalValue(value[key])}`).join(',')}}` : JSON.stringify(value);
export const canonicalTuf = value => { boundedTufObject(value); return canonicalValue(value); };
export const releaseDescriptor = (bytes, version) => ({ ...(version === undefined ? {} : { version }), length: bytes.length, hashes: { sha256: releaseHash(bytes) } });
export const requireReleaseValue = (condition, message) => { if (!condition) throw new Error(message); };
const roles = ['targets', 'snapshot', 'timestamp'];
export function releaseMetadataVersions(value) {
  requireReleaseValue(value && Object.keys(value).sort().join(',') === 'snapshot,targets,timestamp'
    && roles.every(role => Number.isSafeInteger(value[role]) && value[role] >= 1 && value[role] <= 2147483646), 'Invalid independent TUF metadata versions.');
  return { targets: value.targets, snapshot: value.snapshot, timestamp: value.timestamp };
}
function policyFor(root, role) {
  const policy = root.roles?.[role];
  requireReleaseValue(policy && Number.isInteger(policy.threshold) && policy.threshold >= 1 && policy.threshold <= 5
    && Array.isArray(policy.keyids) && policy.keyids.length >= policy.threshold && policy.keyids.length <= 20
    && new Set(policy.keyids).size === policy.keyids.length, `Missing ${role} signing policy.`);
  return policy;
}
function publicKey(root, keyid) {
  const key = root.keys?.[keyid];
  requireReleaseValue(key?.keytype === 'ed25519' && key.scheme === 'ed25519' && /^[a-f0-9]{64}$/u.test(key.keyval?.public), 'Unsupported release signing key.');
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(key.keyval.public, 'hex').toString('base64url') }, format: 'jwk' });
}
// Operator renewal must authenticate expired input before re-signing it. Expiry
// is deliberately checked on the new output; this is never a client verifier.
export function authenticatedReleaseMetadata(root, role, bytes) {
  requireReleaseValue(Buffer.isBuffer(bytes) && bytes.length <= (role === 'root' ? 512000 : 16384), 'Release metadata exceeds its bounded size.');
  const envelope = JSON.parse(bytes.toString('utf8')), signed = envelope.signed, policy = policyFor(root, role);
  boundedTufObject(envelope);
  requireReleaseValue(signed?._type === role && /^1\.0\.\d+$/u.test(signed.spec_version)
    && Number.isSafeInteger(signed.version) && signed.version >= 1 && signed.version <= 2147483646
    && Number.isFinite(Date.parse(signed.expires)) && Array.isArray(envelope.signatures) && envelope.signatures.length <= 20,
  'Invalid release metadata envelope.');
  const seen = new Set(), trusted = new Set(), payload = Buffer.from(canonicalTuf(signed));
  for (const signature of envelope.signatures) {
    requireReleaseValue(signature && typeof signature.keyid === 'string' && !seen.has(signature.keyid)
      && /^[a-f0-9]{128}$/u.test(signature.sig), 'Invalid or duplicate release signature.');
    seen.add(signature.keyid);
    if (policy.keyids.includes(signature.keyid)) {
      requireReleaseValue(verify(null, payload, publicKey(root, signature.keyid), Buffer.from(signature.sig, 'hex')), 'Invalid release metadata signature.');
      trusted.add(signature.keyid);
    }
  }
  requireReleaseValue(trusted.size >= policy.threshold, `Insufficient ${role} signature threshold.`);
  return signed;
}
export function pinnedReleaseRoot(rootBytes, rootSha256, now) {
  requireReleaseValue(Buffer.isBuffer(rootBytes) && rootBytes.length <= 512000 && releaseHash(rootBytes) === rootSha256, 'Pinned TUF root mismatch.');
  const root = JSON.parse(rootBytes.toString('utf8')).signed;
  requireReleaseValue(root?._type === 'root' && root.consistent_snapshot === false && Date.parse(root.expires) > now, 'Unsupported or expired pinned TUF root.');
  authenticatedReleaseMetadata(root, 'root', rootBytes);
  return root;
}
export function signedReleaseEnvelope(root, roleKeys, role, signed) {
  const policy = policyFor(root, role), supplied = roleKeys[role];
  requireReleaseValue(Array.isArray(supplied), `Missing ${role} signing policy.`);
  const seen = new Set(), signatures = [];
  for (const { keyid, key } of supplied) {
    requireReleaseValue(!seen.has(keyid) && policy.keyids.includes(keyid), 'A role key is duplicated or not trusted.'); seen.add(keyid);
    requireReleaseValue(key.asymmetricKeyType === 'ed25519', 'Unsupported release signing key.');
    requireReleaseValue(createPublicKey(key).equals(publicKey(root, keyid)), 'Release signing key does not match pinned trust.');
    signatures.push({ keyid, sig: sign(null, Buffer.from(canonicalTuf(signed)), key).toString('hex') });
  }
  requireReleaseValue(signatures.length >= policy.threshold, `Insufficient ${role} signature threshold.`);
  return Buffer.from(JSON.stringify({ signed, signatures }));
}
export function requireImportBundleBounds(bundle, { refresh = false } = {}) {
  requireReleaseValue(bundle.manifest.length <= 16384 && bundle.metadata.targets.length <= 16384
    && bundle.metadata.snapshot.length <= 8192 && bundle.metadata.timestamp.length <= 8192
    && Buffer.byteLength(JSON.stringify({ requestId: '00000000-0000-4000-8000-000000000000', ...(refresh ? { expectedRevision: 2147483646 } : {}), bundle })) <= 30000,
  'Release metadata exceeds the bounded Cloud import contract.');
}
