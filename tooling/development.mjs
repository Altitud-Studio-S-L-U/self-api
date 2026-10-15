import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const usage = 'Usage: pnpm dev | pnpm dev:check\n';

function runProjectChecks() {
  return new Promise((resolveExit, reject) => {
    // Only this fixed, repository-owned command reaches the shell; CLI input is never interpolated.
    const child = spawn('pnpm run check', {
      cwd: projectRoot,
      shell: true,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('close', (code) => resolveExit(code ?? 1));
  });
}

export async function runDevelopment(args, options = {}) {
  const stdout = options.stdout ?? (text => { process.stdout.write(text); });
  const stderr = options.stderr ?? (text => { process.stderr.write(text); });
  const command = args[0] ?? 'status';
  if (args.length > 1 || !['status', 'check', '--help', '-h'].includes(command)) {
    stderr(usage);
    return 2;
  }
  if (command === '--help' || command === '-h') {
    stdout(usage);
    return 0;
  }
  if (command === 'status') {
    stdout('Keepseam development commands\n\n'
      + 'Build: pnpm build\nValidation: pnpm dev:check\nLocal laboratory: pnpm dev:local --help\n'
      + 'CLI: pnpm keepseam --help\nTechnical documentation: docs/technical-guide.pdf\n');
    return 0;
  }
  try {
    const code = await (options.runCheck ?? runProjectChecks)();
    if (code === 0) stdout('Checks passed.\n');
    else stderr(`Checks failed (exit ${code}).\n`);
    return code;
  } catch {
    stderr('Could not run the development checks.\n');
    return 2;
  }
}

if (import.meta.main) process.exitCode = await runDevelopment(process.argv.slice(2));
