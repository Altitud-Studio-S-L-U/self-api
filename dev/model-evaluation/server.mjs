import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { modelFile, selectProfile } from './profile.mjs';

const root = resolve(import.meta.dirname, '../..'), parent = join(root, 'work/model-evaluation');
const [command, argument, profileName = '1.5b', ...extra] = process.argv.slice(2);
assert(!extra.length && ['start', 'stop'].includes(command) && (command !== 'stop' || process.argv.length === 4), 'Usage: node dev/model-evaluation/server.mjs start <port> [1.5b|7b] | stop <owned-server-directory>');
const profile = selectProfile(profileName), memoryGiB = profileName === '7b' ? 8 : 6;
const cpuLimit = profileName === '7b' ? 8 : 4;
async function docker(args) {
  return new Promise((done, reject) => {
    const child = spawn('docker', args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', size = 0;
    const timer = setTimeout(() => child.kill(), 30000);
    for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) stream.on('data', bytes => {
      size += bytes.length;
      if (size > 1024 * 1024) child.kill();
      else if (name === 'stdout') stdout += bytes; else stderr += bytes;
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? done(args[0] === 'logs' ? stdout + stderr : stdout) : reject(new Error(`Docker operation failed (${code}): ${stderr.slice(-4096)}`)); });
  });
}
async function cleanup(record) {
  if (record.proxy) {
    const proxy = JSON.parse(await docker(['inspect', record.proxy]))[0];
    assert.equal(proxy.Config.Labels['io.self-managed-api.model-server'], record.id);
    await docker(['rm', '-f', record.proxy]);
  }
  const container = JSON.parse(await docker(['inspect', record.container]))[0];
  assert.equal(container.Config.Labels['io.self-managed-api.model-server'], record.id);
  await docker(['rm', '-f', record.container]);
  const network = JSON.parse(await docker(['network', 'inspect', record.network]))[0];
  assert.equal(network.Labels['io.self-managed-api.model-server'], record.id); assert.equal(network.Internal, true);
  await docker(['network', 'rm', record.network]);
}
if (command === 'stop') {
  const directory = resolve(argument ?? '');
  assert.equal(dirname(directory), parent); assert.match(directory.slice(parent.length + 1), /^server-[0-9a-f-]{36}$/u);
  assert.equal(await realpath(directory), directory);
  const record = JSON.parse(await readFile(join(directory, 'server.json'), 'utf8'));
  assert.equal(record.kind, 'self-managed-api-local-model-server');
  await cleanup(record);
  console.log(JSON.stringify({ directory, status: 'stopped' }));
} else {
  const port = Number(argument);
  assert(Number.isInteger(port) && port >= 1024 && port <= 65535, 'Select an explicit unprivileged loopback port.');
  const modelPath = modelFile(root, profileName), hash = createHash('sha256');
  assert.equal((await stat(modelPath)).size, profile.byteLength);
  for await (const bytes of createReadStream(modelPath)) hash.update(bytes);
  assert.equal(hash.digest('hex'), profile.sha256, 'Only the already preloaded pinned model is supported.');
  for (const image of [profile.serverImage, profile.nodeImage]) await docker(['image', 'inspect', image]);
  const id = randomUUID(), directory = join(parent, `server-${id}`);
  await mkdir(parent, { recursive: true }); assert.equal(await realpath(parent), parent, 'Model server root must be canonical.');
  await mkdir(directory); assert.equal(await realpath(directory), directory);
  const record = { kind: 'self-managed-api-local-model-server', id, container: `self-managed-api-model-server-${id}`,
    network: `self-managed-api-model-private-${id}`, endpoint: `http://127.0.0.1:${port}/v1/chat/completions`, profile,
    cpuLimit, memoryLimitBytes: memoryGiB * 1024 ** 3, contextTokens: 16384, outputsAreUnapproved: true };
  await docker(['network', 'create', '--internal', '--label', `io.self-managed-api.model-server=${id}`, record.network]);
  let started = false;
  try {
    await docker(['run', '-d', '--pull=never', '--platform=linux/amd64', '--name', record.container,
      '--label', `io.self-managed-api.model-server=${id}`, '--network', record.network,
      '--read-only', '--user=65534:65534', '--cap-drop=ALL', '--security-opt=no-new-privileges=true',
      '--pids-limit=128', '--tmpfs=/tmp:rw,nosuid,nodev,size=64m,mode=1777', '--no-healthcheck',
      `--cpus=${cpuLimit}`, `--memory=${memoryGiB}g`, `--memory-swap=${memoryGiB}g`, '--env=XDG_CACHE_HOME=/tmp',
      '--mount', `type=bind,source=${modelPath},target=/models/model.gguf,readonly`, profile.serverImage,
      '--model', '/models/model.gguf', '--alias', profile.model, '--host', '0.0.0.0', '--port', '8080',
      '--ctx-size', String(record.contextTokens), '--parallel', '1', '--threads', String(cpuLimit), '--threads-batch', String(cpuLimit),
      '--n-gpu-layers', '0', '--seed', '42', '--temp', '0', '--offline', '--no-webui', '--metrics']);
    started = true;
    const config = JSON.parse(await docker(['inspect', record.container]))[0];
    assert.equal(config.HostConfig.ReadonlyRootfs, true); assert.equal(config.Config.User, '65534:65534');
    assert.equal(Object.keys(config.HostConfig.PortBindings ?? {}).length, 0);
    const address = config.NetworkSettings.Networks[record.network].IPAddress;
    assert.match(address, /^172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/u);
    const proxy = `self-managed-api-model-relay-${id}`;
    await docker(['run', '-d', '--pull=never', '--platform=linux/amd64', '--name', proxy,
      '--label', `io.self-managed-api.model-server=${id}`, '--network=bridge', '--publish', `127.0.0.1:${port}:8080`,
      '--read-only', '--user=65534:65534', '--cap-drop=ALL', '--security-opt=no-new-privileges=true',
      '--pids-limit=32', '--cpus=1', '--memory=128m', '--memory-swap=128m',
      '--env', `SELF_MANAGED_API_MODEL_UPSTREAM=http://${address}:8080`,
      '--mount', `type=bind,source=${join(import.meta.dirname, 'proxy.mjs')},target=/relay.mjs,readonly`, profile.nodeImage, 'node', '/relay.mjs']);
    record.proxy = proxy;
    await docker(['network', 'connect', record.network, proxy]);
    const proxyConfig = JSON.parse(await docker(['inspect', proxy]))[0];
    const bindings = proxyConfig.HostConfig.PortBindings['8080/tcp'];
    assert.equal(bindings.length, 1); assert.equal(bindings[0].HostIp, '127.0.0.1'); assert.equal(bindings[0].HostPort, String(port));
    const network = JSON.parse(await docker(['network', 'inspect', record.network]))[0]; assert.equal(network.Internal, true);
    const external = await docker(['run', '--rm', '--pull=never', '--platform=linux/amd64', `--network=container:${record.container}`,
      '--read-only', '--user=65534:65534', '--cap-drop=ALL', '--security-opt=no-new-privileges=true', '--pids-limit=32',
      '--cpus=1', '--memory=128m', profile.nodeImage, 'node', '--input-type=module', '-e',
      "import{createConnection}from'node:net';const c=createConnection({host:'1.1.1.1',port:443});c.setTimeout(1000);c.once('connect',()=>{c.destroy();process.exitCode=1});c.once('error',e=>{c.destroy();console.log(e.code)});c.once('timeout',()=>{c.destroy();console.log('timeout')});"]);
    assert.match(external.trim(), /^(ENETUNREACH|EHOSTUNREACH|timeout)$/u, 'The model namespace must not reach the external probe.');
    const deadline = performance.now() + 60000;
    while (true) {
      try { const health = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000), redirect: 'error' }); if (health.status === 200) break; }
      catch { /* Bounded readiness only; no model requests or inference retries. */ }
      assert(performance.now() < deadline, 'Loopback model did not become healthy within 60 seconds.'); await delay(250);
    }
    await writeFile(join(directory, 'server.json'), JSON.stringify({ ...record, externalProbe: external.trim(),
      inferenceNetwork: 'internal', relayNetwork: 'bridge+internal', relayUpstream: 'fixed-private-model-only' }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ directory, endpoint: record.endpoint, model: profile.model, status: 'ready', externalProbe: external.trim(), contextTokens: record.contextTokens }));
  } catch (error) {
    if (started) {
      // Retain bounded owned diagnostics before cleanup so transport readiness
      // and model-loading failure remain distinguishable.
      for (const [filename, args] of [
        ['server.log', ['logs', '--tail', '200', record.container]],
        ['server-inspect.json', ['inspect', record.container]],
        ['namespace-health.json', ['run', '--rm', '--pull=never', '--platform=linux/amd64', `--network=container:${record.container}`,
          '--read-only', '--user=65534:65534', '--cap-drop=ALL', '--security-opt=no-new-privileges=true', '--pids-limit=32',
          '--cpus=1', '--memory=128m', profile.nodeImage, 'node', '--input-type=module', '-e',
          "import{readFile}from'node:fs/promises';let health;try{const r=await fetch('http://127.0.0.1:8080/health',{signal:AbortSignal.timeout(3000),redirect:'error'});health={status:r.status}}catch(e){health={error:e.cause?.code??e.name}}console.log(JSON.stringify({health,routes:await readFile('/proc/net/route','utf8')}));"]],
      ]) {
        try { await writeFile(join(directory, filename), (await docker(args)).slice(-65536), { flag: 'wx', mode: 0o600 }); }
        catch { /* Original failure remains primary; diagnostics cannot imply readiness. */ }
      }
      console.error(JSON.stringify({ directory, status: 'failed', diagnostics: 'bounded-owned-files' }));
      await cleanup(record);
    }
    else await docker(['network', 'rm', record.network]);
    throw error;
  }
}
