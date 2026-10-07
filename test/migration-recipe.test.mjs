import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { previewRecipe } from '../dist/migration-recipe.js';
import { PlumberError } from '../dist/errors.js';

const hash = text => createHash('sha256').update(text, 'utf8').digest('hex');

test('rejects proxy-backed input without invoking traps', () => {
  const source = captured();
  let invoked = false;
  const handler = { getPrototypeOf() { invoked = true; return Object.prototype; }, get() { invoked = true; return []; } };
  invalid(() => previewRecipe(new Proxy(recipe(source), handler), [source]));
  const input = recipe(source);
  input.decisions = new Proxy(input.decisions, handler);
  invalid(() => previewRecipe(input, [source]));
  assert.equal(invoked, false);
});

function captured(text = 'export const parseOrder = (data: { total: number }) => ({ total: data.total });\n', path = 'src/orders.ts') {
  return { path, text, sha256: hash(text) };
}

function recipe(source = captured()) {
  return {
    schemaVersion: 1,
    summary: 'Fictional fixture: the documented replacement has the same unit and meaning.',
    decisions: [{ id: 'equivalence', question: 'Is the replacement semantically equivalent?', answer: 'The fictional migration guide explicitly guarantees it.' }],
    files: [{
      path: source.path,
      sha256: source.sha256,
      edits: [
        { before: '{ total: number }', after: '{ amount: number }' },
        { before: 'data.total', after: 'data.amount' },
      ],
    }],
  };
}

function invalid(action) {
  assert.throws(action, error => error instanceof PlumberError && error.code === 'INVALID_INPUT');
}

function frozen(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

test('previews explicit edits while preserving the internal field and all input objects', () => {
  const source = frozen(captured());
  const input = frozen(recipe(source));
  const files = frozen([source]);
  const original = JSON.stringify({ input, files });
  const result = previewRecipe(input, files);
  assert.equal(result.status, 'ready-for-review');
  assert.deepEqual(result.requirements, []);
  assert.deepEqual(result.files, [{
    path: source.path,
    beforeSha256: source.sha256,
    afterSha256: hash('export const parseOrder = (data: { amount: number }) => ({ total: data.amount });\n'),
    before: source.text,
    after: 'export const parseOrder = (data: { amount: number }) => ({ total: data.amount });\n',
  }]);
  assert.equal(JSON.stringify({ input, files }), original);
});

test('canonical recipe identity ignores object-key order and includes decision answers', () => {
  const source = captured();
  const input = recipe(source);
  const reordered = {
    files: input.files.map(file => ({ edits: file.edits.map(edit => ({ after: edit.after, before: edit.before })), sha256: file.sha256, path: file.path })),
    decisions: input.decisions.map(decision => ({ answer: decision.answer, question: decision.question, id: decision.id })),
    summary: input.summary,
    schemaVersion: input.schemaVersion,
  };
  const first = previewRecipe(input, [source]);
  assert.equal(previewRecipe(reordered, [source]).recipeSha256, first.recipeSha256);
  input.decisions[0].answer = 'A separately reviewed explicit decision.';
  assert.notEqual(previewRecipe(input, [source]).recipeSha256, first.recipeSha256);
});

test('unanswered decisions expose requirements and withhold every previewed file', () => {
  const source = captured();
  for (const answer of [undefined, '', '  \n']) {
    const input = recipe(source);
    input.decisions = [{ id: 'region', question: 'Which existing input provides the required region?', ...(answer === undefined ? {} : { answer }) }];
    const result = previewRecipe(input, [source]);
    assert.equal(result.status, 'requires-decision');
    assert.deepEqual(result.requirements, [{ id: 'region', question: 'Which existing input provides the required region?' }]);
    assert.deepEqual(result.files, []);
  }
});

test('rejects stale hashes, forged capture hashes, absent files, and duplicate captures', () => {
  const source = captured();
  const input = recipe(source);
  const stale = structuredClone(input);
  stale.files[0].sha256 = '0'.repeat(64);
  invalid(() => previewRecipe(stale, [source]));
  invalid(() => previewRecipe(input, [{ ...source, text: `${source.text}// changed\n` }]));
  invalid(() => previewRecipe(input, []));
  invalid(() => previewRecipe(input, [source, source]));
});

test('rejects missing or ambiguous matches, overlapping edits, and unchanged replacements', () => {
  const source = captured();
  for (const edits of [
    [{ before: 'data.missing', after: 'data.amount' }],
    [{ before: 'total', after: 'amount' }],
    [{ before: 'data.total', after: 'data.amount' }, { before: '.total', after: '.amount' }],
    [{ before: 'data.total', after: 'data.total' }],
    [{ before: '', after: 'new' }],
    [{ before: 'data.total', after: 'data.amount' }, { before: 'data.total', after: 'data.value' }],
  ]) {
    const input = recipe(source);
    input.files[0].edits = edits;
    invalid(() => previewRecipe(input, [source]));
  }
  const overlappingMatch = captured('export const label = "aaa";\n');
  const input = recipe(overlappingMatch);
  input.files[0].edits = [{ before: 'aa', after: 'b' }];
  invalid(() => previewRecipe(input, [overlappingMatch]));

  const unchanged = captured('export const value = "abcd";\n');
  const cancellation = recipe(unchanged);
  cancellation.files[0].edits = [{ before: 'ab', after: 'a' }, { before: 'cd', after: 'bcd' }];
  invalid(() => previewRecipe(cancellation, [unchanged]));
});

test('edits use original offsets and never cascade through replacement text', () => {
  const source = captured('export const labels = ["first", "second"];\n');
  const input = recipe(source);
  input.files[0].edits = [
    { before: '"second"', after: '"third"' },
    { before: '"first"', after: '"second"' },
  ];
  assert.equal(previewRecipe(input, [source]).files[0].after, 'export const labels = ["second", "third"];\n');
  input.files[0].edits = [
    { before: '"first"', after: '"new-value"' },
    { before: '"new-value"', after: '"third"' },
  ];
  invalid(() => previewRecipe(input, [source]));
});

test('restricts paths to captured source files and rejects traversal and package manifests', () => {
  for (const path of [
    '../orders.ts', 'src/../orders.ts', '/orders.ts', 'C:/orders.ts', 'src\\orders.ts',
    './orders.ts', 'src//orders.ts', 'orders.ts:stream', 'src/\0orders.ts',
    'package.json', 'pnpm-lock.yaml', 'tsconfig.json', '.npmrc', 'src/schema.json',
  ]) {
    const source = captured(undefined, path);
    invalid(() => previewRecipe(recipe(source), [source]));
  }
});

test('rejects unknown fields and duplicate file or decision identifiers', () => {
  const source = captured();
  for (const change of [
    input => { input.command = 'untrusted'; },
    input => { input.files[0].mode = 'write'; },
    input => { input.files[0].edits[0].regex = true; },
    input => { input.decisions[0].approved = true; },
    input => { input.files.push(structuredClone(input.files[0])); },
    input => { input.decisions.push(structuredClone(input.decisions[0])); },
    input => { input.files[0].sha256 = 'invalid'; },
    input => { input.schemaVersion = 2; },
    input => { delete input.decisions; },
    input => { input.files = []; },
    input => { input.files[0].edits = []; },
  ]) {
    const input = recipe(source);
    change(input);
    invalid(() => previewRecipe(input, [source]));
  }
  const input = recipe(source);
  let evaluated = false;
  Object.defineProperty(input, 'summary', { enumerable: true, get() { evaluated = true; return 'Unexpected execution'; } });
  invalid(() => previewRecipe(input, [source]));
  assert.equal(evaluated, false);
});

const recipeArrays = [
  ['decisions', input => input.decisions],
  ['files', input => input.files],
  ['edits', input => input.files[0].edits],
];

for (const [name, select] of recipeArrays) {
  test(`rejects indexed accessors in ${name} without evaluating them`, () => {
    const source = captured();
    const input = recipe(source);
    const array = select(input);
    const original = array[0];
    let evaluated = false;
    Object.defineProperty(array, '0', {
      enumerable: true,
      configurable: true,
      get() { evaluated = true; return original; },
    });
    invalid(() => previewRecipe(input, [source]));
    assert.equal(evaluated, false);
  });

  test(`rejects sparse ${name} instead of accepting holes or throwing an untyped error`, () => {
    const source = captured();
    const input = recipe(source);
    delete select(input)[0];
    invalid(() => previewRecipe(input, [source]));
  });

  test(`rejects an overridden map on ${name} without calling it`, () => {
    const source = captured();
    const input = recipe(source);
    let evaluated = false;
    select(input).map = function (...args) {
      evaluated = true;
      return Array.prototype.map.apply(this, args);
    };
    invalid(() => previewRecipe(input, [source]));
    assert.equal(evaluated, false);
  });

  test(`rejects unknown properties attached to ${name}`, () => {
    const source = captured();
    const input = recipe(source);
    select(input).unexpected = 'This field is not part of the recipe schema.';
    invalid(() => previewRecipe(input, [source]));
  });
}

test('rejects syntax errors without exposing parser errors or source contents', () => {
  const source = captured();
  const input = recipe(source);
  input.files[0].edits = [{ before: 'data.total', after: 'SECRET_FIXTURE(' }];
  assert.throws(() => previewRecipe(input, [source]), error => {
    assert.ok(error instanceof PlumberError);
    assert.equal(error.code, 'INVALID_INPUT');
    assert.doesNotMatch(error.message, /SECRET_FIXTURE|src\/orders/u);
    return true;
  });
});

test('parses supported source syntax directly without executing imports or configuration', () => {
  for (const [path, text] of [
    ['src/view.tsx', 'export const View = () => <span>old</span>;\n'],
    ['src/view.jsx', 'export const View = () => <span>old</span>;\n'],
    ['src/order.mts', 'export const value: string = "old";\n'],
    ['src/order.cts', 'const value: string = "old"; module.exports = value;\n'],
    ['src/order.mjs', 'import "not-installed"; export const value = "old";\n'],
    ['src/order.cjs', 'module.exports = "old";\n'],
    ['src/order.js', 'throw new Error("MUST_NOT_EXECUTE"); const value = "old";\n'],
  ]) {
    const source = captured(text, path);
    const input = recipe(source);
    input.files[0].edits = [{ before: 'old', after: 'new' }];
    const result = previewRecipe(input, [source]);
    assert.equal(result.status, 'ready-for-review');
    assert.equal(result.files[0].after, text.replace('old', 'new'));
  }
});

test('bounds recipe size, file count, total edits, and decisions', () => {
  const source = captured();
  for (const change of [
    input => { input.summary = 'x'.repeat(1024 * 1024); },
    input => { input.summary = '\0'.repeat(200_000); },
    input => { input.files = Array.from({ length: 51 }, (_, index) => ({ ...input.files[0], path: `src/file${index}.ts` })); },
    input => { input.files[0].edits = Array.from({ length: 101 }, (_, index) => ({ before: `old${index}`, after: `new${index}` })); },
    input => { input.decisions = Array.from({ length: 101 }, (_, index) => ({ id: `decision-${index}`, question: 'What is required?' })); },
  ]) {
    const input = recipe(source);
    change(input);
    invalid(() => previewRecipe(input, [source]));
  }
  const input = recipe(source);
  input.files = ['src/first.ts', 'src/second.ts'].map(path => ({
    path, sha256: source.sha256,
    edits: Array.from({ length: 51 }, (_, index) => ({ before: `old${index}`, after: `new${index}` })),
  }));
  invalid(() => previewRecipe(input, [source]));
});

test('accepts the documented recipe size, file count, and edit count boundaries', () => {
  const sources = Array.from({ length: 50 }, (_, index) => captured(undefined, `src/file${index}.ts`));
  const input = recipe(sources[0]);
  input.files = sources.map(source => recipe(source).files[0]);
  const overhead = Buffer.byteLength(JSON.stringify({ ...input, summary: '' }), 'utf8');
  input.summary = 'x'.repeat(1024 * 1024 - overhead);
  assert.equal(Buffer.byteLength(JSON.stringify(input), 'utf8'), 1024 * 1024);
  const result = previewRecipe(input, sources);
  assert.equal(result.status, 'ready-for-review');
  assert.equal(result.files.length, 50);
});
