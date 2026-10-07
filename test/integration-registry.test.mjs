import assert from 'node:assert/strict';
import test from 'node:test';
import { defineIntegrationBoundary, getIntegrationBoundary, normalizeIntegrationManifest } from '../dist/integration-registry.js';

// Fictional inventory: no assertion here describes a live provider's versions or support dates.
function fixture() {
  return {
    schemaVersion: 1,
    provider: 'Fixture provider',
    product: 'Orders',
    endpoints: [{ id: 'eu-test', url: 'https://api.example.test/orders/', environment: 'test' }],
    sources: [
      { id: 'api-schema', kind: 'openapi', location: { type: 'local', path: 'contracts/orders.json' },
        provenance: 'declared-contract', coverage: 'complete', sha256: 'a'.repeat(64), capturedAt: '2026-10-07T10:00:00.000Z' },
      { id: 'internal-contract', kind: 'json-schema', location: { type: 'local', path: 'contracts/internal.json' },
        provenance: 'declared-contract', coverage: 'complete' },
      { id: 'releases', kind: 'sdk-release', location: { type: 'https', url: 'https://docs.example.test/releases' },
        provenance: 'documentation-claim', coverage: 'partial' },
      { id: 'retirements', kind: 'documentation', location: { type: 'https', url: 'https://docs.example.test/retirements' },
        provenance: 'documentation-claim', coverage: 'unknown' },
      { id: 'lockfile', kind: 'sdk-release', location: { type: 'local', path: 'package-lock.json' },
        provenance: 'observed-behavior', coverage: 'complete' },
    ],
    knownVersions: [
      { id: 'api-2025', axis: 'api', value: '2025-01-01', sourceIds: ['api-schema'],
        scope: { operations: ['getOrder'], regions: ['eu'], marketplaces: ['test-marketplace'] },
        retirement: { date: '2027-01-01', sourceIds: ['retirements'] } },
      { id: 'sdk-4', axis: 'sdk', value: '4.0.0', sourceIds: ['releases'] },
    ],
    effectiveVersions: [
      { axis: 'api', value: '2025-01-01', selector: 'request-header', selectorName: 'Orders-Version',
        endpointId: 'eu-test', sourceIds: ['api-schema'], repositoryRevision: 'b'.repeat(40) },
      { axis: 'sdk', value: '3.5.0', selector: 'package', selectorName: '@fixture/orders', sourceIds: ['lockfile'] },
    ],
    boundaries: [{ id: 'get-order', inputContract: { sourceId: 'internal-contract', pointer: '/$defs/OrderId' },
      outputContract: { sourceId: 'internal-contract', pointer: '/$defs/Order' },
      requirements: [{ id: 'read-orders', kind: 'permission', description: 'Requires the documented read permission.', sourceIds: ['retirements'] }] }],
  };
}

function rejects(input) {
  assert.throws(() => normalizeIntegrationManifest(input), error => error.code === 'INVALID_INPUT');
}

test('inventory keeps SDK and effective API versions separate, without choosing the latest version', () => {
  const value = normalizeIntegrationManifest(fixture());
  assert.match(value.id, /^[a-f0-9]{64}$/u);
  assert.equal(value.versionCoverage, 'listed-only');
  assert.equal(value.knownVersions.find(version => version.axis === 'sdk').value, '4.0.0');
  assert.equal(value.effectiveVersions.find(version => version.axis === 'sdk').value, '3.5.0');
  assert.equal(value.effectiveVersions.find(version => version.axis === 'api').value, '2025-01-01');
  assert.equal(value.knownVersions.find(version => version.axis === 'api').retirement.date, '2027-01-01');
  assert.equal(value.boundaries[0].requirements[0].kind, 'permission');
  assert.equal(Object.hasOwn(value, 'adoptedVersion'), false);
  assert.equal(Object.hasOwn(value, 'deploymentStatus'), false);
});

test('equivalent object and inventory ordering produces the same digest, including normalized manifests', () => {
  const input = fixture();
  const first = normalizeIntegrationManifest(input);
  input.sources.reverse();
  input.knownVersions.reverse();
  input.effectiveVersions.reverse();
  const reordered = Object.fromEntries(Object.entries(input).reverse());
  assert.deepEqual(normalizeIntegrationManifest(reordered), first);
  assert.deepEqual(normalizeIntegrationManifest(first), first);
  input.product = 'A different product';
  assert.notEqual(normalizeIntegrationManifest(input).id, first.id);
});

test('support and retirement claims require evidence and retain an uncertain date', () => {
  const input = fixture();
  input.knownVersions[0].supportEnds = { date: '2026-12-01', sourceIds: ['retirements'] };
  input.knownVersions[0].retirement = { date: null, sourceIds: ['retirements'], note: 'Two published dates conflict; local review is required.' };
  const version = normalizeIntegrationManifest(input).knownVersions.find(item => item.id === 'api-2025');
  assert.equal(version.supportEnds.date, '2026-12-01');
  assert.equal(version.retirement.date, null);
  assert.equal(Object.hasOwn(version, 'retired'), false);
  input.knownVersions[0].retirement = { date: null, sourceIds: ['retirements'] };
  rejects(input);
  input.knownVersions[0].retirement = { date: '2027-01-01', sourceIds: [] };
  rejects(input);
  input.knownVersions[0].retirement = { date: '2027-01-01', sourceIds: ['not-registered'] };
  rejects(input);
});

for (const date of ['2027-02-29', '2026-02-30', '2026-13-01', 'tomorrow', '2026-01-01T00:00:00Z', '0000-00-00']) {
  test(`rejects a retirement date without a valid calendar meaning: ${date}`, () => {
    const input = fixture();
    input.knownVersions[0].retirement.date = date;
    rejects(input);
  });
}

test('a leap-day evidence date is accepted without computing runtime lifecycle state', () => {
  const input = fixture();
  input.knownVersions[0].retirement.date = '2028-02-29';
  assert.equal(normalizeIntegrationManifest(input).knownVersions[0].retirement.date, '2028-02-29');
});

test('unknown effective versions are explicit and are not guessed from known versions', () => {
  const input = fixture();
  input.effectiveVersions = [{ axis: 'api', value: null, sourceIds: [], selector: 'unknown', endpointId: 'eu-test' }];
  assert.equal(normalizeIntegrationManifest(input).effectiveVersions[0].value, null);
  input.effectiveVersions[0].value = 'latest';
  rejects(input);
});

test('package selectors cannot masquerade as API version selectors', () => {
  const input = fixture();
  input.effectiveVersions[0] = { axis: 'api', value: '4.0.0', sourceIds: ['releases'], selector: 'package', selectorName: '@fixture/orders' };
  rejects(input);
  input.effectiveVersions[0] = { axis: 'sdk', value: '4.0.0', sourceIds: ['releases'], selector: 'account' };
  rejects(input);
});

test('effective selectors require evidence, registered endpoints, and unique scope', () => {
  const input = fixture();
  input.effectiveVersions[0].sourceIds = [];
  rejects(input);
  input.effectiveVersions[0].sourceIds = ['api-schema'];
  input.effectiveVersions[0].endpointId = 'other-endpoint';
  rejects(input);
  input.effectiveVersions[0].endpointId = 'eu-test';
  input.effectiveVersions.push({ ...input.effectiveVersions[0], value: '2030-01-01' });
  rejects(input);
});

test('samples remain observations and cannot become declared boundary contracts', () => {
  const input = fixture();
  input.sources.push({ id: 'example', kind: 'json-sample', location: { type: 'local', path: 'fixtures/response.json' },
    provenance: 'observed-behavior', coverage: 'partial' });
  const normalized = normalizeIntegrationManifest(input);
  assert.equal(normalized.sources.find(source => source.id === 'example').kind, 'json-sample');
  input.boundaries[0].outputContract = { sourceId: 'example', pointer: '' };
  rejects(input);
  input.sources.at(-1).provenance = 'declared-contract';
  rejects(input);
});

test('source descriptors preserve MCP, framework, database, and advisory provenance without executing sources', () => {
  const input = fixture();
  for (const kind of ['mcp', 'framework-export', 'database-schema', 'security-advisory', 'changelog']) {
    input.sources.push({ id: kind, kind, location: { type: 'local', path: `sources/${kind}.json` },
      provenance: kind === 'mcp' ? 'observed-behavior' : 'documentation-claim', coverage: 'unknown' });
  }
  const normalized = normalizeIntegrationManifest(input);
  assert.equal(normalized.sources.length, 10);
  assert.equal(normalized.sources.find(source => source.id === 'mcp').coverage, 'unknown');
});

for (const unsafeUrl of [
  'https://user:private-secret@example.test/api', 'https://private-secret@example.test/api',
  'https://%75ser:%70rivate-secret@example.test/api', 'https://example.test/api?token=private-secret',
  'https://example.test/api#private-secret', 'https://example.test/api?', 'http://example.test/api',
  'file:///private-secret', 'https://example.test\\private-secret',
]) {
  test(`rejects credential-bearing or unsupported source URL (${unsafeUrl.split(':')[0]} profile)`, () => {
    const input = fixture();
    input.sources[2].location.url = unsafeUrl;
    assert.throws(() => normalizeIntegrationManifest(input), error =>
      error.code === 'INVALID_INPUT' && !error.message.includes('private-secret'));
  });
}

test('URLs normalize scheme, host, and default port without making network requests', () => {
  const input = fixture();
  input.endpoints[0].url = 'HTTPS://API.EXAMPLE.TEST:443/orders/';
  assert.equal(normalizeIntegrationManifest(input).endpoints[0].url, 'https://api.example.test/orders/');
  input.endpoints[0].url = 'https://example.test/?key=private-secret';
  rejects(input);
});

test('credentials cannot be supplied as additional fields or authorization header selectors', () => {
  const input = fixture();
  input.sources[0].credentials = 'private-secret';
  assert.throws(() => normalizeIntegrationManifest(input), error =>
    error.code === 'INVALID_INPUT' && !error.message.includes('private-secret'));
  delete input.sources[0].credentials;
  for (const header of ['Authorization', 'Cookie', 'X-Api-Key', 'Private-Token']) {
    input.effectiveVersions[0].selectorName = header;
    rejects(input);
  }
});

test('local source paths are declarations with bounded relative syntax', () => {
  for (const path of ['../private.json', '/private.json', 'D:/private.json', 'a/../b.json', 'a//b.json', 'a\\b.json', '*.json']) {
    const input = fixture();
    input.sources[0].location.path = path;
    rejects(input);
  }
});

test('boundary contracts require valid JSON pointers and known declared schemas', () => {
  const input = fixture();
  input.boundaries[0].outputContract.pointer = '/$defs/a~1b/~0name';
  assert.equal(normalizeIntegrationManifest(input).boundaries[0].outputContract.pointer, '/$defs/a~1b/~0name');
  for (const pointer of ['#/definitions/x', 'definitions/x', '/bad~2escape', '/bad~']) {
    input.boundaries[0].outputContract.pointer = pointer;
    rejects(input);
  }
  input.boundaries[0].outputContract = { sourceId: 'retirements', pointer: '' };
  rejects(input);
});

test('the manifest is an independent deeply immutable copy and its digest detects tampering', () => {
  const input = fixture();
  const normalized = normalizeIntegrationManifest(input);
  input.sources[0].location.path = 'changed.json';
  assert.equal(normalized.sources.find(source => source.id === 'api-schema').location.path, 'contracts/orders.json');
  assert.throws(() => { normalized.sources[0].location.path = 'changed.json'; }, TypeError);
  assert.throws(() => { normalized.boundaries[0].requirements.push({}); }, TypeError);
  const tampered = structuredClone(normalized);
  tampered.product = 'Another product';
  rejects(tampered);
});

test('unknown keys, symbols, and custom prototypes are rejected', () => {
  const input = fixture();
  input.unapprovedField = true;
  rejects(input);
  delete input.unapprovedField;
  input[Symbol('hidden')] = true;
  rejects(input);
  delete input[Reflect.ownKeys(input).find(key => typeof key === 'symbol')];
  Object.setPrototypeOf(input, { inherited: true });
  rejects(input);
  assert.ok(normalizeIntegrationManifest(Object.assign(Object.create(null), fixture())).id);
});

test('accessors, serialization hooks, and proxies are rejected without invocation', () => {
  let calls = 0;
  const input = fixture();
  Object.defineProperty(input, 'provider', { get() { calls += 1; return 'malicious'; } });
  rejects(input);
  const withHook = fixture();
  withHook.toJSON = () => { calls += 1; return fixture(); };
  rejects(withHook);
  const proxied = new Proxy(fixture(), { getPrototypeOf() { calls += 1; throw new Error('must not execute'); },
    ownKeys() { calls += 1; throw new Error('must not execute'); }, get() { calls += 1; throw new Error('must not execute'); } });
  rejects(proxied);
  const nested = fixture();
  nested.sources[0].location = new Proxy({}, { ownKeys() { calls += 1; return []; } });
  rejects(nested);
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  rejects(revoked.proxy);
  assert.equal(calls, 0);
});

test('array accessors, holes, extra keys, proxies, explicit nulls, and oversized collections are rejected', () => {
  let calls = 0;
  const input = fixture();
  Object.defineProperty(input.sources, '0', { get() { calls += 1; return {}; } });
  rejects(input);
  assert.equal(calls, 0);
  const hole = fixture(); delete hole.sources[0]; rejects(hole);
  const extra = fixture(); extra.sources.extra = true; rejects(extra);
  const proxied = fixture(); proxied.sources = new Proxy([], { get() { calls += 1; return 0; } }); rejects(proxied);
  const excessive = fixture(); excessive.knownVersions = Array.from({ length: 257 }, () => ({})); rejects(excessive);
  const tooLong = fixture(); tooLong.product = 'x'.repeat(129); rejects(tooLong);
  const nullEndpoints = fixture(); nullEndpoints.endpoints = null; rejects(nullEndpoints);
  const nullBoundaries = fixture(); nullBoundaries.boundaries = null; rejects(nullBoundaries);
  assert.equal(calls, 0);
});

test('duplicate source, version, endpoint, requirement, and boundary IDs are rejected', () => {
  for (const field of ['sources', 'knownVersions', 'endpoints', 'boundaries']) {
    const input = fixture();
    input[field].push(structuredClone(input[field][0]));
    rejects(input);
  }
  const input = fixture();
  input.boundaries[0].requirements.push(structuredClone(input.boundaries[0].requirements[0]));
  rejects(input);
});

test('canonical timestamps and source digests are validated', () => {
  for (const timestamp of ['2026-02-30T00:00:00.000Z', '2026-10-07T10:00:00Z', 'today', '2026-10-07T10:00:00.000+00:00']) {
    const input = fixture(); input.sources[0].capturedAt = timestamp; rejects(input);
  }
  const input = fixture(); input.sources[0].sha256 = 'A'.repeat(64); rejects(input);
});

test('registration returns the original function and preserves this, arguments, result, and own properties', () => {
  const input = fixture();
  const response = { total: 42 };
  const argument = { id: 'order-1' };
  const context = { context: true };
  function callOrder(first, second) {
    assert.equal(this, context);
    assert.equal(first, argument);
    assert.equal(second, undefined);
    assert.equal(arguments.length, 2);
    return response;
  }
  Object.defineProperty(callOrder, 'customProperty', { value: 'unchanged' });
  const originalDescriptors = Object.getOwnPropertyDescriptors(callOrder);
  const registered = defineIntegrationBoundary(input, callOrder);
  assert.equal(registered, callOrder);
  assert.equal(registered.call(context, argument, undefined), response);
  assert.deepEqual(Object.getOwnPropertyDescriptors(registered), originalDescriptors);
  assert.equal(getIntegrationBoundary(callOrder).boundaryId, 'get-order');
  assert.equal(getIntegrationBoundary(callOrder).manifest.id, normalizeIntegrationManifest(input).id);
});

test('registration preserves thrown errors, promise identity, and rejected errors', async () => {
  const error = new Error('original provider error');
  const failing = () => { throw error; };
  assert.throws(() => defineIntegrationBoundary(fixture(), failing)(), actual => actual === error);
  const promise = Promise.resolve({ id: 'original' });
  const asyncCall = () => promise;
  assert.equal(defineIntegrationBoundary(fixture(), asyncCall)(), promise);
  const rejected = Promise.reject(error);
  const rejectedCall = () => rejected;
  assert.equal(defineIntegrationBoundary(fixture(), rejectedCall)(), rejected);
  await assert.rejects(rejected, actual => actual === error);
});

test('registration accepts frozen functions and never validates, converts, or executes their arguments', () => {
  let calls = 0;
  const handler = Object.freeze(value => { calls += 1; return value; });
  const registered = defineIntegrationBoundary(fixture(), handler);
  assert.equal(calls, 0);
  const value = new Proxy({}, { get() { throw new Error('must not inspect arguments'); } });
  assert.equal(registered(value), value);
  assert.equal(calls, 1);
});

test('a registered boundary cannot silently change its contract or requirements', () => {
  const handler = () => {};
  const first = fixture();
  assert.equal(defineIntegrationBoundary(first, handler), handler);
  assert.equal(defineIntegrationBoundary(first, handler), handler);
  first.boundaries[0].requirements[0].description = 'Different permission scope';
  assert.throws(() => defineIntegrationBoundary(first, handler), error => error.code === 'INVALID_INPUT');
  assert.equal(getIntegrationBoundary(handler).manifest.boundaries[0].requirements[0].description, 'Requires the documented read permission.');
  assert.throws(() => { getIntegrationBoundary(handler).boundaryId = 'other'; }, TypeError);
});

test('explicit selection is required with multiple boundaries and unknown identifiers are rejected', () => {
  const input = fixture();
  input.boundaries.push({ id: 'list-orders', requirements: [] });
  const handler = () => {};
  assert.throws(() => defineIntegrationBoundary(input, handler), error => error.code === 'INVALID_INPUT');
  assert.throws(() => defineIntegrationBoundary(input, handler, 'missing'), error => error.code === 'INVALID_INPUT');
  assert.equal(defineIntegrationBoundary(input, handler, 'list-orders'), handler);
  assert.equal(getIntegrationBoundary(handler).boundaryId, 'list-orders');
  assert.equal(getIntegrationBoundary(() => {}), undefined);
});

test('proxy functions and nonfunctions cannot register integration metadata', () => {
  let calls = 0;
  const handler = new Proxy(() => {}, { get() { calls += 1; throw new Error('must not inspect proxy'); } });
  assert.throws(() => defineIntegrationBoundary(fixture(), handler), error => error.code === 'INVALID_INPUT');
  assert.throws(() => defineIntegrationBoundary(fixture(), {}), error => error.code === 'INVALID_INPUT');
  assert.equal(calls, 0);
});
