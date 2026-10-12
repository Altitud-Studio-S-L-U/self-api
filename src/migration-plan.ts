import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { analyzeImpact } from './impact.js';
import type { ImpactOptions, ImpactReport } from './impact.js';
import { captureConsumer, isJavaScriptConsumerPath } from './consumer-files.js';
import { previewRecipe } from './migration-recipe.js';
import type { MigrationRecipe } from './migration-recipe.js';
import { PlumberError } from './errors.js';

export interface MigrationPlanOptions extends ImpactOptions {
  readonly recipe: unknown;
}

export interface MigrationPlan {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly summary: string;
  readonly decisions: MigrationRecipe['decisions'];
  readonly status: 'ready-for-review' | 'requires-decision';
  readonly evidence: {
    readonly consumerRootId: string;
    readonly consumerDigest: string;
    readonly baseSha256: string;
    readonly revisionSha256: string;
    readonly recipeSha256: string;
    readonly provider: ImpactReport['provider'];
  };
  readonly impact: ImpactReport;
  readonly requirements: readonly { id: string; question: string }[];
  readonly files: readonly {
    path: string;
    beforeSha256: string;
    afterSha256: string;
    before: string;
    after: string;
  }[];
  readonly authorization: 'not-granted';
  readonly validation: 'syntax-only' | 'not-run';
  readonly consumerModified: false;
  readonly consumerExecuted: false;
}

/** Local proposal only. A ready proposal is neither human approval nor a validated migration. */
export async function createMigrationPlan(options: MigrationPlanOptions): Promise<MigrationPlan> {
  const impact = await analyzeImpact(options);
  const captured = await captureConsumer(options.consumerRoot);
  if (captured.digest !== impact.inventory.digest) {
    throw new PlumberError('INVALID_INPUT', 'Consumer evidence changed during planning; analyze a stable revision again.');
  }
  const preview = previewRecipe(options.recipe, captured.files);
  const absolute = resolve(options.consumerRoot);
  const rootIdentity = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  const content: Omit<MigrationPlan, 'id'> = {
    schemaVersion: 1,
    summary: preview.summary,
    decisions: preview.decisions,
    status: preview.status,
    evidence: {
      consumerRootId: createHash('sha256').update(rootIdentity).digest('hex'),
      consumerDigest: captured.digest,
      baseSha256: impact.comparison.base.sha256,
      revisionSha256: impact.comparison.revision.sha256,
      recipeSha256: preview.recipeSha256,
      provider: impact.provider,
    },
    impact,
    requirements: preview.requirements,
    files: preview.files,
    authorization: 'not-granted',
    validation: preview.status === 'ready-for-review' && preview.files.every(file => isJavaScriptConsumerPath(file.path)) ? 'syntax-only' : 'not-run',
    consumerModified: false,
    consumerExecuted: false,
  };
  const id = createHash('sha256').update(JSON.stringify(content)).digest('hex');
  return { ...content, id };
}
