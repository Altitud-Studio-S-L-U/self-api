import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { generateCloudWorkerIdentity } from '../dist/cloud-connection.js';

/** Synthetic, isolated licenses for lifecycle tests; never used for customer enrollment. */
export async function createLicenseFixture(directory, options = {}) {
  const origin = options.credentials?.baseUrl ?? 'http://127.0.0.1:1';
  const identity = await generateCloudWorkerIdentity();
  const credentials = options.credentials ?? { baseUrl: origin, installationId: identity.installationId, projectId: 'b'.repeat(64),
    clientSecret: 'c'.repeat(64), privateJwk: identity.privateJwk, allowLocalHttp: true };
  const fingerprint = await calculateJwkThumbprint({ kty: 'EC', crv: 'P-256', x: credentials.privateJwk.x, y: credentials.privateJwk.y });
  const authority = await generateKeyPair('ES256', { extractable: true });
  const publicKey = await exportJWK(authority.publicKey);
  const trust = { schemaVersion: 1, issuer: origin, keys: [{ kty: 'EC', crv: 'P-256', x: publicKey.x, y: publicKey.y, kid: 'synthetic-authority' }] };
  const workerId = randomUUID(), organizationId = randomUUID();
  const entitlementExpiresAt = Math.floor(Date.now() / 1000) + 86400;
  const sign = async (changes = {}) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ schemaVersion: 1, workerId, organizationId, installationId: credentials.installationId,
      projectId: credentials.projectId, jkt: fingerprint, revision: 1, decision: 'allowed',
      entitlementExpiresAt, ...changes })
      .setProtectedHeader({ alg: 'ES256', kid: 'synthetic-authority', typ: 'keepseam-worker-license+jwt' })
      .setIssuer(origin).setAudience('keepseam-worker-automation').setIssuedAt(now).setExpirationTime(Math.min(entitlementExpiresAt, now + (options.expiresIn ?? 86400))).sign(authority.privateKey);
  };
  const token = await sign();
  const credentialsPath = join(directory, 'synthetic-worker-credentials.json'), trustPath = join(directory, 'synthetic-license-trust.json'), leasePath = join(directory, 'synthetic-worker-lease.json');
  for (const [path, value] of [[credentialsPath, credentials], [trustPath, trust], [leasePath, token]]) await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  return { credentials, trust, token, sign, license: { credentialsPath, trustPath, leasePath } };
}
