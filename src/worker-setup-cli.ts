import { parseArgs, type ParseArgsConfig } from 'node:util';
import { jsonLine } from './cli-presentation.js';
import { PlumberError } from './errors.js';
import { loadLocalJson, parseLocalJson } from './local-file.js';
import { completeWorkerSetup, diagnoseWorker, enableWorkerLicense, initWorkerSetup, installWorkerLicenseTrust, readWorkerPublicIdentity } from './worker-setup.js';

export interface WorkerSetupCliOptions {
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
  /** The enrollment is read from stdin: no secret is accepted in argv and the command keeps no extra copy of it. Stdin may come from a protected file or a secret manager. */
  readonly stdin?: AsyncIterable<Uint8Array> & { readonly isTTY?: boolean };
  readonly platform?: NodeJS.Platform;
}
const enrollmentLimit = 16 * 1024;

function options<const T extends NonNullable<ParseArgsConfig['options']>>(args: string[], allowed: T) {
  const parsed = parseArgs({ args, strict: true, allowPositionals: true, tokens: true, options: allowed });
  const seen = new Set<string>();
  for (const token of parsed.tokens) if (token.kind === 'option') {
    if (seen.has(token.name) && !(allowed[token.name] as { multiple?: boolean } | undefined)?.multiple) throw new PlumberError('INVALID_INPUT', 'Repeated setup options are not supported.');
    seen.add(token.name);
  }
  return parsed;
}
async function enrollment(stdin: WorkerSetupCliOptions['stdin']): Promise<unknown> {
  // Typed input would echo the client secret; accept it only from a pipe until hidden entry exists.
  if (!stdin || stdin.isTTY) throw new PlumberError('INVALID_INPUT', 'Pipe the enrollment JSON into this command; typing it at a terminal is not supported.');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of stdin) {
    size += chunk.length;
    if (size > enrollmentLimit) throw new PlumberError('INVALID_INPUT', 'The enrollment JSON is larger than 16 KiB.');
    chunks.push(Buffer.from(chunk));
  }
  try { return parseLocalJson(Buffer.concat(chunks)); } catch { throw new PlumberError('INVALID_INPUT', 'The enrollment input is not JSON.'); }
}

export async function runWorkerSetupCli(args: string[], cli: WorkerSetupCliOptions = {}): Promise<number> {
  const stdout = cli.stdout ?? ((text: string) => { process.stdout.write(text); });
  const stderr = cli.stderr ?? ((text: string) => { process.stderr.write(text); });
  try {
    if ((cli.platform ?? process.platform) !== 'linux') throw new PlumberError('INVALID_INPUT', 'Worker setup currently supports Linux hosts only.');
    if (args[0] === 'doctor') {
      const parsed = options(args, { dir: { type: 'string' }, online: { type: 'boolean' }, json: { type: 'boolean' } });
      if (parsed.positionals.length !== 1 || !parsed.values.dir) throw new PlumberError('INVALID_INPUT', 'doctor requires --dir.');
      const report = await diagnoseWorker({ directory: parsed.values.dir, online: parsed.values.online === true });
      stdout(parsed.values.json ? jsonLine(report) : report.checks.map(check => `${check.status.padEnd(4)} ${check.id}${check.code ? ` ${check.code}` : ''}\n`).join('')
        + (report.configSha256 ? `config-sha256 ${report.configSha256}\n` : ''));
      return report.ok ? 0 : 1;
    }
    const action = args[1];
    if (args[0] !== 'setup' || !action || !['init', 'identity', 'complete', 'trust', 'config'].includes(action)) throw new PlumberError('INVALID_INPUT', 'setup requires init, identity, complete, trust or config.');
    if (action === 'config') {
      const parsed = options(args, { dir: { type: 'string' }, license: { type: 'boolean' }, expect: { type: 'string' } });
      if (parsed.positionals.length !== 2 || !parsed.values.dir || parsed.values.license !== true || !parsed.values.expect) {
        throw new PlumberError('INVALID_INPUT', 'setup config requires --dir, --license and --expect <config-sha256 from doctor>.');
      }
      const result = await enableWorkerLicense({ directory: parsed.values.dir, expectedSha256: parsed.values.expect });
      stdout(jsonLine(result));
      stderr(result.changed ? 'License section added. It applies at the next service start; worker.json.previous keeps the replaced revision.\n' : 'The license section was already present; nothing was changed.\n');
      return 0;
    }
    if (action === 'trust') {
      const parsed = options(args, { dir: { type: 'string' }, trust: { type: 'string' }, key: { type: 'string', multiple: true } });
      if (parsed.positionals.length !== 2 || !parsed.values.dir || !parsed.values.trust || !parsed.values.key?.length) {
        throw new PlumberError('INVALID_INPUT', 'setup trust requires --dir, --trust and one --key kid=sha256 per key, as shown by Keepseam Cloud.');
      }
      const expected: Record<string, string> = Object.create(null);
      for (const value of parsed.values.key) {
        const match = /^([a-zA-Z0-9_-]{1,64})=([a-f0-9]{64})$/u.exec(value);
        if (!match || Object.hasOwn(expected, match[1]!)) throw new PlumberError('INVALID_INPUT', 'Each --key must be a distinct kid=sha256.');
        expected[match[1]!] = match[2]!;
      }
      stdout(jsonLine(await installWorkerLicenseTrust({ directory: parsed.values.dir, trust: await loadLocalJson(parsed.values.trust, 16_384), expected: { ...expected } })));
      return 0;
    }
    if (action === 'init') {
      const parsed = options(args, { dir: { type: 'string' }, state: { type: 'string' }, cloud: { type: 'string' } });
      if (parsed.positionals.length !== 2 || !parsed.values.dir) throw new PlumberError('INVALID_INPUT', 'setup init requires --dir.');
      const identity = await initWorkerSetup({ directory: parsed.values.dir, ...(parsed.values.state ? { statePath: parsed.values.state } : {}),
        ...(parsed.values.cloud ? { cloudOrigin: parsed.values.cloud } : {}) });
      stdout(jsonLine(identity));
      stderr('Paste this public identity in Keepseam Cloud > Workers > Connect, then pipe the enrollment JSON into "keepseam setup complete".\n');
      return 0;
    }
    if (action === 'identity') {
      const parsed = options(args, { dir: { type: 'string' } });
      if (parsed.positionals.length !== 2 || !parsed.values.dir) throw new PlumberError('INVALID_INPUT', 'setup identity requires --dir.');
      stdout(jsonLine(await readWorkerPublicIdentity({ directory: parsed.values.dir })));
      return 0;
    }
    const parsed = options(args, { dir: { type: 'string' }, 'interval-ms': { type: 'string' } });
    if (parsed.positionals.length !== 2 || !parsed.values.dir) throw new PlumberError('INVALID_INPUT', 'setup complete requires --dir and the enrollment JSON on stdin.');
    const interval = parsed.values['interval-ms'];
    if (interval !== undefined && !/^[1-9][0-9]{3,6}$/u.test(interval)) throw new PlumberError('INVALID_INPUT', 'Choose --interval-ms between 1000 and 3600000.');
    const result = await completeWorkerSetup({ directory: parsed.values.dir, enrollment: await enrollment(cli.stdin ?? process.stdin),
      ...(interval !== undefined ? { intervalMs: Number(interval) } : {}) });
    stdout(jsonLine(result));
    stderr('Observation-only service configuration written. It reads no credentials and shares nothing with Cloud until sharing is configured explicitly.\n');
    return 0;
  } catch (error) {
    stderr(jsonLine({ error: error instanceof PlumberError ? { code: error.code, message: error.message }
      : { code: 'SETUP_FAILED', message: 'The setup command could not complete its local operation.' } }));
    return 2;
  }
}
