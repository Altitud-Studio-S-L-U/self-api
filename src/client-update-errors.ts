export const CLIENT_UPDATE_REASONS = ['none', 'verification-failed', 'version-rollback', 'state-unavailable', 'cache-full',
  'cancelled', 'deadline-exceeded'] as const;
export type ClientUpdateReason = typeof CLIENT_UPDATE_REASONS[number];
export class ClientUpdateError extends Error {
  readonly code = 'CLIENT_UPDATE_FAILED';
  constructor(readonly reason: Exclude<ClientUpdateReason, 'none'>) {
    super(`Client update rejected: ${reason}.`); this.name = 'ClientUpdateError';
  }
}
