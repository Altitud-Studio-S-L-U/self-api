import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { copyFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname, '../..'), output = process.argv[2] && resolve(process.argv[2]);
assert.equal(process.platform, 'linux', 'The actual SDK polyglot validation profiles require Linux x64.');
const pnpm = process.env.npm_execpath;
assert.ok(output && isAbsolute(pnpm ?? ''), 'Usage: pnpm dev:polyglot <new-owned-directory-outside-checkout>');
const within = (parent, child) => { const path = relative(parent, child); return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`)); };
assert.ok(!within(root, output), 'Choose an acceptance workspace outside the source checkout.');
const images = {
  python: 'python@sha256:f040863673aea2570c3ff6a5c3fb4c673a016cbc5375005ad145915922b6b78a',
  java: 'eclipse-temurin@sha256:51ae87bbb1949c1afdff51f6a3e6c5f283d84a4bd68512c9657fdc6605026a49',
};
const runId = randomUUID(), ownerLabel = `io.keepseam.polyglot=${runId}`;
const outcomes = [];

async function run(command, args, cwd, expected = 0, timeout = 60000) {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true, env: { ...process.env, COREPACK_ENABLE_NETWORK: '0', npm_config_offline: 'true', npm_config_update_notifier: 'false', PYTHONDONTWRITEBYTECODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', bytes = 0;
    const timer = setTimeout(() => child.kill(), timeout);
    const collect = target => chunk => { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) child.kill(); else if (target === 'stdout') stdout += chunk; else stderr += chunk; };
    child.stdout.on('data', collect('stdout')); child.stderr.on('data', collect('stderr'));
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (signal || bytes > 4 * 1024 * 1024) { reject(new Error('Acceptance process exceeded its time/output limit')); return; }
      if (expected !== null && code !== expected) { reject(new Error(`Acceptance process exited ${code}, expected ${expected}:\n${stdout}\n${stderr}`)); return; }
      resolveProcess({ code, stdout, stderr });
    });
  });
}

function contract(version) {
  const properties = version === 'A' ? { id: { type: 'string' }, amount_minor: { type: 'integer' }, currency: { type: 'string' } }
    : { id: { type: 'string' }, money: { type: 'object', required: ['value', 'currency'], properties: { value: { type: 'string' }, currency: { type: 'string' } } } };
  return { openapi: '3.0.3', info: { title: 'Synthetic polyglot payments provider', version }, paths: {
    '/payments/{id}': { get: { operationId: 'getPayment', parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }], responses: {
      200: { description: 'Synthetic payment', content: Object.fromEntries(['application/json', 'application/xml'].map(media => [media, { schema: { type: 'object', required: Object.keys(properties), properties } }])) },
    } } },
  } };
}

async function captureContracts() {
  let version = 'A';
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/openapi.json') { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(contract(version)));
  });
  await new Promise(resolveListening => server.listen(0, '127.0.0.1', resolveListening));
  try {
    const endpoint = `http://127.0.0.1:${server.address().port}/openapi.json`;
    for (version of ['A', 'B']) {
      const response = await fetch(endpoint, { redirect: 'error', signal: AbortSignal.timeout(3000) });
      assert.equal(response.status, 200);
      const raw = Buffer.from(await response.arrayBuffer());
      assert.ok(raw.length < 65536); assert.equal(JSON.parse(raw).info.version, version);
      await writeFile(join(output, 'contracts', `${version}.json`), raw, { flag: 'wx' });
    }
  } finally { server.closeAllConnections(); await new Promise(resolveClosed => server.close(resolveClosed)); }
}

await mkdir(output, { recursive: false });
assert.equal(await realpath(output), output, 'Use a canonical owned output directory');
const runtime = join(output, 'runtime');
await mkdir(runtime); await mkdir(join(output, 'contracts'));
await writeFile(join(output, 'acceptance-owner.json'), JSON.stringify({ runId, kind: 'keepseam-polyglot-acceptance', syntheticProvider: true, output }, null, 2), { flag: 'wx' });
await run(process.execPath, [pnpm, 'pack', '--out', join(output, 'keepseam-client.tgz')], root);
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
await writeFile(join(runtime, 'package.json'), JSON.stringify({ name: 'keepseam-polyglot-acceptance-runtime', private: true, type: 'module', packageManager: manifest.packageManager, dependencies: { 'keepseam-client': 'file:../keepseam-client.tgz' } }), { flag: 'wx' });
await run(process.execPath, [pnpm, 'install', '--offline', '--ignore-scripts', '--ignore-workspace'], runtime);
await copyFile(join(import.meta.dirname, 'sdk-probe.mjs'), join(runtime, 'sdk-probe.mjs'));
for (const language of ['python', 'java']) {
  for (const revision of ['baseline', 'candidate']) {
    const consumer = join(output, `${language}-${revision}`); await mkdir(consumer);
    const source = language === 'python' ? 'payment_client.py' : 'PaymentClient.java', test = language === 'python' ? 'test_payment.py' : 'PaymentTest.java';
    await copyFile(join(import.meta.dirname, language, revision, source), join(consumer, source));
    await copyFile(join(import.meta.dirname, language, test), join(consumer, test));
  }
}
await captureContracts();
const engine = process.env.KEEPSEAM_ENGINE ?? join(root, 'work/tools/oasdiff', process.platform === 'win32' ? 'oasdiff.exe' : 'oasdiff');
await run(process.execPath, [join(runtime, 'sdk-probe.mjs'), output, engine, root], runtime);
for (const [language, image] of Object.entries(images)) {
 await run('docker', ['image', 'inspect', image], root);
 for (const [revision, providerVersion, expected] of [['baseline', 'A', 0], ['baseline', 'B', 1], ['candidate', 'B', 0]]) {
  const name = `keepseam-polyglot-${runId}-${language}-${revision}-${providerVersion.toLowerCase()}`;
  try {
    const command = language === 'python'
      ? ['--entrypoint=/usr/local/bin/python3', image, '-B', 'test_payment.py', providerVersion]
      : ['--entrypoint=/bin/sh', image, '-c', 'mkdir /tmp/classes && javac -J-Xmx256m -proc:none --add-modules jdk.httpserver -d /tmp/classes PaymentClient.java PaymentTest.java && java -ea -Xmx256m --add-modules jdk.httpserver -cp /tmp/classes PaymentTest "$1"', 'fixture', providerVersion];
    const consumer = await run('docker', ['run', '--rm', '--name', name, '--label', ownerLabel, '--pull=never', '--platform=linux/amd64', '--network=none', '--read-only', '--user=65534:65534', '--cap-drop=ALL', '--security-opt=no-new-privileges=true', '--cpus=1', '--memory=512m', '--memory-swap=512m', '--pids-limit=128', '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777', '--mount', `type=bind,source=${join(output, `${language}-${revision}`)},target=/workspace,readonly`, '--workdir=/workspace', ...command], root, expected, 30000);
    if (expected === 1) assert.match(consumer.stderr, language === 'python' ? /KeyError: 'amount_minor'/u : /Expected amount_minor exactly once/u, 'Baseline must fail on the changed parser contract, not missing infrastructure');
    await writeFile(join(output, `${language}-${revision}-${providerVersion}.txt`), consumer.stdout + consumer.stderr, { flag: 'wx' });
    outcomes.push({ language, revision, providerVersion, exitCode: consumer.code });
  } finally {
    const inspected = await run('docker', ['container', 'inspect', name], root, null);
    if (inspected.code === 0) {
      const [container] = JSON.parse(inspected.stdout);
      assert.equal(container.Config.Labels['io.keepseam.polyglot'], runId); assert.equal(container.Name, '/' + name);
      await run('docker', ['rm', '--force', name], root);
    }
    const removed = await run('docker', ['container', 'inspect', name], root, null);
    assert.notEqual(removed.code, 0, 'The owned acceptance container must be removed');
    assert.match(removed.stderr, /No such (?:object|container)/iu, 'Cleanup must be verified against the available daemon');
  }
 }
}
for (const [language, test] of [['python', 'test_payment.py'], ['java', 'PaymentTest.java']]) {
  assert.deepEqual(await readFile(join(output, `${language}-baseline`, test)), await readFile(join(output, `${language}-candidate`, test)), 'Selected tests must remain unchanged');
}
const summary = { schemaVersion: 1, syntheticProvider: true, sdk: JSON.parse(await readFile(join(output, 'sdk-observation.json'), 'utf8')), consumerTests: outcomes,
  migrationAuthor: 'manually-reviewed-fixture', sdkMigratedConsumer: false, sdkExecutedPolyglotValidation: true,
  javaImage: images.java, pythonImage: images.python,
  artifactSha256: createHash('sha256').update(await readFile(join(output, 'keepseam-client.tgz'))).digest('hex') };
await writeFile(join(output, 'acceptance.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
