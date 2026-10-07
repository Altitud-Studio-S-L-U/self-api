import { compareOpenApi } from './compare.js';
import type { CompareOptions } from './compare.js';
import type { ComparisonReport, LocalSnapshot } from './contracts.js';
import type { ConsumerCall, ConsumerInventory } from './consumer-contracts.js';
import { PlumberError } from './errors.js';
import { scanConsumer } from './scan.js';
import { loadOpenApi } from './openapi.js';

export interface ImpactOptions extends CompareOptions {
  readonly consumerRoot: string;
  /** Explicit subscription binding, including any API base path. Never fetched. */
  readonly providerBaseUrl: string;
}

export interface CapturedImpactOptions {
  readonly comparison: ComparisonReport;
  readonly inventory: ConsumerInventory;
  readonly base: LocalSnapshot;
  readonly providerBaseUrl: string;
}

export interface ImpactReport {
  readonly schemaVersion: 1;
  readonly comparison: ComparisonReport;
  readonly inventory: ConsumerInventory;
  readonly provider: { readonly origin: string; readonly basePath: string };
  readonly matches: readonly { changeIndex: number; callIds: readonly string[] }[];
  readonly unmappedChangeIndexes: readonly number[];
  readonly unresolvedCallIds: readonly string[];
  readonly conclusion: 'review-required';
  readonly coverage: 'potential-operation-impact';
}

function binding(value: string): ImpactReport['provider'] {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new PlumberError('INVALID_INPUT', 'Provide an absolute HTTP(S) provider base URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new PlumberError('INVALID_INPUT', 'The provider base URL must not contain credentials, a query, or a fragment.');
  }
  return { origin: url.origin, basePath: url.pathname.replace(/\/$/u, '') };
}

function matchesOperation(call: ConsumerCall, provider: ImpactReport['provider'], method: string, path: string, concretePaths: ReadonlySet<string>): boolean {
  if (call.resolution !== 'resolved' || call.origin !== provider.origin || call.method !== method.toUpperCase() || call.pathPattern === null) return false;
  const prefix = provider.basePath;
  if (prefix && !call.pathPattern.startsWith(`${prefix}/`)) return false;
  const callPath = call.pathPattern.slice(prefix.length);
  // OpenAPI gives a concrete path precedence over a templated path.
  if (callPath !== path && concretePaths.has(`${method.toUpperCase()} ${callPath}`)) return false;
  const actual = callPath.split('/');
  const declared = path.split('/');
  return actual.length === declared.length && declared.every((segment, index) => {
    if (/^\{[^{}]+\}$/u.test(segment)) return actual[index] !== '';
    return actual[index] === segment && actual[index] !== '{*}';
  });
}

export async function analyzeImpact(options: ImpactOptions): Promise<ImpactReport> {
  const providerBaseUrl = options.providerBaseUrl;
  // Reject invalid bindings before reading files or invoking the comparison engine.
  binding(providerBaseUrl);
  const [comparison, inventory, base] = await Promise.all([
    compareOpenApi(options), scanConsumer(options.consumerRoot), loadOpenApi(options.basePath),
  ]);
  return analyzeCapturedImpact({ comparison, inventory, base, providerBaseUrl });
}

export function analyzeCapturedImpact(options: CapturedImpactOptions): ImpactReport {
  const provider = binding(options.providerBaseUrl);
  const { comparison, inventory, base } = options;
  if (base.metadata.sha256 !== comparison.base.sha256) {
    throw new PlumberError('INVALID_INPUT', 'The base contract changed during impact analysis; retry with stable input.');
  }
  const paths = (JSON.parse(base.json) as { paths: Record<string, Record<string, unknown>> }).paths;
  const concretePaths = new Set<string>();
  for (const [path, operations] of Object.entries(paths)) {
    if (/[{}]/u.test(path) || operations === null || typeof operations !== 'object') continue;
    for (const method of ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']) {
      if (Object.hasOwn(operations, method) || Object.hasOwn(operations, '$ref')) concretePaths.add(`${method.toUpperCase()} ${path}`);
    }
  }
  const matches: ImpactReport['matches'][number][] = [];
  const unmappedChangeIndexes: number[] = [];
  for (const [changeIndex, change] of comparison.changes.entries()) {
    const callIds = change.operation && change.path
      ? inventory.calls.filter(call => matchesOperation(call, provider, change.operation!, change.path!, concretePaths)).map(call => call.id)
      : [];
    if (callIds.length) matches.push({ changeIndex, callIds });
    else unmappedChangeIndexes.push(changeIndex);
  }
  return {
    schemaVersion: 1,
    comparison,
    inventory,
    provider,
    matches,
    unmappedChangeIndexes,
    unresolvedCallIds: inventory.calls.filter(call => call.resolution === 'unresolved').map(call => call.id),
    conclusion: 'review-required',
    coverage: 'potential-operation-impact',
  };
}
