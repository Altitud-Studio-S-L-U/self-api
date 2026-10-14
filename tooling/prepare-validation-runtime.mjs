import { prepareValidationRuntime } from '../dist/validation-runtime-prepare.js';

const [kind, output, extra] = process.argv.slice(2);
if (!['pytest', 'maven-junit'].includes(kind) || !output || extra) throw new Error('Usage: node tooling/prepare-validation-runtime.mjs <pytest|maven-junit> <new-manifest.json>');
const runtime = await prepareValidationRuntime(kind, output);
process.stdout.write(JSON.stringify(runtime) + '\n');
