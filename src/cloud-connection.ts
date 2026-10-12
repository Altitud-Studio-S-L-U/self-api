import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, importJWK, SignJWT, type JWK } from 'jose';
import { encodeCloudStatusEvent, type CloudStatusEvent } from './cloud-protocol.js';
import type { WorkerControlRequest, WorkerControlResponse, WorkerControlTransport } from './worker-license.js';

export interface CloudWorkerIdentity {
  readonly installationId: string;
  readonly publicJwk: JWK;
  readonly privateJwk: JWK;
  readonly fingerprint: string;
}
export interface CloudCredentials {
  readonly baseUrl: string;
  readonly installationId: string;
  readonly projectId: string;
  readonly clientSecret: string;
  readonly privateJwk: JWK;
  /** Development only: HTTP is accepted solely on an explicit loopback origin. */
  readonly allowLocalHttp?: boolean;
}
export interface CloudStatusReceipt { readonly eventId: string; readonly sequence: number; readonly status: 'accepted' | 'duplicate'; }
export interface CloudTransport {
  readonly installationId: string;
  readonly projectId: string;
  send(event: CloudStatusEvent): Promise<CloudStatusReceipt>;
}
export class CloudConnectionError extends Error {
  constructor(readonly code: 'INVALID_CONFIGURATION' | 'NETWORK_UNAVAILABLE' | 'INVALID_RESPONSE' | 'AUTHORIZATION_REJECTED' | 'STATUS_REJECTED' | 'RATE_LIMITED') {
    super(code); this.name = 'CloudConnectionError';
  }
}
const identifier = /^[a-f0-9]{64}$/u;
function reject(): never { throw new CloudConnectionError('INVALID_CONFIGURATION'); }

/** Keep the private JWK in customer-controlled secret storage. Only the public
 * JWK and its RFC7638 fingerprint are needed for the owner's approval. */
export async function generateCloudWorkerIdentity(): Promise<CloudWorkerIdentity> {
  const keys = await generateKeyPair('ES256',{extractable:true});
  const publicJwk = await exportJWK(keys.publicKey);
  return {installationId:randomBytes(32).toString('hex'),publicJwk,privateJwk:await exportJWK(keys.privateKey),fingerprint:await calculateJwkThumbprint(publicJwk)};
}

async function boundedJSON(response: Response): Promise<unknown> {
  if (!response.headers.get('content-type')?.includes('application/json') || Number(response.headers.get('content-length') ?? 0)>16_384) {
    await response.body?.cancel(); throw new CloudConnectionError('INVALID_RESPONSE');
  }
  const reader=response.body?.getReader();
  if (!reader) throw new CloudConnectionError('INVALID_RESPONSE');
  const chunks:Uint8Array[]=[]; let size=0;
  try {
    while (true) {
      const part=await reader.read(); if (part.done) break;
      size+=part.value.length;
      if (size>16_384) { await reader.cancel(); throw new CloudConnectionError('INVALID_RESPONSE'); }
      chunks.push(part.value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new CloudConnectionError('INVALID_RESPONSE'); }
  } finally { reader.releaseLock(); }
}

export function createCloudTransport(credentials: CloudCredentials, options: { readonly signal?: AbortSignal } = {}): CloudTransport {
  return connection(credentials, options, 'worker:status');
}
export function createCloudControlTransport(credentials: CloudCredentials, options: { readonly signal?: AbortSignal } = {}): WorkerControlTransport {
  return connection(credentials, options, 'worker:control');
}
function connection(credentials: CloudCredentials, options: { readonly signal?: AbortSignal }, scope: 'worker:status' | 'worker:control'): CloudTransport & WorkerControlTransport {
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) reject();
  let origin:URL;
  try { origin=new URL(credentials.baseUrl); } catch { reject(); }
  if (origin.origin!==credentials.baseUrl || origin.username || origin.password
    || (origin.protocol!=='https:' && !(credentials.allowLocalHttp===true && origin.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(origin.hostname)))
    || !identifier.test(credentials.installationId) || !identifier.test(credentials.projectId) || !identifier.test(credentials.clientSecret)) reject();
  const privateJwk=credentials.privateJwk;
  if (privateJwk?.kty!=='EC' || privateJwk.crv!=='P-256' || typeof privateJwk.d!=='string' || typeof privateJwk.x!=='string' || typeof privateJwk.y!=='string') reject();
  const publicJwk={kty:'EC',crv:'P-256',x:privateJwk.x,y:privateJwk.y};
  // Import lazily so invalid key material rejects through the same bounded
  // error contract, never through a crypto exception containing input.
  let privateKey:Awaited<ReturnType<typeof importJWK>> | undefined;
  let token:{value:string;expiresAt:number}|undefined;
  async function proof(url:string,accessToken?:string):Promise<string> {
    try {
      privateKey ??= await importJWK(privateJwk,'ES256');
      return await new SignJWT({htm:'POST',htu:url,iat:Math.floor(Date.now()/1000),jti:randomUUID(),
        ...(accessToken ? {ath:createHash('sha256').update(accessToken).digest('base64url')} : {})})
        .setProtectedHeader({alg:'ES256',typ:'dpop+jwt',jwk:publicJwk}).sign(privateKey);
    } catch { throw new CloudConnectionError('INVALID_CONFIGURATION'); }
  }
  async function request(path:string,body:string,type:string,accessToken?:string):Promise<{status:number;body:unknown}> {
    const url=new URL(path,origin).href;
    let response:Response;
    try {
      response=await fetch(url,{method:'POST',redirect:'error',signal:options.signal ? AbortSignal.any([options.signal,AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
        headers:{'content-type':type,DPoP:await proof(url,accessToken),...(accessToken?{authorization:`DPoP ${accessToken}`}:{})},body});
      const payload=await boundedJSON(response);
      return {status:response.status,body:payload};
    } catch(error) {
      if (error instanceof CloudConnectionError) throw error;
      throw new CloudConnectionError('NETWORK_UNAVAILABLE');
    }
  }
  async function accessToken():Promise<string> {
    if (token && token.expiresAt>Date.now()+15_000) return token.value;
    const result=await request('/api/worker/v1/token',new URLSearchParams({grant_type:'client_credentials',client_id:credentials.installationId,
      client_secret:credentials.clientSecret,scope}).toString(),'application/x-www-form-urlencoded');
    if (result.status===429) throw new CloudConnectionError('RATE_LIMITED');
    if (result.status!==200) throw new CloudConnectionError('AUTHORIZATION_REJECTED');
    const data=result.body as {access_token?:unknown;token_type?:unknown;expires_in?:unknown;scope?:unknown};
    if (!data || typeof data.access_token!=='string' || !identifier.test(data.access_token) || data.token_type!=='DPoP'
      || typeof data.expires_in!=='number' || !Number.isInteger(data.expires_in) || data.expires_in<1 || data.expires_in>300 || data.scope!==scope) {
      throw new CloudConnectionError('INVALID_RESPONSE');
    }
    token={value:data.access_token,expiresAt:Date.now()+data.expires_in*1000}; return token.value;
  }
  return {installationId:credentials.installationId,projectId:credentials.projectId,async send(event) {
    if (scope !== 'worker:status') reject();
    if (event.installationId!==credentials.installationId || event.projectId!==credentials.projectId) reject();
    const body=encodeCloudStatusEvent(event);
    const result=await request('/api/worker/v1/status',body,'application/json',await accessToken());
    if (result.status===401 || result.status===403) { token=undefined; throw new CloudConnectionError('AUTHORIZATION_REJECTED'); }
    if (result.status===429) throw new CloudConnectionError('RATE_LIMITED');
    if (result.status!==200) throw new CloudConnectionError('STATUS_REJECTED');
    const receipt=result.body as CloudStatusReceipt;
    if (!receipt || receipt.eventId!==event.eventId || receipt.sequence!==event.sequence || !['accepted','duplicate'].includes(receipt.status)) throw new CloudConnectionError('INVALID_RESPONSE');
    return {eventId:receipt.eventId,sequence:receipt.sequence,status:receipt.status};
  }, async poll(input: WorkerControlRequest): Promise<WorkerControlResponse> {
    if (scope !== 'worker:control' || input.installationId !== credentials.installationId || input.projectId !== credentials.projectId) reject();
    const result = await request('/api/worker/v1/control', JSON.stringify(input), 'application/json', await accessToken());
    if (result.status === 401 || result.status === 403) { token = undefined; throw new CloudConnectionError('AUTHORIZATION_REJECTED'); }
    if (result.status === 429) throw new CloudConnectionError('RATE_LIMITED');
    if (result.status !== 200) throw new CloudConnectionError('STATUS_REJECTED');
    const data = result.body as WorkerControlResponse;
    if (!data || Object.keys(data).sort().join(',') !== 'license,pollAfterMs,schemaVersion' || data.schemaVersion !== 1
      || data.pollAfterMs !== 60000 || typeof data.license !== 'string' || data.license.length > 8192) throw new CloudConnectionError('INVALID_RESPONSE');
    return data;
  }};
}
