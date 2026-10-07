import { parseArgs } from 'node:util';
import { escapeTerminal, jsonLine } from './cli-presentation.js';
import { PlumberError } from './errors.js';
import { loadLocalJson } from './local-file.js';
import { normalizeIntegrationManifest } from './integration-registry.js';
import { compareMcpCatalogs, loadMcpCatalog } from './mcp-catalog.js';
import { compareJsonSchemas, compareJsonExamples } from './json-schema.js';

export async function runSourceCli(args: string[], options: {
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
} = {}): Promise<number> {
  const stdout = options.stdout ?? ((text: string) => { process.stdout.write(text); });
  const stderr = options.stderr ?? ((text: string) => { process.stderr.write(text); });
  try {
    const parsed = parseArgs({ args, strict: true, allowPositionals: true, tokens: true, options: { json: { type: 'boolean' }, direction: { type: 'string' } } });
    const seen = new Set<string>();
    for (const token of parsed.tokens) if (token.kind === 'option') {
      if (seen.has(token.name)) throw new PlumberError('INVALID_INPUT', 'Repeated source options are not supported.');
      seen.add(token.name);
    }
    const [command, basePath, revisionPath] = parsed.positionals;
    if (!basePath || (['mcp-compare', 'schema-compare', 'example-compare'].includes(command ?? '') ? parsed.positionals.length !== 3 : parsed.positionals.length !== 2)
      || (command !== 'schema-compare' && parsed.values.direction !== undefined)) {
      throw new PlumberError('INVALID_INPUT', 'Supply the local source files shown in --help.');
    }
    if (command === 'schema-compare') {
      const direction = parsed.values.direction;
      if (direction !== 'input' && direction !== 'output') throw new PlumberError('INVALID_INPUT', 'Schema comparison requires --direction input or output.');
      const report = await compareJsonSchemas({ basePath, revisionPath: revisionPath!, direction });
      stdout(parsed.values.json ? jsonLine(report) : `Schema comparison: ${report.status}\nDirection: ${direction}\nCoverage: declared structural profile; consumer impact is not analyzed.\n`);
      return report.status === 'no-breaking-changes' ? 0 : 1;
    }
    if (command === 'example-compare') {
      const report = await compareJsonExamples({ basePath, revisionPath: revisionPath! });
      stdout(parsed.values.json ? jsonLine(report) : `Example values changed: ${report.valueChanged}\nCompatibility: not established. Examples do not declare required fields.\n`);
      return 1;
    }
    if (command === 'mcp-compare') {
      const report = await compareMcpCatalogs({ basePath, revisionPath: revisionPath! });
      stdout(parsed.values.json ? jsonLine(report) : `MCP comparison: ${report.status}\nChanges: ${report.changes.length}\n${report.changes.map(change => `- ${escapeTerminal(change.tool)}: ${change.kind} (${change.compatibility})`).join('\n')}\nCoverage: declared structural profile; consumer impact is not analyzed.\n`);
      return report.status === 'no-breaking-changes' ? 0 : 1;
    }
    if (command === 'mcp-snapshot') {
      const snapshot = await loadMcpCatalog(basePath);
      stdout(parsed.values.json ? jsonLine(snapshot) : `MCP tools: ${snapshot.catalog.tools.length}\nCompleteness: ${snapshot.catalog.completeness}\nDigest: ${snapshot.semanticDigest}\nNo tools were invoked.\n`);
      return snapshot.catalog.completeness === 'complete' ? 0 : 1;
    }
    if (command === 'integration-check') {
      const manifest = normalizeIntegrationManifest(await loadLocalJson(basePath, 256 * 1024));
      stdout(parsed.values.json ? jsonLine(manifest) : `Integration: ${escapeTerminal(manifest.provider)} / ${escapeTerminal(manifest.product)}\nSources: ${manifest.sources.length}\nKnown versions: ${manifest.knownVersions.length}\nEffective versions: ${manifest.effectiveVersions.length}\nVersion coverage: listed only. Sources were not fetched.\n`);
      return 0;
    }
    throw new PlumberError('INVALID_INPUT', 'Unknown source command.');
  } catch (error) {
    stderr(jsonLine({ error: error instanceof PlumberError ? { code: error.code, message: error.message }
      : { code: 'INVALID_INPUT', message: 'Could not inspect the source. Check command arguments and the local document.' } }));
    return 2;
  }
}
