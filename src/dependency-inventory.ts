import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { PlumberError } from './errors.js';
import { readLocalBytes } from './local-file.js';

const MAXIMUM_BYTES = 4 * 1024 * 1024;
const MAXIMUM_DEPENDENCIES = 5_000;
const MAXIMUM_ADVISORIES = 1_000;
const MAXIMUM_CORRELATIONS = 20_000;
type DependencyKind = 'runtime' | 'development' | 'optional' | 'peer';
export interface NpmDependencyDeclaration {
  readonly name: string;
  readonly kind: DependencyKind;
  readonly selectorSha256: string;
  readonly exactVersion: string | null;
  readonly selector: 'exact-version' | 'non-exact';
  readonly lockfileEntry: 'recorded' | 'not-recorded';
}
export interface NpmDependencyRecord {
  readonly name: string | null;
  readonly location: string | null;
  readonly locationSha256: string;
  readonly version: string | null;
  readonly relationship: 'direct' | 'transitive' | 'unknown';
  readonly resolution: 'recorded-version' | 'unknown';
  readonly reason: 'link' | 'package-alias' | 'unsupported-location' | 'unsupported-source' | 'missing-version' | 'noncanonical-version' | null;
  readonly development: boolean;
  readonly optional: boolean;
  readonly peer: boolean;
  readonly developmentOptional: boolean;
}
export interface NpmDependencyInventory {
  readonly schemaVersion: 1;
  readonly kind: 'npm-lockfile-inventory';
  readonly sha256: string;
  readonly byteLength: number;
  readonly lockfileVersion: 2 | 3;
  readonly declarations: readonly NpmDependencyDeclaration[];
  readonly dependencies: readonly NpmDependencyRecord[];
  readonly limitations: readonly string[];
  readonly coverage: 'npm-lockfile-packages-only';
  readonly installation: 'not-verified';
  readonly codeExecuted: false;
}
export interface NpmAdvisory {
  readonly id: string;
  readonly ecosystem: 'npm';
  readonly package: string;
  readonly affectedVersions: readonly string[];
  readonly sourceURL: string;
  readonly withdrawn: boolean;
}
export interface NpmAdvisoryCatalog {
  readonly schemaVersion: 1;
  readonly advisories: readonly NpmAdvisory[];
  readonly coverage: 'explicit-exact-versions-only';
}
export interface NpmAdvisoryFinding {
  readonly advisoryId: string;
  readonly package: string;
  readonly sourceURL: string;
  readonly location: string | null;
  readonly locationSha256: string | null;
  readonly version: string | null;
  readonly status: 'affected-known-version' | 'unaffected-within-listed-versions' | 'unknown' | 'withdrawn-advisory';
  readonly reason: 'exact-version-listed' | 'exact-version-not-listed' | 'unresolved-dependency' | 'package-not-recorded' | 'advisory-withdrawn';
  readonly exploitability: 'not-assessed';
}
export interface NpmAdvisoryReport {
  readonly schemaVersion: 1;
  readonly kind: 'npm-advisory-correlation';
  readonly lockfileSha256: string;
  readonly advisoryCatalogSha256: string;
  readonly findings: readonly NpmAdvisoryFinding[];
  readonly unresolvedDependencies: number;
  readonly coverage: 'provided-advisories-and-exact-versions-only';
  readonly installation: 'not-verified';
  readonly exploitability: 'not-assessed';
  readonly limitations: readonly string[];
}

function invalid(message: string): never { throw new PlumberError('INVALID_INPUT', message); }
function unsupported(message: string): never { throw new PlumberError('UNSUPPORTED_CONTRACT', message); }
function hash(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function order(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function packageName(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 214 && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(value);
}
/** Syntax recognition only: no range solving, ordering, coercion, or registry resolution. */
function exactVersion(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 200) return false;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u.exec(value);
  if (!match || match.slice(1, 4).some((part) => !Number.isSafeInteger(Number(part)))) return false;
  return match[4] === undefined || match[4].split('.').every((part) => !/^\d+$/u.test(part) || part === '0' || !part.startsWith('0'));
}
function uniqueKeys(json: string): void {
  const stack: { object: boolean; keyExpected: boolean; keys: Set<string> }[] = [];
  for (let index = 0; index < json.length; index += 1) {
    const character = json[index];
    if (character === '"') {
      const start = index;
      for (index += 1; index < json.length; index += 1) {
        if (json[index] === '\\') index += 1;
        else if (json[index] === '"') break;
      }
      const top = stack.at(-1);
      if (top?.object && top.keyExpected) {
        let key: unknown;
        try { key = JSON.parse(json.slice(start, index + 1)); } catch { invalid('Dependency metadata must be valid JSON.'); }
        if (typeof key !== 'string') invalid('Dependency metadata must contain string object keys.');
        if (top.keys.has(key)) invalid('Duplicate JSON keys are ambiguous dependency evidence.');
        top.keys.add(key);
        top.keyExpected = false;
      }
    } else if (character === '{' || character === '[') {
      stack.push({ object: character === '{', keyExpected: character === '{', keys: new Set() });
      if (stack.length > 64) invalid('Dependency metadata exceeds the nesting limit of 64.');
    } else if (character === '}' || character === ']') stack.pop();
    else if (character === ',' && stack.at(-1)?.object) stack.at(-1)!.keyExpected = true;
  }
}
async function readJson(path: string): Promise<{ bytes: Buffer; value: unknown }> {
  const bytes = await readLocalBytes(path, MAXIMUM_BYTES);
  let json: string;
  try { json = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { invalid('Dependency metadata must be valid UTF-8.'); }
  uniqueKeys(json);
  let value: unknown;
  try {
    value = JSON.parse(json, (_key: string, child: unknown) => {
      if (typeof child === 'number' && !Number.isFinite(child)) invalid('Dependency metadata numbers must be finite.');
      return child;
    }) as unknown;
  } catch { invalid('Dependency metadata must be valid JSON with finite numbers.'); }
  return { bytes, value };
}
function locationName(path: string): { name: string; depth: number } | null {
  if (path.length > 2_048 || /[\\\u0000-\u0020\u007f]/u.test(path)) return null;
  const parts = path.split('/');
  let index = 0;
  let depth = 0;
  let name = '';
  while (index < parts.length) {
    if (parts[index++] !== 'node_modules') return null;
    name = parts[index++] ?? '';
    if (name.startsWith('@')) name += `/${parts[index++] ?? ''}`;
    if (!packageName(name)) return null;
    depth += 1;
  }
  return depth ? { name, depth } : null;
}
function flag(entry: Record<string, unknown>, name: string): boolean {
  if (entry[name] !== undefined && typeof entry[name] !== 'boolean') invalid('Dependency flags must be booleans.');
  return entry[name] === true;
}
function supportedSource(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== 'string' || value.length > 4_096 || /[\s\\\u0000-\u001f\u007f]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

export async function loadNpmDependencyInventory(filePath: string): Promise<NpmDependencyInventory> {
  const { bytes, value } = await readJson(filePath);
  if (!object(value)) invalid('An npm lockfile must be an object.');
  if (value.lockfileVersion !== 2 && value.lockfileVersion !== 3) unsupported('Only npm package-lock versions 2 and 3 are supported.');
  if (!object(value.packages) || !object(value.packages[''])) invalid('An npm lockfile must contain its packages map and root package entry.');
  const entries = Object.entries(value.packages).filter(([path]) => path !== '');
  if (entries.length > MAXIMUM_DEPENDENCIES) invalid('An npm lockfile may contain at most 5000 dependency entries.');
  const declarations: NpmDependencyDeclaration[] = [];
  for (const [key, kind] of [['dependencies', 'runtime'], ['devDependencies', 'development'], ['optionalDependencies', 'optional'], ['peerDependencies', 'peer']] as const) {
    const declared = value.packages[''][key];
    if (declared === undefined) continue;
    if (!object(declared)) invalid('Root dependency declarations must be objects.');
    for (const [name, selector] of Object.entries(declared)) {
      if (!packageName(name) || typeof selector !== 'string' || selector.length > 4_096) invalid('A dependency declaration contains an unsupported name or selector.');
      declarations.push({ name, kind, selectorSha256: hash(selector), exactVersion: exactVersion(selector) ? selector : null,
        selector: exactVersion(selector) ? 'exact-version' : 'non-exact', lockfileEntry: Object.hasOwn(value.packages, `node_modules/${name}`) ? 'recorded' : 'not-recorded' });
      if (declarations.length > MAXIMUM_DEPENDENCIES) invalid('An npm lockfile may contain at most 5000 dependency declarations.');
    }
  }
  const direct = new Set(declarations.map((declaration) => declaration.name));
  const dependencies = entries.map(([path, raw]): NpmDependencyRecord => {
    if (!object(raw)) invalid('An npm package entry must be an object.');
    const location = locationName(path);
    const development = flag(raw, 'dev');
    const optional = flag(raw, 'optional');
    const peer = flag(raw, 'peer');
    const developmentOptional = flag(raw, 'devOptional');
    const link = flag(raw, 'link');
    const named = typeof raw.name === 'string' && packageName(raw.name) ? raw.name : null;
    let reason: NpmDependencyRecord['reason'] = null;
    if (!location) reason = 'unsupported-location';
    else if (link) reason = 'link';
    else if (Object.hasOwn(raw, 'name') && named !== location.name) reason = 'package-alias';
    else if (!supportedSource(raw.resolved)) reason = 'unsupported-source';
    else if (raw.version === undefined) reason = 'missing-version';
    else if (!exactVersion(raw.version)) reason = 'noncanonical-version';
    return {
      name: named ?? location?.name ?? null, location: location ? path : null, locationSha256: hash(path),
      version: reason === null ? raw.version as string : null,
      relationship: !location ? 'unknown' : location.depth === 1 && direct.has(location.name) ? 'direct' : 'transitive',
      resolution: reason === null ? 'recorded-version' : 'unknown', reason, development, optional, peer, developmentOptional,
    };
  }).sort((left, right) => order(left.location ?? left.locationSha256, right.location ?? right.locationSha256));
  const limitations = [
    'Versions are recorded lockfile evidence; installed files, deployment, registry provenance, and exploitability are not verified.',
    'Only the packages map is inspected. Declared selectors are not resolved and package scripts are never executed.',
  ];
  if (value.lockfileVersion === 2) limitations.push('The legacy dependencies tree in a version 2 lockfile is not used as a second version authority.');
  if (dependencies.some((dependency) => dependency.resolution === 'unknown')) limitations.push('Links, aliases, unsupported locations or sources, and missing or noncanonical versions require review.');
  if (declarations.some((declaration) => declaration.lockfileEntry === 'not-recorded')) limitations.push('Some root declarations have no root lockfile entry; their installed status is unknown.');
  return freeze({ schemaVersion: 1, kind: 'npm-lockfile-inventory', sha256: hash(bytes), byteLength: bytes.length,
    lockfileVersion: value.lockfileVersion, declarations: declarations.sort((a, b) => order(a.name, b.name) || order(a.kind, b.kind)),
    dependencies, limitations, coverage: 'npm-lockfile-packages-only', installation: 'not-verified', codeExecuted: false });
}

function plainData(input: unknown, budget = { nodes: 0, bytes: 0 }, depth = 0): unknown {
  budget.nodes += 1;
  if (typeof input === 'string') budget.bytes += Buffer.byteLength(input);
  if (budget.bytes > MAXIMUM_BYTES) invalid('An advisory catalog exceeds 4 MiB.');
  if (budget.nodes > 100_000 || depth > 64) invalid('Advisory input exceeds its inspection budget.');
  if (input === null || typeof input === 'boolean' || typeof input === 'string' || (typeof input === 'number' && Number.isFinite(input))) return input;
  if (typeof input !== 'object' || isProxy(input)) invalid('Advisories require plain JSON data without proxies or executable values.');
  if (Array.isArray(input)) {
    if (Object.getPrototypeOf(input) !== Array.prototype || input.length > 20_000) invalid('Advisory arrays must be plain and bounded.');
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (Reflect.ownKeys(descriptors).length !== input.length + 1) invalid('Advisory arrays cannot have holes or additional properties.');
    return Array.from({ length: input.length }, (_, index) => {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid('Advisory arrays cannot contain accessors.');
      return plainData(descriptor.value, budget, depth + 1);
    });
  }
  if (![Object.prototype, null].includes(Object.getPrototypeOf(input))) invalid('Advisory objects must have plain prototypes.');
  const keys = Reflect.ownKeys(input);
  if (keys.length > 20_000) invalid('Advisory objects exceed the field limit.');
  const output: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    if (typeof key !== 'string') invalid('Advisory fields must be strings.');
    budget.bytes += Buffer.byteLength(key);
    const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
    if (!Object.hasOwn(descriptor, 'value')) invalid('Advisory objects cannot contain accessors.');
    output[key] = plainData(descriptor.value, budget, depth + 1);
  }
  return output;
}
function keys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) invalid('Advisory fields are missing or unsupported.');
}
function reference(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2_048 || /[\s\\\u0000-\u001f\u007f]/u.test(value)) invalid('An advisory source must be a bounded HTTPS reference.');
  let url: URL;
  try { url = new URL(value); } catch { invalid('An advisory source must be a valid HTTPS reference.'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash) invalid('Advisory references require HTTPS without credentials, query strings, or fragments.');
  return url.href;
}
/** Accepts an explicit list of affected exact versions, never a semver advisory range. */
export function normalizeNpmAdvisories(input: unknown): NpmAdvisoryCatalog {
  const value = plainData(input);
  if (Buffer.byteLength(JSON.stringify(value)) > MAXIMUM_BYTES) invalid('An advisory catalog exceeds 4 MiB.');
  if (!object(value)) invalid('An advisory catalog must be an object.');
  keys(value, ['schemaVersion', 'advisories']);
  if (value.schemaVersion !== 1) unsupported('Only npm advisory catalog schemaVersion 1 is supported.');
  if (!Array.isArray(value.advisories) || value.advisories.length > MAXIMUM_ADVISORIES) invalid('An advisory catalog may contain at most 1000 advisories.');
  const ids = new Set<string>();
  let versionCount = 0;
  const advisories = value.advisories.map((raw): NpmAdvisory => {
    if (!object(raw)) invalid('An advisory must be an object.');
    keys(raw, ['id', 'ecosystem', 'package', 'affectedVersions', 'sourceURL'], ['withdrawn']);
    if (typeof raw.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(raw.id) || ids.has(raw.id)) invalid('Advisory identifiers must be bounded and unique.');
    ids.add(raw.id);
    if (raw.ecosystem !== 'npm') unsupported('Only npm advisory records are supported.');
    if (!packageName(raw.package)) invalid('An advisory must name a supported npm package.');
    if (!Array.isArray(raw.affectedVersions) || raw.affectedVersions.length === 0 || raw.affectedVersions.length > 1_000 || raw.affectedVersions.some((version) => !exactVersion(version))) invalid('Advisories require 1 to 1000 canonical exact affected versions.');
    const versions = raw.affectedVersions as string[];
    if (new Set(versions).size !== versions.length) invalid('Affected versions must not repeat.');
    versionCount += versions.length;
    if (versionCount > 10_000) invalid('An advisory catalog may list at most 10000 exact affected versions.');
    if (raw.withdrawn !== undefined && typeof raw.withdrawn !== 'boolean') invalid('Advisory withdrawn must be boolean.');
    return { id: raw.id, ecosystem: 'npm', package: raw.package, affectedVersions: [...versions].sort(order), sourceURL: reference(raw.sourceURL), withdrawn: raw.withdrawn === true };
  }).sort((a, b) => order(a.id, b.id));
  return freeze({ schemaVersion: 1, advisories, coverage: 'explicit-exact-versions-only' });
}
export async function loadNpmAdvisories(filePath: string): Promise<NpmAdvisoryCatalog> {
  return normalizeNpmAdvisories((await readJson(filePath)).value);
}
export async function analyzeNpmAdvisories(options: { readonly lockfilePath: string; readonly advisoryPath: string }): Promise<NpmAdvisoryReport> {
  const [inventory, catalog] = await Promise.all([loadNpmDependencyInventory(options.lockfilePath), loadNpmAdvisories(options.advisoryPath)]);
  const byName = new Map<string, NpmDependencyRecord[]>();
  for (const dependency of inventory.dependencies) {
    if (dependency.name === null) continue;
    const instances = byName.get(dependency.name);
    if (instances) instances.push(dependency);
    else byName.set(dependency.name, [dependency]);
  }
  const findings: NpmAdvisoryFinding[] = [];
  for (const advisory of catalog.advisories) {
    const instances: readonly (NpmDependencyRecord | null)[] = byName.get(advisory.package) ?? [null];
    const affected = new Set(advisory.affectedVersions);
    for (const dependency of instances) {
      if (findings.length >= MAXIMUM_CORRELATIONS) throw new PlumberError('STATE_LIMIT', 'Advisory correlations exceed the 20000-finding budget.');
      const status: NpmAdvisoryFinding['status'] = advisory.withdrawn ? 'withdrawn-advisory'
        : dependency === null || dependency.resolution === 'unknown' ? 'unknown'
        : affected.has(dependency.version!) ? 'affected-known-version' : 'unaffected-within-listed-versions';
      const reason: NpmAdvisoryFinding['reason'] = advisory.withdrawn ? 'advisory-withdrawn'
        : dependency === null ? 'package-not-recorded' : dependency.resolution === 'unknown' ? 'unresolved-dependency'
        : status === 'affected-known-version' ? 'exact-version-listed' : 'exact-version-not-listed';
      findings.push({ advisoryId: advisory.id, package: advisory.package, sourceURL: advisory.sourceURL,
        location: dependency?.location ?? null, locationSha256: dependency?.locationSha256 ?? null, version: dependency?.version ?? null,
        status, reason, exploitability: 'not-assessed' });
    }
  }
  return freeze({ schemaVersion: 1, kind: 'npm-advisory-correlation', lockfileSha256: inventory.sha256,
    advisoryCatalogSha256: hash(JSON.stringify(catalog)), findings,
    unresolvedDependencies: inventory.dependencies.filter((dependency) => dependency.resolution === 'unknown').length,
    coverage: 'provided-advisories-and-exact-versions-only', installation: 'not-verified', exploitability: 'not-assessed',
    limitations: [
      'Only supplied advisories and their explicitly listed exact versions are considered; this is not a complete vulnerability assessment.',
      'A version absent from an affected list is unaffected only within that list; ranges, registry updates, and all other advisories are unknown.',
      'Lockfile records do not prove package installation or exploitability, and a package advisory does not establish a provider API change.',
      ...inventory.limitations,
    ] });
}
