import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import release from '../src/oasdiff-release.json' with { type: 'json' };

const runFile = promisify(execFile);
const maxArchiveBytes = 80 * 1024 * 1024;
const allowedDownloadHosts = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
const projectRoot = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '..'));

function samePath(left, right) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function assertChild(parent, candidate) {
  const child = relative(parent, candidate);
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error(`Refusing a path outside the installer directory: ${candidate}`);
  }
}

async function assertDirectory(path) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await realpath(path), resolve(path))) {
    throw new Error(`Installer directories must be real directories without symlinks: ${path}`);
  }
}

async function ensureDirectory(parent, name) {
  const path = join(parent, name);
  assertChild(parent, path);
  await assertDirectory(parent);
  try {
    await mkdir(path);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  await assertDirectory(path);
  return path;
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function downloadArchive(url, destination) {
  const signal = AbortSignal.timeout(60_000);
  let response;
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (url.protocol !== 'https:' || url.username || url.password || !allowedDownloadHosts.has(url.hostname)) {
      throw new Error('The release download redirected to an unsupported destination.');
    }
    response = await fetch(url, {
      signal,
      redirect: 'manual',
      credentials: 'omit',
      headers: { 'User-Agent': 'keepseam-engine-setup', Accept: 'application/octet-stream' },
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    await response.body?.cancel();
    const location = response.headers.get('location');
    if (!location || redirects === 5) throw new Error('The release download exceeded its redirect limit.');
    url = new URL(location, url);
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`The official release download failed with HTTP ${response.status}.`);
  }
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && Number(declaredLength) > maxArchiveBytes) {
    await response.body.cancel();
    throw new Error('The release archive exceeds the 80 MiB limit.');
  }
  let bytes = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > maxArchiveBytes ? new Error('The release archive exceeds the 80 MiB limit.') : null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body), limiter, createWriteStream(destination, { flags: 'wx' }), { signal });
  if (bytes === 0) throw new Error('The release archive was empty.');
}

function childEnvironment(temporaryDirectory) {
  const environment = { TMP: temporaryDirectory, TEMP: temporaryDirectory, TMPDIR: temporaryDirectory };
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'PATHEXT']) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  return environment;
}

async function assertRegularFile(path, allowMissing = false) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error(`Refusing a non-regular or linked installer file: ${path}`);
    }
  } catch (error) {
    if (!(allowMissing && error.code === 'ENOENT')) throw error;
  }
}

async function removeOwnedTemporaryDirectory(toolsRoot, temporaryDirectory) {
  assertChild(toolsRoot, temporaryDirectory);
  if (dirname(temporaryDirectory) !== toolsRoot || !basename(temporaryDirectory).startsWith('.install-')) {
    throw new Error('Refusing to clean a directory not created by this installer.');
  }
  await assertDirectory(toolsRoot);
  await assertDirectory(temporaryDirectory);
  assertChild(await realpath(toolsRoot), await realpath(temporaryDirectory));
  await rm(temporaryDirectory, { recursive: true });
}

export async function setupOasdiff() {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Engine setup requires Node.js 24 or later.');
  const platform = `${process.platform}-${process.arch}`;
  const asset = release.assets[platform];
  if (!asset) throw new Error(`No pinned oasdiff release is configured for ${platform}.`);
  if (!/^\d+\.\d+\.\d+$/.test(release.version) || !['oasdiff', 'oasdiff.exe'].includes(asset.binaryName) || basename(asset.fileName) !== asset.fileName || !/^[a-f0-9]{64}$/.test(asset.sha256)) {
    throw new Error('The checked-in oasdiff release manifest is invalid.');
  }

  const workRoot = await ensureDirectory(projectRoot, 'work');
  const toolsRoot = await ensureDirectory(workRoot, 'tools');
  const temporaryDirectory = await mkdtemp(join(toolsRoot, '.install-'));
  try {
    await assertDirectory(temporaryDirectory);
    const archive = join(temporaryDirectory, asset.fileName);
    const url = new URL(`https://github.com/oasdiff/oasdiff/releases/download/v${release.version}/${asset.fileName}`);
    console.log(`Downloading pinned oasdiff ${release.version} for ${platform}...`);
    await downloadArchive(url, archive);
    if (await sha256(archive) !== asset.sha256) throw new Error('The release archive SHA-256 does not match the checked-in manifest.');

    const options = { shell: false, windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024, cwd: temporaryDirectory, env: childEnvironment(temporaryDirectory) };
    const { stdout: listing } = await runFile('tar', ['-tzf', archive], options);
    const entries = listing.split(/\r?\n/).filter(Boolean);
    const selectedFiles = [asset.binaryName, 'LICENSE'];
    for (const file of selectedFiles) {
      if (entries.filter(entry => entry === file).length !== 1) {
        throw new Error(`The release archive must contain exactly one top-level ${file}.`);
      }
    }
    await runFile('tar', ['-xzf', archive, '-C', temporaryDirectory, '--', ...selectedFiles], options);
    for (const file of selectedFiles) await assertRegularFile(join(temporaryDirectory, file));

    const stagedBinary = join(temporaryDirectory, asset.binaryName);
    if (asset.binarySha256 && await sha256(stagedBinary) !== asset.binarySha256) {
      throw new Error('The extracted binary SHA-256 does not match the checked-in manifest.');
    }
    if (process.platform !== 'win32') await chmod(stagedBinary, 0o755);
    const { stdout, stderr } = await runFile(stagedBinary, ['--version'], { ...options, timeout: 10_000, maxBuffer: 64 * 1024 });
    if (stdout.trim() !== `oasdiff version ${release.version}` || stderr.trim()) {
      throw new Error('The extracted binary did not report the pinned oasdiff version.');
    }

    const destination = await ensureDirectory(toolsRoot, 'oasdiff');
    for (const file of selectedFiles) await assertRegularFile(join(destination, file), true);
    // The executable is replaced last, after verification; unrelated destination files remain untouched.
    await rename(join(temporaryDirectory, 'LICENSE'), join(destination, 'LICENSE'));
    await rename(stagedBinary, join(destination, asset.binaryName));
    console.log(`oasdiff ${release.version} ready: ${join(destination, asset.binaryName)}`);
  } finally {
    await removeOwnedTemporaryDirectory(toolsRoot, temporaryDirectory);
  }
}

if (process.argv[1] && samePath(await realpath(process.argv[1]), fileURLToPath(import.meta.url))) {
  try {
    await setupOasdiff();
  } catch (error) {
    console.error(`Engine setup failed: ${error.message}`);
    process.exitCode = 1;
  }
}
