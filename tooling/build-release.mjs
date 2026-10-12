import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile, chmod, rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { inject } from 'postject';
import engine from '../src/oasdiff-release.json' with { type: 'json' };
import { assertReleaseRuntime } from './release-runtime.mjs';
import { nativeSigningReceipt } from './native-signing.mjs';

assertReleaseRuntime(process.versions.node);
const run = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const info = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const platform = `${process.platform}-${process.arch}`;
const asset = engine.assets[platform];
assert(asset, `Unsupported release platform: ${platform}`);
assert(process.env.npm_execpath, 'Run through pnpm release:build');
const output = join(root, 'work', 'releases');
const staging = join(output, `build-${randomUUID()}`);
const bundle = join(staging, `keepseam-${info.version}-${platform}`);
const library = join(bundle, 'lib');
const childEnv = { ...process.env };
for (const name of Object.keys(childEnv)) if (name.startsWith('npm_') || name.startsWith('PNPM_') || name === 'INIT_CWD') delete childEnv[name];
await mkdir(library, { recursive: true });
const pnpm = args => run(process.execPath, [process.env.npm_execpath, ...args], { cwd: root, windowsHide: true, maxBuffer: 1024 * 1024 });
await run(process.execPath, ['tooling/build-docs.mjs', '--check'], { cwd: root, windowsHide: true });
await copyFile(join(root, 'docs', 'technical-guide.pdf'), join(bundle, 'technical-guide.pdf'));
await pnpm(['pack', '--pack-destination', staging]);
const archive = join(staging, `${info.name}-${info.version}.tgz`);
await writeFile(join(library, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: { [info.name]: `file:${archive.replaceAll('\\', '/')}` } }));
// A dereferenced isolated pnpm tree loses the dependency siblings of its virtual package.
await run(process.execPath, [process.env.npm_execpath, '--dir', library, '--ignore-workspace', 'install', '--prod', '--offline', '--ignore-scripts', '--node-linker=hoisted'], { cwd: library, env: childEnv, windowsHide: true, maxBuffer: 1024 * 1024 });
// Materialize pnpm links so the extracted archive never depends on a store or checkout.
const materialized = join(staging, 'materialized');
await cp(join(library, 'node_modules'), materialized, { recursive: true, dereference: true });
await rename(join(library, 'node_modules'), join(staging, 'installation-links'));
await rename(materialized, join(library, 'node_modules'));
await writeFile(join(library, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: { [info.name]: info.version } }));
await mkdir(join(bundle, 'engine'));
await copyFile(join(root, 'work', 'tools', 'oasdiff', asset.binaryName), join(bundle, 'engine', asset.binaryName));
await copyFile(join(root, 'work', 'tools', 'oasdiff', 'LICENSE'), join(bundle, 'engine', 'LICENSE'));
const executable = join(bundle, process.platform === 'win32' ? 'keepseam.exe' : 'keepseam');
const blob = join(staging, 'sea.blob');
const config = join(staging, 'sea.json');
await writeFile(config, JSON.stringify({ main: join(root, 'tooling', 'sea-entry.cjs'), output: blob, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false, execArgvExtension: 'none' }));
await run(process.execPath, ['--experimental-sea-config', config], { windowsHide: true });
await copyFile(process.execPath, executable);
if (process.platform === 'darwin') await run('codesign', ['--remove-signature', executable]);
await inject(executable, 'NODE_SEA_BLOB', await readFile(blob), { sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2', ...(process.platform === 'darwin' ? { machoSegmentName: 'NODE_SEA' } : {}) });
if (process.platform === 'darwin') await run('codesign', ['--sign', '-', executable]);
await chmod(executable, 0o755);
const nativeSignature=await nativeSigningReceipt(executable);
// Node distributions carry their own notices; obtain the exact runtime's license explicitly.
const licenseResponse = await fetch(`https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`, { signal: AbortSignal.timeout(20000) });
assert(licenseResponse.ok, 'Node runtime license unavailable');
await writeFile(join(bundle, 'NODE-LICENSE'), await licenseResponse.text());
const signingNotice = nativeSignature.verified && nativeSignature.publisher
  ? `Native publisher verification: ${nativeSignature.kind}; ${nativeSignature.publisher}.`
  : process.platform === 'win32' ? 'Windows executable has no verified publisher signature.'
    : process.platform === 'darwin' ? 'macOS executable is ad-hoc signed, not notarized.'
      : 'Linux archive authenticity requires the separately trusted signed release metadata.';
await writeFile(join(bundle, 'INSTALL.txt'), `Keepseam ${info.version}\nExtract this entire directory. Keep keepseam and lib together.\nNo Node installation is required. Use: keepseam --help\nContract comparison uses --engine <this-directory>/engine/${asset.binaryName}.\nConsumer validation requires the documented Linux x64 Docker profiles.\n${signingNotice}\nAutomatic worker services require a signed Cloud license; manual SDK tools remain available locally.\nSDK package remains separately version-pinned.\n`);
const archiveName = `keepseam-${info.version}-${platform}.tar.gz`;
const stagedArchive = join(staging, archiveName);
await run('tar', ['-czf', stagedArchive, '-C', staging, `keepseam-${info.version}-${platform}`], { windowsHide: true });
const temporaryRoot = await realpath(tmpdir());
const verification = await mkdtemp(join(temporaryRoot, 'keepseam-release-'));
try {
  // Checkout dependencies previously hid a broken portable dependency layout.
  const fromCheckout = relative(root, verification);
  assert(fromCheckout === '..' || fromCheckout.startsWith('..' + sep) || isAbsolute(fromCheckout), 'Release verification must run outside the checkout.');
  await run('tar', ['-xzf', stagedArchive, '-C', verification], { windowsHide: true });
  const installed = join(verification, `keepseam-${info.version}-${platform}`);
  const installedExecutable = join(installed, process.platform === 'win32' ? 'keepseam.exe' : 'keepseam');
  const verificationEnv = { ...childEnv };
  delete verificationEnv.NODE_OPTIONS;
  delete verificationEnv.NODE_PATH;
  const options = { cwd: verification, env: verificationEnv, windowsHide: true, timeout: 20_000 };
  const help = await run(installedExecutable, ['--help'], options);
  assert(help.stdout.startsWith('Usage:'), 'Extracted executable did not start');
  const compare = revision => ['compare', join(root, 'fixtures', 'orders-v1.json'), join(root, 'fixtures', revision), '--engine', join(installed, 'engine', asset.binaryName), '--json'];
  const comparison = await run(installedExecutable, compare('orders-v1.json'), options);
  assert.equal(JSON.parse(comparison.stdout).status, 'no-breaking-changes');
  await assert.rejects(run(installedExecutable, compare('orders-v2.json'), options), error => {
    assert.equal(error.code, 1, 'Breaking comparison must use its documented exit code.');
    const report = JSON.parse(error.stdout);
    assert.equal(report.status, 'breaking-changes');
    assert(report.changes.some(change => change.id.includes('required') && change.text.includes('region')));
    assert(report.changes.some(change => change.id.includes('property') && change.text.includes('total')));
    return true;
  });
  assert.deepEqual(await readFile(join(installed, 'technical-guide.pdf')), await readFile(join(root, 'docs', 'technical-guide.pdf')));
  await readFile(join(installed, 'NODE-LICENSE'));
} finally {
  const owned = await realpath(verification);
  assert.equal(dirname(owned), temporaryRoot, 'Refuse cleanup outside the temporary release parent.');
  assert(basename(owned).startsWith('keepseam-release-'), 'Refuse cleanup of an unrelated temporary directory.');
  await rm(owned, { recursive: true, force: true });
}
const digest = createHash('sha256').update(await readFile(stagedArchive)).digest('hex');
await copyFile(stagedArchive, join(output, archiveName));
if (process.platform === 'linux' && process.arch === 'x64') await copyFile(archive, join(output, `${info.name}-${info.version}.tgz`));
await writeFile(join(output, `${archiveName}.sha256`), `${digest}  ${archiveName}\n`);
await writeFile(join(output,`${archiveName}.signing.json`),JSON.stringify({schemaVersion:1,fileName:archiveName,archiveSha256:digest,executableSha256:createHash('sha256').update(await readFile(executable)).digest('hex'),nativeSignature},null,2)+'\n');
console.log(JSON.stringify({ archive: archiveName, sha256: digest, node: process.versions.node, engine: engine.version, smoke: 'extracted archive outside checkout: help, unchanged and breaking comparisons passed' }));
