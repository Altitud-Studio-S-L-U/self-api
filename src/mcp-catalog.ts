import { createHash } from 'node:crypto';
import { PlumberError } from './errors.js';
import { readLocalBytes } from './local-file.js';
import { parseStructuralSchema as parseSchema, normalizeStructuralSchema as normalizedSchema, schemaSubsetFailures as subsetFailures, SCHEMA_ANNOTATIONS as ANNOTATIONS, assertLosslessJsonNumbers } from './json-schema.js';

const MAXIMUM_BYTES = 4 * 1024 * 1024;
const MAXIMUM_DEPTH = 64;
const MAXIMUM_TOOLS = 1_000;
export type McpJsonSchema = Readonly<Record<string, unknown>> | true;
export interface McpToolContract {
  readonly name: string;
  readonly inputSchema: McpJsonSchema;
  readonly outputSchema?: McpJsonSchema;
  readonly description?: string;
  readonly title?: string;
}
/** A normalized, local capture envelope; not a tools/list wire response. */
export interface McpCatalog {
  readonly schemaVersion: 1;
  readonly serverId: string;
  readonly protocolVersion: string;
  /** An operator-chosen opaque label, never a credential or authorization header. */
  readonly authContextId: string;
  readonly capabilities: Readonly<Record<string, unknown>>;
  readonly capturedAt: string;
  readonly completeness: 'complete' | 'partial' | 'failed';
  readonly pagination: { readonly pages: number; readonly nextCursor?: string };
  readonly tools: readonly McpToolContract[];
}
export interface McpCatalogSnapshot {
  readonly schemaVersion: 1;
  readonly sha256: string;
  readonly semanticDigest: string;
  readonly byteLength: number;
  readonly catalog: McpCatalog;
}
export interface McpChange {
  readonly tool: string;
  readonly kind: 'tool-added' | 'tool-removed' | 'input-contract-changed' | 'output-contract-changed' | 'metadata-changed';
  readonly compatibility: 'compatible' | 'breaking' | 'unknown';
  readonly paths: readonly string[];
  readonly reason: string;
}
export interface McpComparisonReport {
  readonly schemaVersion: 1;
  readonly base: { readonly sha256: string; readonly semanticDigest: string };
  readonly revision: { readonly sha256: string; readonly semanticDigest: string };
  readonly contentChanged: boolean;
  readonly status: 'breaking-changes' | 'no-breaking-changes' | 'inconclusive';
  readonly changes: readonly McpChange[];
  readonly limitations: readonly string[];
  readonly coverage: 'declared-mcp-structural-profile';
  readonly consumerImpact: 'not-analyzed';
}
function invalid(message: string): never { throw new PlumberError('INVALID_INPUT', message); }
function unsupported(message: string): never { throw new PlumberError('UNSUPPORTED_CONTRACT', message); }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid(`${label} contains unsupported fields.`);
}
function boundedString(value: unknown, maximum: number, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    invalid(`${label} must be a bounded nonempty string without control characters.`);
  }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (record(value)) return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function order(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function hash(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function checkDepth(json: string): void {
  let depth = 0;
  let string = false;
  for (let index = 0; index < json.length; index += 1) {
    const character = json[index];
    if (string) {
      if (character === '\\') index += 1;
      else if (character === '"') string = false;
    } else if (character === '"') string = true;
    else if (character === '[' || character === '{') {
      depth += 1;
      if (depth > MAXIMUM_DEPTH) invalid('MCP input exceeds the nesting limit of 64.');
    } else if (character === ']' || character === '}') depth -= 1;
  }
}
function semanticCatalog(catalog: McpCatalog): unknown {
  return {
    serverId: catalog.serverId, protocolVersion: catalog.protocolVersion, authContextId: catalog.authContextId,
    capabilities: catalog.capabilities, completeness: catalog.completeness,
    tools: [...catalog.tools].sort((a, b) => order(a.name, b.name)).map((tool) => ({
      ...tool,
      metadata: toolMetadata(tool),
      inputSchema: normalizedSchema(parseSchema(tool.inputSchema, true)),
      ...(tool.outputSchema === undefined ? {} : { outputSchema: normalizedSchema(parseSchema(tool.outputSchema, true)) }),
    })),
  };
}
function parseCatalog(value: unknown): McpCatalog {
  if (!record(value)) invalid('An MCP catalog must be a JSON object.');
  exactKeys(value, ['schemaVersion', 'serverId', 'protocolVersion', 'authContextId', 'capabilities', 'capturedAt', 'completeness', 'pagination', 'tools'], 'MCP catalog');
  if (value.schemaVersion !== 1) unsupported('Only MCP capture envelope schemaVersion 1 is supported.');
  boundedString(value.serverId, 200, 'MCP server identity');
  boundedString(value.protocolVersion, 100, 'MCP negotiated protocol version');
  boundedString(value.authContextId, 200, 'MCP opaque authorization context');
  if (!record(value.capabilities)) invalid('MCP capabilities must be an object.');
  if (typeof value.capturedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value.capturedAt) || !Number.isFinite(Date.parse(value.capturedAt)) || new Date(value.capturedAt).toISOString() !== value.capturedAt.replace(/Z$/, value.capturedAt.includes('.') ? 'Z' : '.000Z')) {
    invalid('MCP capturedAt must be an ISO UTC timestamp.');
  }
  if (!['complete', 'partial', 'failed'].includes(value.completeness as string)) invalid('MCP completeness must be complete, partial, or failed.');
  if (!record(value.pagination)) invalid('MCP pagination evidence is required.');
  exactKeys(value.pagination, ['pages', 'nextCursor'], 'MCP pagination');
  if (!Number.isSafeInteger(value.pagination.pages) || (value.pagination.pages as number) < 0 || (value.pagination.pages as number) > 1_000) invalid('MCP pagination pages must be between 0 and 1000.');
  if (Object.hasOwn(value.pagination, 'nextCursor')) boundedString(value.pagination.nextCursor, 2_048, 'MCP continuation cursor');
  if (value.completeness === 'complete' && (value.pagination.pages === 0 || Object.hasOwn(value.pagination, 'nextCursor'))) {
    invalid('A complete MCP capture needs at least one page and no continuation cursor.');
  }
  if (!Array.isArray(value.tools) || value.tools.length > MAXIMUM_TOOLS) invalid('An MCP catalog may contain at most 1000 tools.');
  const names = new Set<string>();
  const schemaBudget = { nodes: 0 };
  for (const tool of value.tools) {
    if (!record(tool)) invalid('Every MCP tool must be an object.');
    exactKeys(tool, ['name', 'inputSchema', 'outputSchema', 'description', 'title'], 'MCP tool');
    boundedString(tool.name, 200, 'MCP tool name');
    if (names.has(tool.name)) invalid('Duplicate MCP tool names require capture review.');
    names.add(tool.name);
    if (tool.description !== undefined && (typeof tool.description !== 'string' || Buffer.byteLength(tool.description) > 8_192)) invalid('MCP tool descriptions must be strings no greater than 8192 bytes.');
    if (tool.title !== undefined) boundedString(tool.title, 200, 'MCP tool title');
    parseSchema(tool.inputSchema, true, schemaBudget);
    if (Object.hasOwn(tool, 'outputSchema')) parseSchema(tool.outputSchema, true, schemaBudget);
  }
  return value as unknown as McpCatalog;
}

/** All numeric evidence must satisfy the shared lossless numeric profile, including negotiated metadata. */
export async function loadMcpCatalog(filePath: string): Promise<McpCatalogSnapshot> {
  const bytes = await readLocalBytes(filePath, MAXIMUM_BYTES);
  let json: string;
  try { json = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { invalid('MCP catalog input must be valid UTF-8.'); }
  checkDepth(json);
  assertLosslessJsonNumbers(json);
  let value: unknown;
  try {
    value = JSON.parse(json, (_key: string, child: unknown) => {
      if (typeof child === 'number' && !Number.isFinite(child)) invalid('MCP catalog numbers must be finite.');
      if (typeof child === 'number' && Number.isInteger(child) && !Number.isSafeInteger(child)) unsupported('MCP integer values must be within the safe integer range.');
      return child;
    }) as unknown;
  } catch (error) {
    if (error instanceof PlumberError) throw error;
    invalid('MCP catalog input must be valid JSON with finite numbers.');
  }
  const catalog = parseCatalog(value);
  return freeze({ schemaVersion: 1, sha256: hash(bytes), semanticDigest: hash(canonical(semanticCatalog(catalog))), byteLength: bytes.length, catalog });
}
function pointer(path: string, name: string): string { return `${path}/${name.replaceAll('~', '~0').replaceAll('/', '~1')}`; }
function toolMetadata(tool: McpToolContract): string {
  const entries: Record<string, unknown> = {};
  function annotations(schema: unknown, path: string): void {
    if (!record(schema)) return;
    for (const [key, value] of Object.entries(schema)) if (ANNOTATIONS.has(key)) entries[pointer(path, key)] = value;
    if (record(schema.properties)) for (const [key, child] of Object.entries(schema.properties)) annotations(child, pointer(path + '/properties', key));
    if (schema.items !== undefined) annotations(schema.items, path + '/items');
  }
  annotations(tool.inputSchema, '/input');
  annotations(tool.outputSchema, '/output');
  return canonical({ title: tool.title ?? '', description: tool.description ?? '', annotations: entries });
}
export async function compareMcpCatalogs(options: { readonly basePath: string; readonly revisionPath: string }): Promise<McpComparisonReport> {
  const [base, revision] = await Promise.all([loadMcpCatalog(options.basePath), loadMcpCatalog(options.revisionPath)]);
  const limitations: string[] = ['Only declared structural contracts are compared; runtime behavior, tool side effects, and consumer parsers are not inspected.'];
  const inconclusive: string[] = [];
  if (base.catalog.serverId !== revision.catalog.serverId) inconclusive.push('MCP server identity differs.');
  if (base.catalog.authContextId !== revision.catalog.authContextId) inconclusive.push('MCP authorization context differs; permission changes cannot establish tool removal.');
  if (base.catalog.protocolVersion !== revision.catalog.protocolVersion) inconclusive.push('MCP negotiated protocol version differs.');
  if (canonical(base.catalog.capabilities) !== canonical(revision.catalog.capabilities)) inconclusive.push('MCP negotiated capabilities differ.');
  if (base.catalog.completeness !== 'complete' || revision.catalog.completeness !== 'complete') inconclusive.push('Both MCP captures must be complete before interpreting additions, removals, or schema changes.');
  const changes: McpChange[] = [];
  const missingOutputs = new Set([...base.catalog.tools, ...revision.catalog.tools].filter((tool) => tool.outputSchema === undefined).map((tool) => tool.name));
  for (const name of [...missingOutputs].sort()) limitations.push(`Tool ${JSON.stringify(name)} lacks a declared output contract in at least one capture.`);
  if (inconclusive.length === 0) {
    const oldTools = new Map(base.catalog.tools.map((tool) => [tool.name, tool]));
    const newTools = new Map(revision.catalog.tools.map((tool) => [tool.name, tool]));
    for (const name of [...new Set([...oldTools.keys(), ...newTools.keys()])].sort()) {
      const before = oldTools.get(name);
      const after = newTools.get(name);
      if (!before) {
        changes.push({ tool: name, kind: 'tool-added', compatibility: 'compatible', paths: [], reason: 'The complete revision catalog declares an additional tool.' });
        continue;
      }
      if (!after) {
        changes.push({ tool: name, kind: 'tool-removed', compatibility: 'breaking', paths: [], reason: 'The complete revision catalog no longer declares the tool under the same negotiated and authorization context.' });
        continue;
      }
      for (const direction of ['input', 'output'] as const) {
        const previous = direction === 'input' ? before.inputSchema : before.outputSchema;
        const current = direction === 'input' ? after.inputSchema : after.outputSchema;
        if (previous === undefined || current === undefined) {
          if (previous !== current) changes.push({ tool: name, kind: 'output-contract-changed', compatibility: 'unknown', paths: [], reason: 'An absent output schema cannot establish a compatible or breaking response change.' });
          continue;
        }
        const oldSchema = parseSchema(previous, true);
        const newSchema = parseSchema(current, true);
        if (canonical(normalizedSchema(oldSchema)) === canonical(normalizedSchema(newSchema))) continue;
        const paths = direction === 'input' ? subsetFailures(oldSchema, newSchema) : subsetFailures(newSchema, oldSchema);
        changes.push({
          tool: name, kind: direction === 'input' ? 'input-contract-changed' : 'output-contract-changed', compatibility: paths.length ? 'breaking' : 'compatible', paths,
          reason: direction === 'input'
            ? paths.length ? 'Some previously permitted inputs are no longer permitted.' : 'All previously permitted inputs remain permitted within the supported schema profile.'
            : paths.length ? 'Some newly permitted outputs violate the previous output contract.' : 'All newly permitted outputs satisfy the previous output contract within the supported schema profile.',
        });
      }
      if (toolMetadata(before) !== toolMetadata(after)) changes.push({ tool: name, kind: 'metadata-changed', compatibility: 'unknown', paths: [], reason: 'Changed descriptive metadata needs review; prose is evidence, never an instruction or migration rule.' });
    }
  }
  limitations.push(...inconclusive);
  const uncertain = inconclusive.length > 0 || changes.some((change) => change.compatibility === 'unknown') || limitations.length > 1;
  return freeze({
    schemaVersion: 1,
    base: { sha256: base.sha256, semanticDigest: base.semanticDigest }, revision: { sha256: revision.sha256, semanticDigest: revision.semanticDigest },
    contentChanged: base.sha256 !== revision.sha256,
    status: changes.some((change) => change.compatibility === 'breaking') ? 'breaking-changes' : uncertain ? 'inconclusive' : 'no-breaking-changes',
    changes, limitations, coverage: 'declared-mcp-structural-profile', consumerImpact: 'not-analyzed',
  });
}
