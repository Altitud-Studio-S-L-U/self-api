import { createHash, randomUUID } from 'node:crypto';
import { importJWK, SignJWT, type JWK } from 'jose';
import { loadLocalJson } from './local-file.js';
import { servicePath } from './worker-service-config.js';
import { checkServicePath, checkWindowsServiceAcl } from './worker-service-state.js';
import { ClientUpdateError } from './client-update-errors.js';

const identifier = /^[a-f0-9]{64}$/u;
function invalid(): never { throw new ClientUpdateError('credentials-unavailable'); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return Object.fromEntries(Object.entries(value));
}
function scalar(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(value)
    || Buffer.from(value, 'base64url').length !== 32 || Buffer.from(value, 'base64url').toString('base64url') !== value) invalid();
  return value;
}

/** Purpose-specific credentials: update tokens never enter the status/control transports. */
export class CloudUpdateAuthorization {
  private token: { value: string; expiresAt: number; issuedAt: number } | undefined;
  private constructor(readonly baseUrl: string, readonly installationId: string, readonly projectId: string,
    private readonly secret: string, private readonly privateKey: Awaited<ReturnType<typeof importJWK>>, private readonly publicJwk: JWK) {}

  static async load(baseUrl: string, credentialsPath: unknown): Promise<CloudUpdateAuthorization> {
    try {
      const path = servicePath(credentialsPath, process.platform === 'win32' ? 'windows' : 'systemd');
      checkServicePath(path, 'secret'); checkWindowsServiceAcl(path, true);
      const input = object(await loadLocalJson(path, 16_384));
      if (Object.keys(input).some(key => !['baseUrl', 'installationId', 'projectId', 'clientSecret', 'privateJwk', 'allowLocalHttp'].includes(key))
        || input.baseUrl !== baseUrl || (input.allowLocalHttp !== undefined && input.allowLocalHttp !== false)) invalid();
      const { installationId, projectId, clientSecret } = input;
      if (typeof installationId !== 'string' || !identifier.test(installationId) || typeof projectId !== 'string' || !identifier.test(projectId)
        || typeof clientSecret !== 'string' || !identifier.test(clientSecret)) invalid();
      const key = object(input.privateJwk);
      if (key.kty !== 'EC' || key.crv !== 'P-256') invalid();
      const publicJwk = { kty: 'EC', crv: 'P-256', x: scalar(key.x), y: scalar(key.y) };
      const privateKey = await importJWK({ ...publicJwk, d: scalar(key.d) }, 'ES256');
      return new CloudUpdateAuthorization(baseUrl, installationId, projectId, clientSecret, privateKey, publicJwk);
    } catch { invalid(); }
  }

  tokenValue(): string | undefined {
    const now = Date.now();
    return this.token && now >= this.token.issuedAt && this.token.expiresAt > now + 15_000 ? this.token.value : undefined;
  }
  tokenBody(): string {
    return new URLSearchParams({ grant_type: 'client_credentials', client_id: this.installationId,
      client_secret: this.secret, scope: 'worker:updates' }).toString();
  }
  acceptToken(bytes: Buffer, startedAt: number): string {
    let input: Record<string, unknown>;
    try { input = object(JSON.parse(bytes.toString('utf8'))); } catch { throw new ClientUpdateError('verification-failed'); }
    const { access_token: value, expires_in: expires } = input;
    if (Object.keys(input).sort().join(',') !== 'access_token,expires_in,scope,token_type'
      || typeof value !== 'string' || !identifier.test(value) || input.token_type !== 'DPoP' || input.scope !== 'worker:updates'
      || typeof expires !== 'number' || !Number.isInteger(expires) || expires < 1 || expires > 300
      || startedAt > Date.now() || startedAt + expires * 1000 <= Date.now()) throw new ClientUpdateError('verification-failed');
    this.token = { value, issuedAt: startedAt, expiresAt: startedAt + expires * 1000 }; return value;
  }
  async proof(url: string, method: 'POST' | 'GET', token?: string): Promise<string> {
    const parsed = new URL(url);
    if (parsed.origin !== this.baseUrl || parsed.href !== url || parsed.search || parsed.hash
      || (method === 'POST' ? parsed.pathname !== '/api/worker/v1/token' || token !== undefined
        : !parsed.pathname.startsWith('/api/worker/v1/updates/') || !token)) throw new ClientUpdateError('verification-failed');
    try {
      return await new SignJWT({ htm: method, htu: url, iat: Math.floor(Date.now() / 1000), jti: randomUUID(),
        ...(token ? { ath: createHash('sha256').update(token).digest('base64url') } : {}) })
        .setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk: this.publicJwk }).sign(this.privateKey);
    } catch { invalid(); }
  }
}
