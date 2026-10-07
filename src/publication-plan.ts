import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { isCapturedConsumerPath } from './consumer-files.js';
import { PlumberError } from './errors.js';
import { captureGitEvidence } from './git-evidence.js';
import type { GitEvidenceFile } from './git-evidence.js';
import { prepareJobValidation } from './job-validation.js';
import type { MigrationPlan } from './migration-plan.js';
import { readValidationOutcome, validateValidationOutcome } from './validation-outcome.js';
import { openExistingWorkerStore } from './worker.js';

export interface JobPublicationOptions {
  readonly statePath: string;
  readonly intentId: string;
  readonly gitPath: string;
  readonly enginePath: string;
  readonly repository: string;
  readonly baseBranch: string;
}

export interface PublicationCandidate {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly status: 'requires-remote-verification';
  readonly authorization: 'not-granted';
  readonly publication: 'not-started';
  readonly validation: {
    readonly intentId: string;
    readonly requestId: string;
    readonly receiptId: string;
    readonly status: 'passed' | 'improved';
  };
  readonly evidence: {
    readonly planId: string;
    readonly executionDigest: string;
    readonly policyDigest: string;
    readonly outcomeDigest: string;
  };
  readonly git: {
    readonly canonicalRootId: string;
    readonly headSha: string;
    readonly treeSha: string;
    readonly consumerDigest: string;
  };
  readonly destination: {
    readonly host: 'github.com';
    readonly owner: string;
    readonly name: string;
    readonly baseBranch: string;
    readonly verified: false;
  };
  readonly headBranch: string;
  readonly files: readonly (MigrationPlan['files'][number] & Pick<GitEvidenceFile, 'mode' | 'gitBlobId'>)[];
  readonly pullRequest: { readonly title: string; readonly body: string; readonly draft: true };
  readonly consumerModified: false;
}

function invalid(message: string): never { throw new PlumberError('INVALID_INPUT', message); }
function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }

function destination(repository: string, baseBranch: string): PublicationCandidate['destination'] {
  if (typeof repository !== 'string' || repository.length > 140
    || !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9._-]{1,100}$/iu.test(repository)) {
    invalid('Provide an explicit GitHub OWNER/REPO destination without a URL or credentials.');
  }
  const [owner, name] = repository.split('/') as [string, string];
  if (name === '.' || name === '..' || name.toLowerCase().endsWith('.git')) invalid('Provide the repository name without a .git suffix.');
  if (typeof baseBranch !== 'string' || baseBranch.length > 200
    || !/^[a-z0-9][a-z0-9._/-]*$/iu.test(baseBranch) || baseBranch === 'HEAD' || baseBranch.startsWith('refs/')
    || baseBranch.includes('..') || baseBranch.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))) {
    invalid('Provide a bounded, unambiguous short base branch name.');
  }
  return { host: 'github.com', owner, name, baseBranch, verified: false };
}

/** Private local evidence only. Remote identity, base verification and publication approval remain separate gates. */
export async function prepareJobPublicationCandidate(input: JobPublicationOptions): Promise<PublicationCandidate> {
  const target = destination(input.repository, input.baseBranch);
  if (typeof input.intentId !== 'string' || !/^[a-f0-9]{64}$/u.test(input.intentId)) invalid('Provide a canonical execution intent ID.');
  const store = await openExistingWorkerStore(input.statePath);
  try {
    const intent = store.listExecutionIntents().find(item => item.id === input.intentId);
    if (!intent || intent.status !== 'completed' || !intent.outcome) invalid('Publication planning requires a completed validation intent.');
    const { subscription } = store.getJobEvidence(intent.jobId);
    const outcome = await readValidationOutcome({ attemptPath: join(store.statePath, 'attempts', intent.receiptId),
      intentId: intent.id, requestId: intent.requestId, receiptId: intent.receiptId });
    if (!outcome || JSON.stringify(outcome) !== JSON.stringify(validateValidationOutcome(intent.outcome))) {
      invalid('Durable validation artifacts do not match the completed intent.');
    }
    if ((outcome.status !== 'passed' && outcome.status !== 'improved') || outcome.candidate?.status !== 'passed'
      || outcome.baseline.cleanup !== 'removed' || outcome.candidate.cleanup !== 'removed') {
      invalid('Publication planning requires a passing candidate and confirmed validation cleanup.');
    }
    // Reconstruct from immutable job evidence rather than trusting a stored source preview.
    const request = await prepareJobValidation({ statePath: store.statePath, jobId: intent.jobId, enginePath: input.enginePath,
      recipe: JSON.parse(intent.recipeJson) as unknown, testPaths: intent.testPaths });
    if (request.id !== intent.requestId || request.plan.id !== intent.planId || request.executionDigest !== intent.executionDigest
      || request.policyDigest !== intent.policyDigest) invalid('The validated request changed; review and validate current evidence again.');
    const git = await captureGitEvidence({ consumerRoot: subscription.consumerRoot, gitPath: input.gitPath,
      expectedConsumerDigest: request.plan.evidence.consumerDigest });
    if (git.canonicalRootId !== request.plan.evidence.consumerRootId) invalid('Git evidence belongs to a different consumer root.');
    const tracked = new Map(git.files.map(file => [file.path, file]));
    const files = request.plan.files.map(file => {
      const original = tracked.get(file.path);
      if (!isCapturedConsumerPath(file.path) || /[\u0000-\u001f\u007f]/u.test(file.path) || !original
        || original.sha256 !== file.beforeSha256 || digest(file.before) !== file.beforeSha256
        || digest(file.after) !== file.afterSha256) invalid('A proposed edit is not bound to the captured Git blob.');
      return { ...file, mode: original.mode, gitBlobId: original.gitBlobId };
    });
    if (!files.length) invalid('Publication planning requires at least one validated source edit.');
    const validation = { intentId: intent.id, requestId: intent.requestId, receiptId: intent.receiptId, status: outcome.status };
    const content: Omit<PublicationCandidate, 'id' | 'headBranch'> = {
      schemaVersion: 1, status: 'requires-remote-verification', authorization: 'not-granted', publication: 'not-started',
      validation, evidence: { planId: request.plan.id, executionDigest: request.executionDigest, policyDigest: request.policyDigest,
        outcomeDigest: digest(JSON.stringify(outcome)) },
      git: { canonicalRootId: git.canonicalRootId, headSha: git.headSha, treeSha: git.treeSha, consumerDigest: git.consumerDigest },
      destination: target, files,
      pullRequest: { title: 'Update API integration', draft: true, body: [
        `Proposes ${files.length} source file change(s) from the reviewed local migration plan.`, '',
        outcome.status === 'passed' ? 'Selected baseline and candidate tests passed in the approved validation profile.'
          : 'Validation improved: selected baseline tests failed and candidate tests passed. The baseline failure remains part of the review.',
        'This evidence covers the selected tests only; it does not establish general API compatibility.', '',
        `Plan: ${request.plan.id}`, `Validation request: ${request.id}`, `Local base commit: ${git.headSha}`, '',
        'This is a local draft proposal. Remote repository identity and base revision have not been verified; publication is not authorized.',
      ].join('\n') }, consumerModified: false,
    };
    const id = digest(JSON.stringify(content));
    return { ...content, id, headBranch: `feat/api-${id.slice(0, 12)}` };
  } finally { store.close(); }
}
