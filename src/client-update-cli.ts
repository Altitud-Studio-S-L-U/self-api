import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { checkClientUpdate, checkWorkerUpdate, stageClientUpdate, stageWorkerUpdate, readClientUpdateStatus, readWorkerUpdateStatus, ClientUpdateError,
  type ClientUpdateRepository, type CloudClientUpdateRepository } from './client-update.js';
import { jsonLine } from './cli-presentation.js';
import { loadLocalJson } from './local-file.js';
import { servicePath } from './worker-service-config.js';
import { checkServicePath, checkWindowsServiceAcl } from './worker-service-state.js';

export async function runClientUpdateCli(args: string[], output: { readonly stdout?: (text: string) => void; readonly stderr?: (text: string) => void } = {}): Promise<number> {
  const stdout = output.stdout ?? ((text: string) => { process.stdout.write(text); });
  const stderr = output.stderr ?? ((text: string) => { process.stderr.write(text); });
  const controller = new AbortController();
  const cancel = (): void => { controller.abort(); };
  try {
    const parsed = parseArgs({ args, strict: true, allowPositionals: true, tokens: true, options: { config: { type: 'string' } } });
    const action = parsed.positionals[1];
    if (parsed.positionals[0] !== 'client-update' || parsed.positionals.length !== 2 || !action || !['check', 'stage', 'status'].includes(action)
      || !parsed.values.config || parsed.tokens.filter(token => token.kind === 'option').length !== 1) throw new ClientUpdateError('verification-failed');
    const configPath = servicePath(parsed.values.config, process.platform === 'win32' ? 'windows' : 'systemd');
    checkServicePath(configPath, 'config'); checkWindowsServiceAcl(configPath, false);
    const config = await loadLocalJson(configPath, 16_384);
    // Without "artifact" the configuration selects the SDK exactly as before; "worker-linux-x64" selects the portable
    // worker, whose state directory, store and watermark are its own.
    const keys = config && typeof config === 'object' && !Array.isArray(config) ? Object.keys(config).sort().join() : '';
    if (keys !== 'repository,statePath' && keys !== 'artifact,repository,statePath') throw new ClientUpdateError('verification-failed');
    const worker = Object.hasOwn(config as object, 'artifact');
    if (worker && (config as { artifact: unknown }).artifact !== 'worker-linux-x64') throw new ClientUpdateError('verification-failed');
    const statePath = (config as { statePath: string }).statePath;
    if (action === 'status') {
      stdout(jsonLine({ status: worker ? await readWorkerUpdateStatus({ statePath }) : await readClientUpdateStatus({ statePath }) })); return 0;
    }
    const repository = (config as { repository: ClientUpdateRepository }).repository;
    if (worker) {
      process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
      // A public repository is refused inside the updater, before credentials, state or network.
      const options = { statePath, repository: repository as CloudClientUpdateRepository, signal: controller.signal };
      stdout(jsonLine(await (action === 'stage' ? stageWorkerUpdate(options) : checkWorkerUpdate(options)))); return 0;
    }
    const metadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name?: unknown; version?: unknown };
    if (metadata.name !== 'keepseam-client' || typeof metadata.version !== 'string') throw new ClientUpdateError('verification-failed');
    process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
    const options = { statePath, currentVersion: metadata.version, repository, signal: controller.signal };
    const result = await (action === 'stage' ? stageClientUpdate(options) : checkClientUpdate(options));
    stdout(jsonLine(result)); return 0;
  } catch (error) {
    const failure = error instanceof ClientUpdateError ? error : new ClientUpdateError('verification-failed');
    stderr(jsonLine({ error: { code: failure.code, reason: failure.reason, message: failure.message } })); return 2;
  } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}
