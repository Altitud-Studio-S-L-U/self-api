import { releaseHash, requireReleaseValue as requireValue } from './release-tuf.mjs';

/** Retains only verified public receipt fields; private signing configuration
 * and keys never enter the exported release directory. */
export function releaseNativeReceipts(release, nativeReceipts = []) {
  requireValue(Array.isArray(nativeReceipts) && nativeReceipts.length <= 12, 'Invalid native receipts.');
  const files = new Map();
  for (const receipt of nativeReceipts) {
    const artifact = release.manifest.artifacts.find(value => value.fileName === receipt.fileName);
    requireValue(artifact && receipt.schemaVersion === 1 && artifact.sha256 === receipt.archiveSha256
      && /^[a-f0-9]{64}$/u.test(receipt.executableSha256)
      && JSON.stringify(receipt.nativeSignature) === JSON.stringify(artifact.nativeSignature),
    'Native receipt does not bind its signed archive.');
    const bytes = release.targets.get(artifact.target);
    requireValue(Buffer.isBuffer(bytes) && releaseHash(bytes) === artifact.sha256, 'Receipt archive bytes differ from signed metadata.');
    const path = `native-receipts/${artifact.fileName}.signing.json`;
    requireValue(!files.has(path), 'Duplicate native receipt.');
    files.set(path, Buffer.from(JSON.stringify({ schemaVersion: 1, fileName: receipt.fileName,
      archiveSha256: receipt.archiveSha256, executableSha256: receipt.executableSha256, nativeSignature: receipt.nativeSignature })));
  }
  return files;
}
