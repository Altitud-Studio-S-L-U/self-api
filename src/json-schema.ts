import { createHash } from 'node:crypto';
import { PlumberError } from './errors.js';
import { readLocalBytes } from './local-file.js';

const MAXIMUM_BYTES = 4 * 1024 * 1024;
const MAXIMUM_DEPTH = 64;
const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null']);
export const SCHEMA_ANNOTATIONS = new Set(['title', 'description', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly', '$schema']);
const SCHEMA_KEYS = new Set(['type', 'enum', 'const', 'properties', 'required', 'additionalProperties', 'items', ...SCHEMA_ANNOTATIONS]);

type Scalar = string | number | boolean | null;
type SchemaType = 'any' | 'string' | 'number' | 'integer' | 'boolean' | 'null' | 'object' | 'array';
interface Schema {
  readonly type: SchemaType;
  readonly values?: readonly Scalar[];
  readonly properties: ReadonlyMap<string, Schema>;
  readonly required: ReadonlySet<string>;
  readonly additional: boolean;
  readonly items?: Schema;
}
const ANY: Schema = { type: 'any', properties: new Map(), required: new Set(), additional: true };

function invalid(message: string): never { throw new PlumberError('INVALID_INPUT', message); }
function unsupported(message: string): never { throw new PlumberError('UNSUPPORTED_CONTRACT', message); }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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
      if (depth > MAXIMUM_DEPTH) invalid('JSON input exceeds the nesting limit of 64.');
    } else if (character === ']' || character === '}') depth -= 1;
  }
}
function decimalIdentity(token: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u.exec(token)!;
  const fraction = match[3] ?? '';
  const digits = `${match[2]}${fraction}`.replace(/^0+/u, '');
  if (!digits) return '0';
  const significant = digits.replace(/0+$/u, '');
  const exponent = Number(match[4] ?? '0') - fraction.length + digits.length - significant.length;
  return `${match[1]}${significant}e${exponent}`;
}
/**
 * Local JSON captures accept finite numbers with safe integer values and a preserved
 * decimal value across Number -> JSON serialization. Number tokens are at most 256
 * characters. This guard recognizes tokens outside strings; it is not a decimal
 * arithmetic engine and never repairs a value that JSON.parse would round.
 */
export function assertLosslessJsonNumbers(json: string): void {
  const number = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  for (let index = 0; index < json.length; index += 1) {
    if (json[index] === '"') {
      for (index += 1; index < json.length; index += 1) {
        if (json[index] === '\\') index += 1;
        else if (json[index] === '"') break;
      }
      continue;
    }
    const character = json[index]!;
    if (character !== '-' && (character < '0' || character > '9')) continue;
    number.lastIndex = index;
    const match = number.exec(json);
    if (!match) continue;
    const token = match[0];
    if (token.length > 256) unsupported('JSON number tokens longer than 256 characters are outside the supported numeric profile.');
    const value = Number(token);
    if (!Number.isFinite(value)) invalid('JSON numbers must be finite.');
    if ((Number.isInteger(value) && !Number.isSafeInteger(value)) || decimalIdentity(token) !== decimalIdentity(JSON.stringify(value))) {
      unsupported('JSON numbers must preserve their decimal value when parsed and integer values must be within the safe integer range.');
    }
    index = number.lastIndex - 1;
  }
}
function matchesType(value: Scalar, type: SchemaType): boolean {
  if (type === 'any') return true;
  if (type === 'null') return value === null;
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (type === 'object' || type === 'array') return false;
  return typeof value === type;
}
function scalar(value: unknown): value is Scalar {
  return value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
}
export function parseStructuralSchema(value: unknown, root = false, budget = { nodes: 0 }): Schema {
  budget.nodes += 1;
  if (budget.nodes > 20_000) invalid('JSON schemas exceed the 20000-node inspection budget.');
  if (value === true && !root) return ANY;
  if (!record(value)) unsupported('JSON schemas must use the declared object-schema profile; false schemas are not supported.');
  for (const key of Object.keys(value)) {
    if (!SCHEMA_KEYS.has(key)) unsupported('An JSON schema uses a keyword outside the supported structural profile.');
  }
  if (value.$schema !== undefined && value.$schema !== 'https://json-schema.org/draft/2020-12/schema') {
    unsupported('Only the JSON Schema 2020-12 dialect is supported for JSON schemas.');
  }
  for (const key of ['title', 'description']) {
    if (value[key] !== undefined && typeof value[key] !== 'string') invalid('Schema title and description must be strings.');
  }
  for (const key of ['deprecated', 'readOnly', 'writeOnly']) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') invalid('Schema flags must be booleans.');
  }
  if (value.examples !== undefined && !Array.isArray(value.examples)) invalid('Schema examples must be an array.');
  if (value.type === undefined) {
    if (root || Object.keys(value).some((key) => !SCHEMA_ANNOTATIONS.has(key))) {
      unsupported('This structural profile requires an explicit single type for every constrained schema.');
    }
    return ANY;
  }
  if (typeof value.type !== 'string' || (!SCALAR_TYPES.has(value.type) && value.type !== 'object' && value.type !== 'array')) {
    unsupported('This structural profile supports single JSON Schema types, not type unions.');
  }
  const type = value.type as SchemaType;
  if (root && type !== 'object') invalid('An object schema root is required by this contract.');
  if (type !== 'object' && ['properties', 'required', 'additionalProperties'].some((key) => Object.hasOwn(value, key))) {
    unsupported('Object schema keywords require an object type in this structural profile.');
  }
  if (type !== 'array' && Object.hasOwn(value, 'items')) unsupported('The items keyword requires an array type.');
  let values: Scalar[] | undefined;
  if (Object.hasOwn(value, 'enum') || Object.hasOwn(value, 'const')) {
    if (!SCALAR_TYPES.has(type)) unsupported('This structural profile supports scalar enums and constants only.');
    if (Object.hasOwn(value, 'enum')) {
      if (!Array.isArray(value.enum) || value.enum.length === 0 || value.enum.length > 1_000) invalid('A JSON schema enum must contain 1 to 1000 scalar values.');
      if (value.enum.some((item) => !scalar(item) || !matchesType(item, type))) invalid('Every enum value must match its declared scalar type.');
      values = value.enum as Scalar[];
      if (new Set(values.map(canonical)).size !== values.length) invalid('Duplicate enum values are not supported.');
    }
    if (Object.hasOwn(value, 'const')) {
      if (!scalar(value.const) || !matchesType(value.const, type)) invalid('A constant must match its declared scalar type.');
      if (values && !values.some((item) => canonical(item) === canonical(value.const))) invalid('A constant outside its enum is not a valid structural profile schema.');
      values = [value.const];
    }
  }
  const properties = new Map<string, Schema>();
  const required = new Set<string>();
  let additional = true;
  if (type === 'object') {
    if (value.properties !== undefined && !record(value.properties)) invalid('Schema properties must be an object.');
    for (const [name, child] of Object.entries(value.properties ?? {})) {
      boundedString(name, 1_024, 'Schema property name');
      properties.set(name, parseStructuralSchema(child, false, budget));
    }
    if (value.required !== undefined) {
      if (!Array.isArray(value.required) || value.required.some((name) => typeof name !== 'string')) invalid('Required properties must be a string array.');
      for (const name of value.required as string[]) {
        if (required.has(name)) invalid('Required properties must not repeat.');
        if (!properties.has(name)) unsupported('Required properties must be explicitly declared in this structural profile.');
        required.add(name);
      }
    }
    if (value.additionalProperties !== undefined) {
      if (typeof value.additionalProperties !== 'boolean') unsupported('This structural profile supports boolean additionalProperties only.');
      additional = value.additionalProperties;
    }
  }
  return {
    type, properties, required, additional,
    ...(values ? { values: [...values].sort((a, b) => order(canonical(a), canonical(b))) } : {}),
    ...(type === 'array' ? { items: value.items === undefined ? ANY : parseStructuralSchema(value.items, false, budget) } : {}),
  };
}
export function normalizeStructuralSchema(schema: Schema): unknown {
  return {
    type: schema.type,
    ...(schema.values ? { values: schema.values } : {}),
    ...(schema.type === 'object' ? {
      properties: Object.fromEntries([...schema.properties].map(([name, child]) => [name, normalizeStructuralSchema(child)])),
      required: [...schema.required].sort(), additional: schema.additional,
    } : {}),
    ...(schema.items ? { items: normalizeStructuralSchema(schema.items) } : {}),
  };
}
function acceptsScalar(schema: Schema, value: Scalar): boolean {
  return matchesType(value, schema.type) && (!schema.values || schema.values.some((item) => canonical(item) === canonical(value)));
}
function finiteValues(schema: Schema): readonly Scalar[] | undefined {
  return schema.values ?? (schema.type === 'boolean' ? [false, true] : schema.type === 'null' ? [null] : undefined);
}
function pointer(path: string, name: string): string { return `${path}/${name.replaceAll('~', '~0').replaceAll('/', '~1')}`; }
/** Every supported schema is satisfiable. These failures witness a value admitted only by the subset candidate. */
export function schemaSubsetFailures(sub: Schema, sup: Schema, path = ''): string[] {
  if (sup.type === 'any') return [];
  if (sub.type === 'any') return [path || '/'];
  const finite = finiteValues(sub);
  if (finite) return finite.every((value) => acceptsScalar(sup, value)) ? [] : [path || '/'];
  if (sub.type !== sup.type && !(sub.type === 'integer' && sup.type === 'number')) return [path || '/'];
  if (sup.values) return [path || '/'];
  if (sub.type === 'array') return schemaSubsetFailures(sub.items!, sup.items!, `${path}/items`);
  if (sub.type !== 'object') return [];
  const failures: string[] = [];
  for (const name of sup.required) if (!sub.required.has(name)) failures.push(pointer(`${path}/required`, name));
  for (const name of new Set([...sub.properties.keys(), ...sup.properties.keys()])) {
    const from = sub.properties.get(name) ?? (sub.additional ? ANY : undefined);
    const to = sup.properties.get(name) ?? (sup.additional ? ANY : undefined);
    if (from === undefined) continue;
    const propertyPath = pointer(`${path}/properties`, name);
    if (to === undefined) failures.push(propertyPath);
    else failures.push(...schemaSubsetFailures(from, to, propertyPath));
  }
  if (sub.additional && !sup.additional) failures.push(`${path}/additionalProperties`);
  return [...new Set(failures)].sort();
}

export type JsonSchema = Readonly<Record<string, unknown>> | true;
export interface JsonSchemaSnapshot {
  readonly schemaVersion: 1;
  readonly kind: 'declared-schema';
  readonly source: 'local-file';
  readonly sha256: string;
  readonly semanticDigest: string;
  readonly byteLength: number;
  readonly schema: JsonSchema;
}
export interface JsonSchemaComparison {
  readonly schemaVersion: 1;
  readonly kind: 'declared-schema-comparison';
  readonly direction: 'input' | 'output';
  readonly base: { readonly sha256: string; readonly semanticDigest: string };
  readonly revision: { readonly sha256: string; readonly semanticDigest: string };
  readonly contentChanged: boolean;
  readonly structuralChanged: boolean;
  readonly metadataChanged: boolean;
  readonly compatibility: 'compatible' | 'breaking' | 'unknown';
  readonly status: 'no-breaking-changes' | 'breaking-changes' | 'inconclusive';
  readonly paths: readonly string[];
  readonly limitations: readonly string[];
  readonly coverage: 'declared-json-schema-structural-profile';
  readonly consumerImpact: 'not-analyzed';
}
export interface JsonExampleSnapshot {
  readonly schemaVersion: 1;
  readonly kind: 'observed-example';
  readonly source: 'local-file';
  readonly sha256: string;
  readonly valueDigest: string;
  readonly byteLength: number;
  readonly value: unknown;
  readonly inference: 'none';
  readonly requiredFields: 'unknown';
  readonly compatibility: 'not-established';
}
export interface JsonExampleComparison {
  readonly schemaVersion: 1;
  readonly kind: 'observed-example-comparison';
  readonly base: { readonly sha256: string; readonly valueDigest: string };
  readonly revision: { readonly sha256: string; readonly valueDigest: string };
  readonly contentChanged: boolean;
  readonly valueChanged: boolean;
  readonly status: 'inconclusive';
  readonly compatibility: 'not-established';
  readonly inference: 'none';
  readonly requiredFields: 'unknown';
  readonly limitations: readonly string[];
}
function annotations(schema: unknown): Record<string, unknown> {
  const entries: Record<string, unknown> = {};
  function visit(value: unknown, path: string): void {
    if (!record(value)) return;
    for (const [key, child] of Object.entries(value)) if (SCHEMA_ANNOTATIONS.has(key)) entries[pointer(path, key)] = child;
    if (record(value.properties)) for (const [name, child] of Object.entries(value.properties)) visit(child, pointer(path + '/properties', name));
    if (value.items !== undefined) visit(value.items, path + '/items');
  }
  visit(schema, '');
  return entries;
}
async function readJson(filePath: string): Promise<{ readonly bytes: Buffer; readonly value: unknown }> {
  const bytes = await readLocalBytes(filePath, MAXIMUM_BYTES);
  let json: string;
  try { json = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { invalid('JSON input must be valid UTF-8.'); }
  checkDepth(json);
  assertLosslessJsonNumbers(json);
  let value: unknown;
  try {
    value = JSON.parse(json, (_key: string, child: unknown) => {
      if (typeof child === 'number' && !Number.isFinite(child)) invalid('JSON numbers must be finite.');
      if (typeof child === 'number' && Number.isInteger(child) && !Number.isSafeInteger(child)) unsupported('JSON integer values must be within the safe integer range.');
      return child;
    }) as unknown;
  } catch (error) {
    if (error instanceof PlumberError) throw error;
    invalid('Input must be valid JSON with finite numbers.');
  }
  return { bytes, value };
}
/** Reads an explicit schema using the lossless numeric profile; never imports a framework or connects to a database. */
export async function loadJsonSchema(filePath: string): Promise<JsonSchemaSnapshot> {
  const { bytes, value } = await readJson(filePath);
  const parsed = parseStructuralSchema(value);
  return freeze({
    schemaVersion: 1, kind: 'declared-schema', source: 'local-file',
    sha256: hash(bytes), semanticDigest: hash(canonical({ structure: normalizeStructuralSchema(parsed), annotations: annotations(value) })),
    byteLength: bytes.length, schema: value as JsonSchema,
  });
}
export async function compareJsonSchemas(options: {
  readonly basePath: string;
  readonly revisionPath: string;
  readonly direction: 'input' | 'output';
}): Promise<JsonSchemaComparison> {
  if (options.direction !== 'input' && options.direction !== 'output') invalid('Choose input or output compatibility direction explicitly.');
  const [base, revision] = await Promise.all([loadJsonSchema(options.basePath), loadJsonSchema(options.revisionPath)]);
  const oldSchema = parseStructuralSchema(base.schema);
  const newSchema = parseStructuralSchema(revision.schema);
  const structuralChanged = canonical(normalizeStructuralSchema(oldSchema)) !== canonical(normalizeStructuralSchema(newSchema));
  const metadataChanged = canonical(annotations(base.schema)) !== canonical(annotations(revision.schema));
  const paths = options.direction === 'input' ? schemaSubsetFailures(oldSchema, newSchema) : schemaSubsetFailures(newSchema, oldSchema);
  const compatibility = paths.length ? 'breaking' : metadataChanged ? 'unknown' : 'compatible';
  const limitations = [
    'Only the supported declared JSON Schema structural profile is compared; runtime behavior and business semantics are not established.',
    'A database or framework export does not establish API authorization, deployment, or consumer behavior.',
  ];
  if (metadataChanged) limitations.push('Changed descriptive annotations need review and never authorize actions or define an inferred migration.');
  return freeze({
    schemaVersion: 1, kind: 'declared-schema-comparison', direction: options.direction,
    base: { sha256: base.sha256, semanticDigest: base.semanticDigest }, revision: { sha256: revision.sha256, semanticDigest: revision.semanticDigest },
    contentChanged: base.sha256 !== revision.sha256, structuralChanged, metadataChanged, compatibility,
    status: compatibility === 'breaking' ? 'breaking-changes' : compatibility === 'unknown' ? 'inconclusive' : 'no-breaking-changes',
    paths, limitations, coverage: 'declared-json-schema-structural-profile', consumerImpact: 'not-analyzed',
  });
}
/** Examples use the lossless numeric profile and remain observations even when their keys resemble a schema. */
export async function loadJsonExample(filePath: string): Promise<JsonExampleSnapshot> {
  const { bytes, value } = await readJson(filePath);
  return freeze({
    schemaVersion: 1, kind: 'observed-example', source: 'local-file',
    sha256: hash(bytes), valueDigest: hash(canonical(value)), byteLength: bytes.length,
    value, inference: 'none', requiredFields: 'unknown', compatibility: 'not-established',
  });
}
export async function compareJsonExamples(options: { readonly basePath: string; readonly revisionPath: string }): Promise<JsonExampleComparison> {
  const [base, revision] = await Promise.all([loadJsonExample(options.basePath), loadJsonExample(options.revisionPath)]);
  return freeze({
    schemaVersion: 1, kind: 'observed-example-comparison',
    base: { sha256: base.sha256, valueDigest: base.valueDigest }, revision: { sha256: revision.sha256, valueDigest: revision.valueDigest },
    contentChanged: base.sha256 !== revision.sha256, valueChanged: base.valueDigest !== revision.valueDigest,
    status: 'inconclusive', compatibility: 'not-established', inference: 'none', requiredFields: 'unknown',
    limitations: [
      'Examples do not declare required properties, all possible variants, constraints, or compatibility.',
      'Missing or added example fields are observations only; no schema or migration is inferred.',
    ],
  });
}
