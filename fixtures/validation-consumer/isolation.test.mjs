import assert from 'node:assert/strict';
import { access, readFile, unlink, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { networkInterfaces } from 'node:os';
import test from 'node:test';

test('the consumer and root filesystem are read-only while bounded temporary space is writable', async () => {
  const mounts = (await readFile('/proc/self/mountinfo', 'utf8')).trim().split('\n').map(line => {
    const [details, type] = line.split(' - ');
    const fields = details.split(' ');
    return { path: fields[4], options: fields[5].split(','), type: type.split(' ')[0] };
  });
  assert.ok(mounts.find(mount => mount.path === '/workspace')?.options.includes('ro'));
  assert.ok(mounts.find(mount => mount.path === '/')?.options.includes('ro'));
  const temporary = mounts.find(mount => mount.path === '/tmp');
  assert.equal(temporary?.type, 'tmpfs');
  for (const option of ['rw', 'noexec', 'nosuid', 'nodev']) assert.ok(temporary.options.includes(option));
  const denied = error => ['EROFS', 'EACCES'].includes(error.code);
  await assert.rejects(writeFile(new URL('./forbidden-write.txt', import.meta.url), 'changed'), denied);
  await assert.rejects(writeFile('/forbidden-root-write.txt', 'changed'), denied);
  const scratch = `/tmp/plumber-isolation-${process.pid}.txt`;
  await writeFile(scratch, 'temporary fixture data');
  assert.equal(await readFile(scratch, 'utf8'), 'temporary fixture data');
  await unlink(scratch);
});

test('the Linux CI cgroup v2 exposes the declared CPU, memory, swap, and process limits', async () => {
  // This controlled CI fixture requires cgroup v2; it does not verify cgroup v1 hosts.
  await assert.doesNotReject(access('/sys/fs/cgroup/cgroup.controllers'),
    'This isolation fixture requires cgroup v2; cgroup v1 is outside its verified profile.');
  const limit = async name => (await readFile(`/sys/fs/cgroup/${name}`, 'utf8')).trim();
  assert.equal(await limit('memory.max'), String(512 * 1024 * 1024));
  assert.equal(await limit('memory.swap.max'), '0');
  assert.equal(await limit('pids.max'), '128');
  const cpu = (await limit('cpu.max')).split(/\s+/u);
  assert.equal(cpu.length, 2);
  assert.match(cpu[0], /^\d+$/u);
  assert.match(cpu[1], /^\d+$/u);
  assert.ok(BigInt(cpu[1]) > 0n);
  assert.equal(BigInt(cpu[0]), BigInt(cpu[1]), 'CPU quota must allow exactly one CPU per period.');
});

test('the running process has no effective capabilities and enforces no-new-privileges and seccomp', async () => {
  const status = await readFile('/proc/self/status', 'utf8');
  const effective = status.match(/^CapEff:\s*([a-f0-9]+)$/imu)?.[1];
  assert.ok(effective, 'The kernel must expose effective process capabilities.');
  assert.equal(BigInt(`0x${effective}`), 0n);
  assert.equal(status.match(/^NoNewPrivs:\s*(\d+)$/mu)?.[1], '1');
  assert.equal(status.match(/^Seccomp:\s*(\d+)$/mu)?.[1], '2');
});

test('the container has no external network interface or reachable external socket', async () => {
  const external = Object.values(networkInterfaces()).flat().filter(address => address && !address.internal);
  assert.deepEqual(external, []);
  await new Promise((resolve, reject) => {
    const socket = createConnection({ host: '1.1.1.1', port: 443 });
    socket.once('connect', () => { socket.destroy(); reject(new Error('An external network connection unexpectedly succeeded.')); });
    socket.once('error', () => { socket.destroy(); resolve(); });
    socket.setTimeout(1000, () => { socket.destroy(); resolve(); });
  });
});

test('host secrets and Docker control sockets are not available to consumer tests', async () => {
  assert.equal(process.env.PLUMBER_HOST_SECRET, undefined);
  assert.equal(process.env.DOCKER_HOST, undefined);
  assert.equal(process.getuid(), 65534);
  for (const socket of ['/var/run/docker.sock', '/run/docker.sock']) {
    await assert.rejects(access(socket), error => ['ENOENT', 'EACCES'].includes(error.code));
  }
});
