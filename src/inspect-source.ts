import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import { parse, type ParserPlugin } from '@babel/parser';
import type { ConsumerCall, SourceInspection, SourceLocation } from './consumer-contracts.js';

interface AstNode {
  readonly type: string;
  readonly [key: string]: unknown;
}

interface SourceFile {
  readonly path: string;
  readonly text: string;
  readonly sha256: string;
}

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH', 'TRACE']);
const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ObjectMethod', 'ClassMethod', 'ClassPrivateMethod']);
const WRAPPERS = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'ParenthesizedExpression']);

function node(value: unknown): AstNode | undefined {
  return value !== null && typeof value === 'object' && 'type' in value && typeof value.type === 'string'
    ? value as AstNode : undefined;
}

function unwrap(value: unknown): AstNode | undefined {
  let current = node(value);
  while (current && WRAPPERS.has(current.type)) current = node(current.expression);
  return current;
}

function name(value: unknown): string | undefined {
  const current = node(value);
  return current?.type === 'Identifier' && typeof current.name === 'string' ? current.name : undefined;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function member(value: AstNode): boolean {
  return value.type === 'MemberExpression' || value.type === 'OptionalMemberExpression';
}

function property(value: AstNode): string | undefined {
  const key = node(value.property ?? value.key);
  if (key?.type === 'Identifier' && !value.computed) return name(key);
  return key?.type === 'StringLiteral' && typeof key.value === 'string' ? key.value : undefined;
}

function location(file: SourceFile, value?: AstNode): SourceLocation {
  const loc = value?.loc as { start?: { line?: number; column?: number } } | undefined;
  return { file: file.path, line: loc?.start?.line ?? 1, column: (loc?.start?.column ?? 0) + 1 };
}

function bindings(value: unknown): string[] {
  const current = node(value);
  if (!current) return [];
  const identifier = name(current);
  if (identifier) return [identifier];
  if (current.type === 'ObjectPattern') {
    return list(current.properties).flatMap((item) => {
      const entry = node(item);
      return bindings(entry?.type === 'RestElement' ? entry.argument : entry?.value);
    });
  }
  if (current.type === 'ArrayPattern') return list(current.elements).flatMap(bindings);
  if (current.type === 'AssignmentPattern') return bindings(current.left);
  if (current.type === 'RestElement') return bindings(current.argument);
  if (current.type === 'TSParameterProperty') return bindings(current.parameter);
  return [];
}

function baseName(value: unknown): string | undefined {
  let current = unwrap(value);
  while (current && member(current)) current = unwrap(current.object);
  return name(current);
}

function packageName(specifier: unknown): string | undefined {
  const value = node(specifier);
  if (value?.type !== 'StringLiteral' || typeof value.value !== 'string') return undefined;
  const text = value.value;
  if (!text || /^[./#\\]/.test(text) || text.includes(':') || text.includes('?') || text.includes('#')) return undefined;
  const parts = text.split('/');
  const result = text.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  return result && /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(result) ? result : undefined;
}

function methodOf(call: AstNode): { method: string | null; reason?: string } {
  const args = list(call.arguments);
  if (args.length < 2) return { method: 'GET' };
  const options = unwrap(args[1]);
  if (options?.type !== 'ObjectExpression') return { method: null, reason: 'dynamic-options' };
  let method = 'GET';
  for (const item of list(options.properties)) {
    const entry = node(item);
    if (entry?.type !== 'ObjectProperty' || entry.computed || property(entry) === '__proto__') {
      return { method: null, reason: 'dynamic-options' };
    }
    if (property(entry) !== 'method') continue;
    const value = unwrap(entry.value);
    if (value?.type !== 'StringLiteral' || typeof value.value !== 'string') {
      return { method: null, reason: 'dynamic-method' };
    }
    method = value.value.toUpperCase();
    if (!METHODS.has(method)) return { method: null, reason: 'unsupported-method' };
  }
  return { method };
}

function urlOf(value: unknown, encoderAvailable: boolean): { origin: string | null; pathPattern: string | null; reason?: string } {
  const expression = unwrap(value);
  let text: string;
  const markers: string[] = [];
  if (expression?.type === 'StringLiteral' && typeof expression.value === 'string') {
    text = expression.value;
  } else if (expression?.type === 'TemplateLiteral') {
    const expressions = list(expression.expressions);
    const quasis = list(expression.quasis).map((item) => {
      const literal = node(item)?.value as { cooked?: unknown } | undefined;
      return typeof literal?.cooked === 'string' ? literal.cooked : undefined;
    });
    if (quasis.some((item) => item === undefined)) return { origin: null, pathPattern: null, reason: 'dynamic-url' };
    text = quasis[0] ?? '';
    for (let index = 0; index < expressions.length; index += 1) {
      const part = unwrap(expressions[index]);
      const marker = `plumberdynamicsegment${index}x`;
      const following = quasis[index + 1] ?? '';
      if (!encoderAvailable || part?.type !== 'CallExpression' || name(part.callee) !== 'encodeURIComponent'
        || list(part.arguments).length !== 1 || node(list(part.arguments)[0])?.type === 'SpreadElement'
        || !text.endsWith('/') || (following !== '' && !/^[/?#]/.test(following))
        || quasis.some((literal) => literal?.includes(marker))) {
        return { origin: null, pathPattern: null, reason: 'unsafe-template-segment' };
      }
      markers.push(marker);
      text += marker + following;
    }
  } else {
    return { origin: null, pathPattern: null, reason: 'dynamic-url' };
  }
  try {
    const parsed = new URL(text);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      return { origin: null, pathPattern: null, reason: 'unsupported-url' };
    }
    const segments = parsed.pathname.split('/');
    if (parsed.pathname.includes('{*}') || markers.some((marker) =>
      segments.filter((segment) => segment === marker).length !== 1
      || parsed.origin.includes(marker) || parsed.search.includes(marker) || parsed.hash.includes(marker))) {
      return { origin: null, pathPattern: null, reason: 'unsafe-template-segment' };
    }
    return {
      origin: parsed.origin,
      pathPattern: segments.map((segment) => markers.includes(segment) ? '{*}' : segment).join('/'),
    };
  } catch {
    return { origin: null, pathPattern: null, reason: 'unsupported-url' };
  }
}

export function inspectSource(file: SourceFile): SourceInspection {
  const calls: ConsumerCall[] = [];
  const imports: SourceInspection['imports'][number][] = [];
  const issues: SourceInspection['issues'][number][] = [];
  const issue = (code: string, value?: AstNode): void => { issues.push({ code, location: location(file, value) }); };
  if (Buffer.byteLength(file.text, 'utf8') > 2 * 1024 * 1024) {
    issue('source-size-limit');
    return { calls, imports, issues };
  }
  const extension = extname(file.path).toLowerCase();
  const plugins: ParserPlugin[] = [];
  if (['.ts', '.tsx', '.mts', '.cts'].includes(extension)) plugins.push('typescript');
  if (['.jsx', '.tsx'].includes(extension)) plugins.push('jsx');
  let ast: AstNode;
  try {
    ast = parse(file.text, {
      sourceType: ['.cjs', '.cts'].includes(extension) ? 'commonjs' : ['.mjs', '.mts'].includes(extension) ? 'module' : 'unambiguous',
      plugins, errorRecovery: false, attachComment: false, tokens: false,
    }) as unknown as AstNode;
  } catch (error) {
    const position = error as { loc?: { line?: number; column?: number } };
    issues.push({
      code: error instanceof RangeError ? 'ast-limit-exceeded' : 'syntax-error',
      location: { file: file.path, line: position.loc?.line ?? 1, column: (position.loc?.column ?? 0) + 1 },
    });
    return { calls, imports, issues };
  }

  const nodes: AstNode[] = [];
  const parents = new Map<AstNode, AstNode>();
  const pending: { value: AstNode; parent?: AstNode; depth: number }[] = [{ value: ast, depth: 0 }];
  while (pending.length) {
    const entry = pending.pop()!;
    if (nodes.length >= 100_000 || entry.depth > 256) {
      issue('ast-limit-exceeded');
      return { calls: [], imports: [], issues };
    }
    nodes.push(entry.value);
    if (entry.parent) parents.set(entry.value, entry.parent);
    const children = Object.values(entry.value).flatMap((value) => Array.isArray(value) ? value : [value]).map(node).filter((value) => value !== undefined);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push({ value: children[index]!, parent: entry.value, depth: entry.depth + 1 });
    }
  }

  const declarations = new Map<string, number>();
  const writes = new Set<string>();
  let globalFetchWritten = false;
  let dynamicScope = false;
  for (const current of nodes) {
    if (current.type === 'WithStatement' || (current.type === 'CallExpression' && name(current.callee) === 'eval')) dynamicScope = true;
    let declared: string[] = [];
    if (current.type === 'VariableDeclarator') declared = bindings(current.id);
    else if (FUNCTIONS.has(current.type)) declared = [...bindings(current.id), ...list(current.params).flatMap(bindings)];
    else if (['ClassDeclaration', 'ClassExpression', 'TSImportEqualsDeclaration', 'TSEnumDeclaration', 'TSModuleDeclaration'].includes(current.type)) declared = bindings(current.id);
    else if (current.type === 'CatchClause') declared = bindings(current.param);
    else if (['ImportSpecifier', 'ImportDefaultSpecifier', 'ImportNamespaceSpecifier'].includes(current.type)) declared = bindings(current.local);
    for (const identifier of declared) declarations.set(identifier, (declarations.get(identifier) ?? 0) + 1);
    const target = current.type === 'AssignmentExpression' ? current.left
      : ['ForInStatement', 'ForOfStatement'].includes(current.type) && node(current.left)?.type !== 'VariableDeclaration' ? current.left
        : current.type === 'UpdateExpression' || (current.type === 'UnaryExpression' && current.operator === 'delete') ? current.argument : undefined;
    if (target) {
      for (const identifier of bindings(target)) writes.add(identifier);
      const base = baseName(target);
      if (base) writes.add(base);
      const assignment = unwrap(target);
      if (assignment && member(assignment) && name(assignment.object) === 'globalThis'
        && (property(assignment) === 'fetch' || assignment.computed)) globalFetchWritten = true;
    }
    if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(current.type)) {
      const imported = packageName(current.source);
      if (imported) imports.push({ packageName: imported, location: location(file, current) });
    }
  }

  const outsideName = (identifier: string): boolean => !declarations.has(identifier) && !writes.has(identifier);
  const containingBlock = (value: AstNode): AstNode | undefined => {
    let current = parents.get(value);
    while (current && !['BlockStatement', 'Program'].includes(current.type)) current = parents.get(current);
    return current;
  };
  const constantName = (value: AstNode): string | undefined => {
    const identifier = name(value.id);
    return value.type === 'VariableDeclarator' && identifier && parents.get(value)?.kind === 'const'
      && declarations.get(identifier) === 1 && !writes.has(identifier) ? identifier : undefined;
  };
  const awaitedValue = (value: unknown): AstNode | undefined => {
    const expression = unwrap(value);
    return expression?.type === 'AwaitExpression' ? unwrap(expression.argument) : undefined;
  };
  const awaitedDeclarations = new Map<AstNode, AstNode>();
  const jsonDeclarations = new Map<string, AstNode[]>();
  const identifierUses = new Map<string, AstNode[]>();
  for (const current of nodes) {
    const identifier = name(current);
    if (identifier) {
      const uses = identifierUses.get(identifier) ?? [];
      uses.push(current);
      identifierUses.set(identifier, uses);
    }
    if (current.type !== 'VariableDeclarator') continue;
    const expression = awaitedValue(current.init);
    if (!expression) continue;
    awaitedDeclarations.set(expression, current);
    const callee = unwrap(expression.callee);
    const receiver = callee && member(callee) ? name(callee.object) : undefined;
    if (expression.type === 'CallExpression' && list(expression.arguments).length === 0
      && callee?.type === 'MemberExpression' && property(callee) === 'json' && receiver) {
      const values = jsonDeclarations.get(receiver) ?? [];
      values.push(current);
      jsonDeclarations.set(receiver, values);
    }
  }
  const propertyKey = (current: AstNode, parent: AstNode): boolean =>
    (member(parent) && parent.property === current && !parent.computed)
    || (parent.type === 'ObjectProperty' && parent.key === current && !parent.computed && !parent.shorthand);
  const trace = (call: AstNode): { responseFields: string[]; parserLocations: SourceLocation[] } => {
    const responseDeclaration = awaitedDeclarations.get(call);
    const responseName = responseDeclaration && constantName(responseDeclaration);
    if (!responseDeclaration || !responseName) {
      issue('response-trace-unavailable', call);
      return { responseFields: [], parserLocations: [] };
    }
    const responseEscapes = (identifierUses.get(responseName) ?? []).some((current) => {
      if (current === responseDeclaration.id) return false;
      const parent = parents.get(current);
      return parent !== undefined && !propertyKey(current, parent) && !(member(parent) && parent.object === current);
    });
    const dataDeclarations = (jsonDeclarations.get(responseName) ?? []).filter((value) =>
      containingBlock(value) === containingBlock(responseDeclaration)
      && typeof value.start === 'number' && typeof responseDeclaration.end === 'number' && value.start > responseDeclaration.end);
    if (responseEscapes || dataDeclarations.length !== 1) {
      issue('response-trace-unavailable', call);
      return { responseFields: [], parserLocations: [] };
    }
    const dataDeclaration = dataDeclarations[0]!;
    const dataName = constantName(dataDeclaration);
    if (!dataName) {
      issue('response-trace-ambiguous', call);
      return { responseFields: [], parserLocations: [] };
    }
    const fields = new Set<string>();
    const locations: SourceLocation[] = [];
    for (const current of identifierUses.get(dataName) ?? []) {
      if (current === dataDeclaration.id) continue;
      const parent = parents.get(current);
      if (!parent) continue;
      if (propertyKey(current, parent)) continue;
      if (member(parent) && parent.object === current && property(parent) !== undefined) {
        fields.add(property(parent)!);
        locations.push(location(file, parent));
      } else {
        issue('response-trace-ambiguous', call);
        return { responseFields: [], parserLocations: [] };
      }
    }
    return { responseFields: [...fields].sort(), parserLocations: locations };
  };

  for (const current of nodes) {
    if (!['CallExpression', 'OptionalCallExpression'].includes(current.type)) continue;
    const callee = unwrap(current.callee);
    const direct = name(callee) === 'fetch';
    const global = callee && member(callee) && name(callee.object) === 'globalThis' && property(callee) === 'fetch';
    if (!direct && !global) continue;
    const shadowed = dynamicScope || globalFetchWritten || !outsideName(global ? 'globalThis' : 'fetch');
    const method = methodOf(current);
    const url = urlOf(list(current.arguments)[0], outsideName('encodeURIComponent'));
    const reason = shadowed ? 'shadowed-fetch' : current.type === 'OptionalCallExpression' || callee?.type === 'OptionalMemberExpression' || callee?.computed ? 'optional-or-computed-fetch'
      : method.reason ?? url.reason;
    const traced = reason ? { responseFields: [], parserLocations: [] } : trace(current);
    const call: ConsumerCall = {
      id: createHash('sha256').update(`${file.path}\0${file.sha256}\0${String(current.start)}`).digest('hex'),
      location: location(file, current), kind: 'fetch',
      method: method.method, origin: shadowed ? null : url.origin, pathPattern: shadowed ? null : url.pathPattern,
      resolution: reason ? 'unresolved' : 'resolved',
      ...traced, ...(reason ? { reason } : {}),
    };
    calls.push(call);
    if (reason) issue(reason, current);
  }
  return { calls, imports, issues };
}
