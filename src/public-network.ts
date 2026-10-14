import { Resolver } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

export interface PublicAddress { readonly address: string; readonly family: 4 | 6 }

const prohibitedV4 = new BlockList();
for (const [network, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.31.196.0', 24],
  ['192.52.193.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['192.175.48.0', 24], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) prohibitedV4.addSubnet(network, prefix, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const prohibitedV6 = new BlockList();
for (const [network, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) {
  prohibitedV6.addSubnet(network, prefix, 'ipv6');
}

/** Shared public-egress profile; callers map failures to their own fixed error codes. */
export function publicAddress(address: unknown, family?: unknown): PublicAddress {
  if (typeof address !== 'string' || address.includes('%') || address.length > 45) throw new Error('Address denied.');
  const actual = isIP(address);
  if ((family !== undefined && family !== actual) || (actual !== 4 && actual !== 6)) throw new Error('Address denied.');
  if (actual === 4 ? prohibitedV4.check(address, 'ipv4') : !globalV6.check(address, 'ipv6') || prohibitedV6.check(address, 'ipv6')) {
    throw new Error('Address denied.');
  }
  return { address, family: actual };
}

/** DNS resolution only. Validate every returned address and pin the chosen address before sending. */
export async function resolveAddresses(hostname: string, signal: AbortSignal): Promise<readonly PublicAddress[]> {
  const resolver = new Resolver({ timeout: 5_000, tries: 1 });
  const stop = (): void => { resolver.cancel(); };
  signal.addEventListener('abort', stop, { once: true });
  try {
    if (signal.aborted) throw new Error('Resolution cancelled.');
    const result = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
    return result.flatMap((value, index) => value.status === 'fulfilled'
      ? value.value.map(address => ({ address, family: index === 0 ? 4 as const : 6 as const })) : []);
  } finally { signal.removeEventListener('abort', stop); resolver.cancel(); }
}
