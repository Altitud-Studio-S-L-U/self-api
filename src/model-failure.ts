import { PlumberError } from './errors.js';

export type ModelFailureKind = 'credentials' | 'permission' | 'model' | 'quota' | 'transient' | 'invalid-response' | 'cancelled';

/** Only bounded classifications cross the provider boundary; never attach its body or original error. */
export class ModelConnectionError extends PlumberError {
  readonly kind: ModelFailureKind;

  constructor(kind: ModelFailureKind, code: 'ENGINE_FAILED' | 'INVALID_INPUT' = 'ENGINE_FAILED') {
    const selected = ['credentials', 'permission', 'model', 'quota', 'transient', 'invalid-response', 'cancelled'].includes(kind) ? kind : 'invalid-response';
    super(code, `The model connection failed (${selected}); no provider response or credentials were retained.`);
    this.name = 'ModelConnectionError';
    this.kind = selected;
    Object.freeze(this);
  }
}

export function requiresModelReconfiguration(kind: ModelFailureKind): boolean {
  return ['credentials', 'permission', 'model', 'quota', 'invalid-response'].includes(kind);
}
