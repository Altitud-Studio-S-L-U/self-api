import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { checkClientUpdate, stageClientUpdate, readClientUpdateStatus, ClientUpdateError, type ClientUpdateRepository } from './client-update.js';
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
    if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).length !== 2
      || !Object.hasOwn(config, 'statePath') || !Object.hasOwn(config, 'repository')) throw new ClientUpdateError('verification-failed');
    const statePath = (config as { statePath: string }).statePath;
    if (action === 'status') { stdout(jsonLine({ status: await readClientUpdateStatus({ statePath }) })); return 0; }
    const metadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name?: unknown; version?: unknown };
    if (metadata.name !== 'self-managed-api' || typeof metadata.version !== 'string') throw new ClientUpdateError('verification-failed');
    process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
    const options = { statePath, currentVersion: metadata.version, repository: (config as { repository: ClientUpdateRepository }).repository, signal: controller.signal };
    const result = await (action === 'stage' ? stageClientUpdate(options) : checkClientUpdate(options));
    stdout(jsonLine(result)); return 0;
  } catch (error) {
    const failure = error instanceof ClientUpdateError ? error : new ClientUpdateError('verification-failed');
    stderr(jsonLine({ error: { code: failure.code, reason: failure.reason, message: failure.message } })); return 2;
  } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}
