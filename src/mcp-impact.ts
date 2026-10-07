import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import { isProxy } from 'node:util/types';
import { parse, type ParserPlugin } from '@babel/parser';
import { captureConsumer, isCapturedConsumerPath, type ConsumerFile } from './consumer-files.js';
import type { SourceLocation } from './consumer-contracts.js';
import { PlumberError } from './errors.js';
import { compareMcpCatalogs, loadMcpCatalog, type McpComparisonReport } from './mcp-catalog.js';

export interface McpClientBinding {
  readonly file: string;
  readonly receiver: string;
  readonly serverId: string;
  readonly authContextId: string;
}
export interface McpImpactOptions {
  readonly consumerRoot: string;
  readonly basePath: string;
  readonly revisionPath: string;
  readonly bindings?: readonly McpClientBinding[];
  /** Local comparison evidence; its captured digests must still match both supplied catalogs. */
  readonly comparison?: McpComparisonReport;
}
export interface McpConsumerCall {
  readonly id: string;
  readonly location: SourceLocation;
  readonly receiver: string | null;
  readonly toolName: string | null;
  readonly inputFields: readonly string[];
  readonly resolution: 'bound' | 'unresolved';
  readonly reason: string | null;
  /** JSON pointers below structuredContent, never inferred runtime output values. */
  readonly responseFields: readonly string[];
  readonly parserLocations: readonly SourceLocation[];
  readonly parserTrace: 'direct-reads' | 'unavailable';
}
export interface McpImpactReport {
  readonly schemaVersion: 1;
  readonly comparison: McpComparisonReport;
  readonly context: 'consistent' | 'inconclusive';
  readonly inventory: {
    readonly digest: string;
    readonly files: readonly { readonly path: string; readonly sha256: string }[];
    readonly calls: readonly McpConsumerCall[];
    readonly issues: readonly { readonly code: string; readonly location: SourceLocation }[];
    readonly skipped: readonly { readonly path: string; readonly reason: string }[];
    readonly codeExecuted: false;
  };
  readonly matches: readonly { readonly changeIndex: number; readonly callIds: readonly string[]; readonly parserLocations: readonly SourceLocation[] }[];
  readonly unmappedChangeIndexes: readonly number[];
  readonly unresolvedCallIds: readonly string[];
  readonly conclusion: 'review-required';
  readonly authorization: 'not-granted';
  readonly coverage: 'potential-mcp-tool-impact';
  readonly limitations: readonly string[];
}
interface AstNode { readonly type: string; readonly [key: string]: unknown }
interface Declaration { readonly node: AstNode; readonly scope: AstNode | undefined; readonly supported: boolean }
const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ObjectMethod', 'ClassMethod', 'ClassPrivateMethod']);
const WRAPPERS = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'ParenthesizedExpression']);
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

function invalid(message: string): never { throw new PlumberError('INVALID_INPUT', message); }
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function node(value: unknown): AstNode | undefined {
  return value !== null && typeof value === 'object' && 'type' in value && typeof value.type === 'string' ? value as AstNode : undefined;
}
function unwrap(value: unknown): AstNode | undefined {
  let current = node(value);
  while (current && WRAPPERS.has(current.type)) current = node(current.expression);
  return current;
}
function identifier(value: unknown): string | undefined {
  const current = unwrap(value);
  return current?.type === 'Identifier' && typeof current.name === 'string' ? current.name : undefined;
}
function list(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function member(value: AstNode): boolean { return value.type === 'MemberExpression' || value.type === 'OptionalMemberExpression'; }
function property(value: AstNode): string | undefined {
  const key = node(value.property ?? value.key);
  if (key?.type === 'Identifier' && !value.computed) return identifier(key);
  return key?.type === 'StringLiteral' && typeof key.value === 'string' ? key.value : undefined;
}
function literalString(value: unknown): string | undefined {
  const expression = unwrap(value);
  if (expression?.type === 'StringLiteral' && typeof expression.value === 'string') return expression.value;
  if (expression?.type === 'TemplateLiteral' && list(expression.expressions).length === 0) {
    const literal = node(list(expression.quasis)[0])?.value as { cooked?: unknown } | undefined;
    if (typeof literal?.cooked === 'string') return literal.cooked;
  }
  return undefined;
}
function names(value: unknown): string[] {
  const current = node(value);
  if (!current) return [];
  const name = identifier(current);
  if (name) return [name];
  if (current.type === 'ObjectPattern') return list(current.properties).flatMap((item) => {
    const entry = node(item);
    return names(entry?.type === 'RestElement' ? entry.argument : entry?.value);
  });
  if (current.type === 'ArrayPattern') return list(current.elements).flatMap(names);
  if (current.type === 'AssignmentPattern') return names(current.left);
  if (current.type === 'RestElement') return names(current.argument);
  if (current.type === 'TSParameterProperty') return names(current.parameter);
  return [];
}
function baseName(value: unknown): string | undefined {
  let current = unwrap(value);
  while (current && member(current)) current = unwrap(current.object);
  return identifier(current);
}
function location(file: ConsumerFile, value?: AstNode): SourceLocation {
  const loc = value?.loc as { start?: { line?: number; column?: number } } | undefined;
  return { file: file.path, line: loc?.start?.line ?? 1, column: (loc?.start?.column ?? 0) + 1 };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function normalizeBindings(value: unknown): McpClientBinding[] {
  if (value === undefined) return [];
  if (value === null || typeof value !== 'object' || isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 500) invalid('MCP bindings must be a plain array of at most 500 entries.');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) invalid('MCP bindings cannot be sparse or contain extra properties.');
  const seen = new Set<string>();
  return Array.from({ length: value.length }, (_, index) => {
    const item = descriptors[String(index)];
    if (!item || !Object.hasOwn(item, 'value')) invalid('MCP bindings cannot contain accessors.');
    const input: unknown = item.value;
    if (input === null || typeof input !== 'object' || isProxy(input) || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) invalid('Every MCP binding must be a plain object.');
    const fields = Object.getOwnPropertyDescriptors(input);
    const keys = Reflect.ownKeys(fields);
    const expected = ['file', 'receiver', 'serverId', 'authContextId'];
    if (keys.length !== expected.length || keys.some((key) => typeof key !== 'string' || !expected.includes(key)) || expected.some((key) => !fields[key] || !Object.hasOwn(fields[key], 'value'))) invalid('MCP bindings require file, receiver, serverId and authContextId data fields only.');
    const values = Object.fromEntries(expected.map((key) => [key, fields[key]!.value])) as Record<string, unknown>;
    if (typeof values.file !== 'string' || values.file.length > 2_048 || /[\u0000-\u001f\u007f]/u.test(values.file) || !isCapturedConsumerPath(values.file) || !SOURCE_EXTENSIONS.has(extname(values.file).toLowerCase())) invalid('An MCP binding file must be an exact captured relative source path.');
    if (typeof values.receiver !== 'string' || !/^[$A-Z_a-z][$\w]{0,199}$/u.test(values.receiver)) invalid('An MCP binding receiver must be a named local identifier.');
    for (const key of ['serverId', 'authContextId']) if (typeof values[key] !== 'string' || !(values[key] as string).trim() || Buffer.byteLength(values[key] as string) > 200 || /[\u0000-\u001f\u007f]/u.test(values[key] as string)) invalid('MCP server and authorization context labels must be bounded nonempty strings.');
    const binding = values as unknown as McpClientBinding;
    const key = JSON.stringify([binding.file, binding.receiver]);
    if (seen.has(key)) invalid('Only one explicit MCP binding is allowed for a file and receiver.');
    seen.add(key);
    return binding;
  });
}
function inspect(file: ConsumerFile, bindings: readonly McpClientBinding[], context: { consistent: boolean; serverId: string; authContextId: string; tools: ReadonlySet<string> }): {
  calls: McpConsumerCall[]; issues: McpImpactReport['inventory']['issues'][number][];
} {
  const calls: McpConsumerCall[] = [];
  const issues: McpImpactReport['inventory']['issues'][number][] = [];
  const issue = (code: string, value?: AstNode): void => { issues.push({ code, location: location(file, value) }); };
  const plugins: ParserPlugin[] = [];
  const extension = extname(file.path).toLowerCase();
  if (['.ts', '.tsx', '.mts', '.cts'].includes(extension)) plugins.push('typescript');
  if (['.tsx', '.jsx'].includes(extension)) plugins.push('jsx');
  let ast: AstNode;
  try {
    ast = parse(file.text, { sourceType: ['.cjs', '.cts'].includes(extension) ? 'commonjs' : ['.mjs', '.mts'].includes(extension) ? 'module' : 'unambiguous', plugins, errorRecovery: false, attachComment: false, tokens: false }) as unknown as AstNode;
  } catch (error) {
    const loc = error as { loc?: { line?: number; column?: number } };
    issues.push({ code: error instanceof RangeError ? 'ast-limit-exceeded' : 'syntax-error', location: { file: file.path, line: loc.loc?.line ?? 1, column: (loc.loc?.column ?? 0) + 1 } });
    return { calls, issues };
  }
  const nodes: AstNode[] = [];
  const parents = new Map<AstNode, AstNode>();
  const pending: { value: AstNode; parent?: AstNode; depth: number }[] = [{ value: ast, depth: 0 }];
  while (pending.length) {
    const current = pending.pop()!;
    if (nodes.length >= 100_000 || current.depth > 256) { issue('ast-limit-exceeded'); return { calls: [], issues }; }
    nodes.push(current.value);
    if (current.parent) parents.set(current.value, current.parent);
    const children = Object.values(current.value).flatMap((value) => Array.isArray(value) ? value : [value]).map(node).filter((value) => value !== undefined);
    for (let index = children.length - 1; index >= 0; index -= 1) pending.push({ value: children[index]!, parent: current.value, depth: current.depth + 1 });
  }
  const containing = (value: AstNode, types: ReadonlySet<string>): AstNode | undefined => {
    let parent = parents.get(value);
    while (parent && !types.has(parent.type)) parent = parents.get(parent);
    return parent;
  };
  const blocks = new Set(['BlockStatement', 'Program']);
  const lexicalScopes = new Set([...blocks, 'ForStatement', 'ForInStatement', 'ForOfStatement', 'SwitchStatement', 'StaticBlock']);
  const functionScopes = new Set([...FUNCTIONS, 'Program']);
  const within = (value: AstNode, scope: AstNode | undefined): boolean => {
    if (!scope) return false;
    let current: AstNode | undefined = value;
    while (current) { if (current === scope) return true; current = parents.get(current); }
    return false;
  };
  const declarations = new Map<string, Declaration[]>();
  const writes = new Set<string>();
  const uses = new Map<string, AstNode[]>();
  let dynamicScope = false;
  const declare = (pattern: unknown, current: AstNode, scope: AstNode | undefined, supported: boolean): void => {
    for (const name of names(pattern)) {
      const entries = declarations.get(name) ?? [];
      entries.push({ node: current, scope, supported: supported && identifier(pattern) === name });
      declarations.set(name, entries);
    }
  };
  for (const current of nodes) {
    const name = current.type === 'Identifier' ? identifier(current) : undefined;
    if (name) { const entries = uses.get(name) ?? []; entries.push(current); uses.set(name, entries); }
    if (current.type === 'VariableDeclarator') declare(current.id, current, containing(current, parents.get(current)?.kind === 'var' ? functionScopes : lexicalScopes), true);
    else if (FUNCTIONS.has(current.type)) {
      declare(current.id, current, containing(current, blocks), false);
      for (const parameter of list(current.params)) declare(parameter, current, current, true);
    } else if (['ImportSpecifier', 'ImportDefaultSpecifier', 'ImportNamespaceSpecifier'].includes(current.type)) declare(current.local, current, containing(current, new Set(['Program'])), current.importKind !== 'type' && parents.get(current)?.importKind !== 'type');
    else if (current.type === 'CatchClause') declare(current.param, current, current, true);
    else if (['ClassDeclaration', 'ClassExpression', 'TSImportEqualsDeclaration', 'TSEnumDeclaration', 'TSModuleDeclaration'].includes(current.type)) declare(current.id, current, containing(current, blocks), false);
    const target = current.type === 'AssignmentExpression' ? current.left
      : ['ForInStatement', 'ForOfStatement'].includes(current.type) && node(current.left)?.type !== 'VariableDeclaration' ? current.left
        : current.type === 'UpdateExpression' || (current.type === 'UnaryExpression' && current.operator === 'delete') ? current.argument : undefined;
    if (target) { for (const assigned of names(target)) writes.add(assigned); const base = baseName(target); if (base) writes.add(base); }
    if (current.type === 'WithStatement' || (current.type === 'CallExpression' && identifier(current.callee) === 'eval')) dynamicScope = true;
  }
  const propertyKey = (value: AstNode, parent: AstNode): boolean => (member(parent) && parent.property === value && !parent.computed)
    || (parent.type === 'ObjectProperty' && parent.key === value && !parent.computed && !parent.shorthand);
  const declarationUse = (value: AstNode, declaration: Declaration): boolean => {
    if (declaration.node.type === 'VariableDeclarator') return declaration.node.id === value;
    if (['ImportSpecifier', 'ImportDefaultSpecifier', 'ImportNamespaceSpecifier'].includes(declaration.node.type)) return declaration.node.local === value;
    if (FUNCTIONS.has(declaration.node.type)) return list(declaration.node.params).includes(value);
    if (declaration.node.type === 'CatchClause') return declaration.node.param === value;
    return false;
  };
  const runtimeParent = (value: AstNode): { value: AstNode; parent: AstNode | undefined } => {
    let current = value;
    let parent = parents.get(current);
    while (parent && WRAPPERS.has(parent.type) && parent.expression === current) {
      current = parent;
      parent = parents.get(current);
    }
    return { value: current, parent };
  };
  const receiverReason = (receiver: string, call: AstNode): string | null => {
    if (dynamicScope) return 'dynamic-scope';
    const entries = declarations.get(receiver) ?? [];
    if (entries.length > 1) return 'shadowed-receiver';
    const declaration = entries[0];
    if (!declaration || !declaration.supported || !within(call, declaration.scope)) return 'receiver-binding-unresolved';
    if (writes.has(receiver)) return 'receiver-reassigned';
    if ((uses.get(receiver) ?? []).some((value) => {
      if (declarationUse(value, declaration)) return false;
      const { value: expression, parent } = runtimeParent(value);
      if (parent?.type === 'ImportSpecifier' && parent.imported === value) return false;
      return parent !== undefined && !propertyKey(value, parent) && !(member(parent) && parent.object === expression);
    })) return 'receiver-escapes';
    return null;
  };
  const trace = (call: AstNode): Pick<McpConsumerCall, 'responseFields' | 'parserLocations' | 'parserTrace'> => {
    const unavailable = (): Pick<McpConsumerCall, 'responseFields' | 'parserLocations' | 'parserTrace'> => ({ responseFields: [], parserLocations: [], parserTrace: 'unavailable' });
    let awaited = parents.get(call);
    while (awaited && WRAPPERS.has(awaited.type)) awaited = parents.get(awaited);
    if (awaited?.type !== 'AwaitExpression') return unavailable();
    let declaration = parents.get(awaited);
    while (declaration && WRAPPERS.has(declaration.type)) declaration = parents.get(declaration);
    const response = declaration?.type === 'VariableDeclarator' ? identifier(declaration.id) : undefined;
    if (!declaration || !response || parents.get(declaration)?.kind !== 'const' || declarations.get(response)?.length !== 1 || writes.has(response)) return unavailable();
    const fields = new Set<string>();
    const locations: SourceLocation[] = [];
    for (const value of uses.get(response) ?? []) {
      if (declaration.id === value) continue;
      const { value: expression, parent } = runtimeParent(value);
      if (parent && propertyKey(value, parent)) continue;
      if (!parent || !member(parent) || parent.object !== expression || containing(value, blocks) !== containing(declaration, blocks)
        || containing(value, functionScopes) !== containing(declaration, functionScopes)
        || typeof value.start !== 'number' || typeof declaration.end !== 'number' || value.start <= declaration.end) return unavailable();
      const parts: string[] = [];
      let current: AstNode = parent;
      for (;;) {
        const key = property(current);
        if (key === undefined || current.type === 'OptionalMemberExpression') return unavailable();
        parts.push(key);
        const next = parents.get(current);
        if (!next || !member(next) || next.object !== current) break;
        current = next;
      }
      if (parts[0] !== 'structuredContent' || parts.length < 2) return unavailable();
      const use = parents.get(current);
      if (use && ['CallExpression', 'OptionalCallExpression', 'NewExpression'].includes(use.type) && use.callee === current) return unavailable();
      fields.add(`/${parts.slice(1).map((part) => part.replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}`);
      locations.push(location(file, current));
    }
    return fields.size ? { responseFields: [...fields].sort(), parserLocations: locations, parserTrace: 'direct-reads' } : unavailable();
  };
  for (const current of nodes) {
    if (current.type !== 'CallExpression' && current.type !== 'OptionalCallExpression') continue;
    const callee = unwrap(current.callee);
    if (!callee || !member(callee)) continue;
    const receiver = identifier(callee.object) ?? null;
    const key = property(callee);
    if (key !== 'callTool') {
      const root = baseName(callee.object);
      if (root && bindings.some((binding) => binding.receiver === root) && (key === undefined || (unwrap(callee.object) && member(unwrap(callee.object)!) && property(unwrap(callee.object)!) === 'callTool'))) issue('indirect-client-dispatch', current);
      continue;
    }
    const request = unwrap(list(current.arguments)[0]);
    let toolName: string | null = null;
    let inputFields: string[] = [];
    let requestReason: string | null = null;
    if (request?.type !== 'ObjectExpression') requestReason = 'dynamic-or-missing-request';
    else {
      const properties = new Map<string, AstNode>();
      for (const item of list(request.properties)) {
        const entry = node(item);
        const name = entry && property(entry);
        if (entry?.type !== 'ObjectProperty' || entry.computed || !name || name === '__proto__' || properties.has(name)) { requestReason = 'dynamic-request-properties'; break; }
        properties.set(name, entry);
      }
      const tool = literalString(properties.get('name')?.value);
      if (tool !== undefined && tool.length > 0 && Buffer.byteLength(tool) <= 200 && !/[\u0000-\u001f\u007f]/u.test(tool)) toolName = tool;
      else requestReason ??= 'dynamic-or-missing-tool-name';
      const argumentsNode = unwrap(properties.get('arguments')?.value);
      if (argumentsNode?.type !== 'ObjectExpression') requestReason ??= 'dynamic-or-missing-tool-arguments';
      else {
        for (const item of list(argumentsNode.properties)) {
          const entry = node(item);
          const name = entry && property(entry);
          if (entry?.type !== 'ObjectProperty' || entry.computed || name === undefined || name === '__proto__' || inputFields.includes(name)) { requestReason ??= 'dynamic-tool-arguments'; inputFields = []; break; }
          inputFields.push(name);
        }
      }
    }
    const binding = bindings.find((entry) => entry.receiver === receiver);
    const reason = !context.consistent ? 'catalog-context-inconclusive' : receiver === null ? 'indirect-receiver'
      : !binding ? 'missing-client-binding' : binding.serverId !== context.serverId || binding.authContextId !== context.authContextId ? 'binding-context-mismatch'
        : receiverReason(receiver, current) ?? (current.type === 'OptionalCallExpression' || callee.type === 'OptionalMemberExpression' ? 'optional-call' : null)
          ?? requestReason ?? (toolName !== null && !context.tools.has(toolName) ? 'tool-not-declared-in-baseline' : null);
    const parser = trace(current);
    if (parser.parserTrace === 'unavailable') issue('response-trace-unavailable', current);
    calls.push({ id: hash(JSON.stringify([file.path, file.sha256, current.start, current.end])), location: location(file, current), receiver, toolName,
      inputFields: inputFields.sort(), resolution: reason === null ? 'bound' : 'unresolved', reason, ...parser });
  }
  for (const binding of bindings) if (!declarations.has(binding.receiver)) issue('binding-receiver-not-found');
  return { calls, issues };
}

/** Static potential-impact evidence only. Explicit bindings never authorize execution or infer a live server connection. */
export async function analyzeMcpImpact(options: McpImpactOptions): Promise<McpImpactReport> {
  const bindings = normalizeBindings(options.bindings);
  const [capture, base, revision, comparison] = await Promise.all([
    captureConsumer(options.consumerRoot), loadMcpCatalog(options.basePath), loadMcpCatalog(options.revisionPath),
    options.comparison === undefined ? compareMcpCatalogs(options) : Promise.resolve(options.comparison),
  ]);
  if (comparison.schemaVersion !== 1 || comparison.base.sha256 !== base.sha256 || comparison.revision.sha256 !== revision.sha256) invalid('MCP comparison snapshots changed or do not match the supplied impact evidence.');
  const consistent = base.catalog.serverId === revision.catalog.serverId && base.catalog.authContextId === revision.catalog.authContextId
    && base.catalog.protocolVersion === revision.catalog.protocolVersion && canonical(base.catalog.capabilities) === canonical(revision.catalog.capabilities)
    && base.catalog.completeness === 'complete' && revision.catalog.completeness === 'complete';
  const context = { consistent, serverId: base.catalog.serverId, authContextId: base.catalog.authContextId, tools: new Set(base.catalog.tools.map((tool) => tool.name)) };
  const inspections = capture.files.map((file) => inspect(file, bindings.filter((binding) => binding.file === file.path), context));
  const calls = inspections.flatMap((inspection) => inspection.calls);
  const issues = inspections.flatMap((inspection) => inspection.issues);
  for (const binding of bindings) if (!capture.files.some((file) => file.path === binding.file)) issues.push({ code: 'binding-file-not-captured', location: { file: binding.file, line: 1, column: 1 } });
  const matches: McpImpactReport['matches'][number][] = [];
  const unmappedChangeIndexes: number[] = [];
  for (const [changeIndex, change] of comparison.changes.entries()) {
    const mapped = calls.filter((call) => call.resolution === 'bound' && call.toolName === change.tool);
    if (mapped.length) matches.push({ changeIndex, callIds: mapped.map((call) => call.id), parserLocations: mapped.flatMap((call) => call.parserLocations) });
    else unmappedChangeIndexes.push(changeIndex);
  }
  return { schemaVersion: 1, comparison, context: consistent ? 'consistent' : 'inconclusive',
    inventory: { digest: capture.digest, files: [...capture.files, ...capture.manifests].map(({ path, sha256 }) => ({ path, sha256 })), calls, issues, skipped: capture.skipped, codeExecuted: false },
    matches, unmappedChangeIndexes, unresolvedCallIds: calls.filter((call) => call.resolution === 'unresolved').map((call) => call.id),
    conclusion: 'review-required', authorization: 'not-granted', coverage: 'potential-mcp-tool-impact',
    limitations: [
      'File-scoped receiver bindings are explicit operator declarations, not verified live connections or authorization contexts.',
      'Only direct named-receiver callTool calls with literal tool names and argument-field objects are mapped; dynamic dispatch, shadowing and receiver writes require review.',
      'Response evidence covers direct same-block reads below structuredContent from one awaited const result; aliases, escapes and indirect parsers require review.',
      'Static evidence does not prove execution, complete usage discovery, business meaning, or a valid migration; no recipe or business answer is generated.',
    ] };
}
