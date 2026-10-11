const { createRequire } = require('node:module');
const { dirname, join } = require('node:path');
const { realpathSync } = require('node:fs');
const requireFile = createRequire(realpathSync(process.execPath));
const root = dirname(realpathSync(process.execPath));
try {
  const { runCli } = requireFile(join(root, 'lib', 'node_modules', 'keepseam-client', 'dist', 'cli.js'));
  runCli(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(() => {
    process.stderr.write('Keepseam could not complete the command.\n');
    process.exitCode = 2;
  });
} catch {
  process.stderr.write('Keepseam runtime is missing or incompatible. Extract the complete release archive.\n');
  process.exitCode = 2;
}
