import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { FRAMEWORK_BASE_IMAGES, MAVEN_ARTIFACT, MAVEN_FIXTURE_POM, MAVEN_REPORT_CHECK,
  PYTEST_ARTIFACTS, runtimeRecipeSha256, validateRuntime } from './validation-runtime.js';
import type { ValidationFramework, ValidationRuntime } from './validation-runtime.js';

/** Preparation has network access to official registries; customer projects never enter this build. */
export async function prepareValidationRuntime(kind: ValidationFramework, output: string): Promise<ValidationRuntime> {
  if (!['pytest', 'maven-junit'].includes(kind)) throw new Error('Choose pytest or maven-junit.');
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Prepared validation requires a Linux x64 host with local Docker.');
  const destination = resolve(output);
  try { await lstat(destination); throw new Error('Choose a new runtime manifest path; existing approvals must retain their exact runtime.'); }
  catch (error) { if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error; }
  await mkdir(dirname(destination), { recursive: true });
  const context = await mkdtemp(join(dirname(destination), '.self-managed-api-runtime-'));
  const id = randomUUID();
  const tag = `self-managed-api-validation-preparation:${id}`;
  const finalTag = `self-managed-api-validation:${id}`;
  let preparationCreated = false;
  let finalCreated = false;
  let manifestSaved = false;
  const docker = (...args: string[]) => execFileSync('/usr/bin/docker', ['--host', 'unix:///var/run/docker.sock', ...args],
    { encoding: 'utf8', timeout: 600_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const artifact = async (definition: { readonly url: string; readonly name?: string; readonly sha256?: string; readonly sha512?: string }) => {
    const response = await fetch(definition.url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Official artifact unavailable: ${definition.name ?? 'maven'} (${response.status}).`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 32 * 1024 * 1024) throw new Error('Preparation artifact exceeds its bound.');
    const algorithm = definition.sha512 ? 'sha512' : 'sha256';
    if (createHash(algorithm).update(bytes).digest('hex') !== definition[algorithm]) throw new Error('Official artifact checksum mismatch.');
    const name = basename(new URL(definition.url).pathname);
    await writeFile(join(context, name), bytes, { flag: 'wx' });
    return name;
  };
  try {
    let setup: string;
    if (kind === 'pytest') {
      const names: string[] = [];
      for (const definition of PYTEST_ARTIFACTS) names.push(await artifact(definition));
      setup = `COPY *.whl /opt/self-managed-api/wheels/\nRUN python3 -m pip install --no-index --no-deps ${names.map(name => `/opt/self-managed-api/wheels/${name}`).join(' ')}\n`;
    } else {
      const archive = await artifact(MAVEN_ARTIFACT);
      await writeFile(join(context, 'pom.xml'), MAVEN_FIXTURE_POM);
      await writeFile(join(context, 'SelfManagedApiReports.java'), MAVEN_REPORT_CHECK);
      await writeFile(join(context, 'PreparationTest.java'), 'import org.junit.jupiter.api.Test;\nimport static org.junit.jupiter.api.Assertions.assertEquals;\nclass PreparationTest { @Test void works() { assertEquals(4, 2 + 2); } }\n');
      await writeFile(join(context, 'settings.xml'), '<settings xmlns="http://maven.apache.org/SETTINGS/1.2.0"><mirrors><mirror><id>self-managed-api-central</id><mirrorOf>*</mirrorOf><url>https://repo.maven.apache.org/maven2</url></mirror></mirrors></settings>\n');
      setup = `COPY ${archive} /tmp/maven.tar.gz
RUN mkdir -p /opt/maven /opt/self-managed-api/check /opt/self-managed-api/repository && tar -xzf /tmp/maven.tar.gz --strip-components=1 -C /opt/maven && rm /tmp/maven.tar.gz
COPY settings.xml /opt/self-managed-api/settings.xml
COPY SelfManagedApiReports.java /tmp/SelfManagedApiReports.java
RUN javac -proc:none -d /opt/self-managed-api/check /tmp/SelfManagedApiReports.java && rm /tmp/SelfManagedApiReports.java
COPY pom.xml /tmp/preparation/pom.xml
COPY PreparationTest.java /tmp/preparation/src/test/java/PreparationTest.java
RUN /opt/maven/bin/mvn -C -B -ntp -s /opt/self-managed-api/settings.xml -Dmaven.repo.local=/opt/self-managed-api/repository -f /tmp/preparation/pom.xml test && rm -r /tmp/preparation && chmod -R a+rX /opt/self-managed-api
`;
    }
    const base = FRAMEWORK_BASE_IMAGES[kind];
    const recipe = runtimeRecipeSha256(kind);
    await writeFile(join(context, 'Dockerfile'), `FROM ${base}\n${setup}\nLABEL io.self-managed-api.validation.preparation="${id}"\n`);
    docker('build', '--platform=linux/amd64', `--network=${kind === 'pytest' ? 'none' : 'default'}`, '--tag', tag, context);
    preparationCreated = true;
    const dependencyCommand = kind === 'pytest'
      ? 'cd /opt/self-managed-api/wheels && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum'
      : 'cd /opt/self-managed-api && find repository check -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum';
    const dependenciesSha256 = docker('run', '--rm', '--name', `self-managed-api-runtime-check-${id}`, '--network=none', '--read-only',
      '--user=65534:65534', '--cap-drop=ALL', '--security-opt=no-new-privileges=true', '--entrypoint=/bin/sh', tag, '-c', dependencyCommand).trim().split(/\s/u)[0]!;
    if (!/^[a-f0-9]{64}$/u.test(dependenciesSha256)) throw new Error('Preparation did not produce a dependency digest.');
    const preparedId = docker('image', 'inspect', '--format={{.Id}}', tag).trim();
    // BuildKit resolves a bare sha256 image ID as a remote repository. The unique local tag is
    // checked on both sides; only the final content-addressed ID is exposed for authorization.
    await writeFile(join(context, 'Dockerfile.final'), `FROM ${tag}\nLABEL io.self-managed-api.validation.recipe="${recipe}" io.self-managed-api.validation.dependencies="${dependenciesSha256}" io.self-managed-api.validation.framework="${kind}"\n`);
    docker('build', '--pull=false', '--network=none', '--platform=linux/amd64', '--file', join(context, 'Dockerfile.final'), '--tag', finalTag, context);
    finalCreated = true;
    if (docker('image', 'inspect', '--format={{.Id}}', tag).trim() !== preparedId) throw new Error('Preparation image changed while finalizing its manifest.');
    const runtime = validateRuntime({ schemaVersion: 1, kind, imageId: docker('image', 'inspect', '--format={{.Id}}', finalTag).trim(), recipeSha256: recipe, dependenciesSha256 });
    await writeFile(destination, `${JSON.stringify(runtime, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    manifestSaved = true;
    return runtime;
  } finally {
    if (finalCreated && !manifestSaved) try { docker('image', 'rm', finalTag); } catch { /* Only this invocation's unique tag is eligible for cleanup. */ }
    if (preparationCreated) try { docker('image', 'rm', tag); } catch { /* The final image can retain the preparation layer. */ }
    // Only the unique context created by this invocation is removed.
    await rm(context, { recursive: true, force: true });
  }
}
