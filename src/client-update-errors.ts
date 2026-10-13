export const CLIENT_UPDATE_REASONS = ['none', 'verification-failed', 'version-rollback', 'state-unavailable', 'cache-full',
  'cancelled', 'deadline-exceeded', 'credentials-unavailable', 'authorization-rejected', 'rate-limited', 'network-unavailable',
  'trust-expired', 'targets-expired', 'metadata-expired', 'feed-unavailable', 'release-withdrawn', 'target-unavailable'] as const;
export type ClientUpdateReason = typeof CLIENT_UPDATE_REASONS[number];
const guidance: Partial<Record<ClientUpdateReason, string>> = {
  'credentials-unavailable': 'Check the private worker credentials file and configured Cloud origin.',
  'authorization-rejected': 'Check worker access or reconnect it before trying again.',
  'rate-limited': 'Wait before starting a new update check.',
  'network-unavailable': 'Check connectivity and Cloud availability, then start a new check.',
  'trust-expired': 'Ask the release operator to renew trusted root metadata; retain the existing trust cache.',
  'targets-expired': 'Ask the release operator to publish renewed signed target metadata.',
  'metadata-expired': 'Ask the release operator to renew the signed freshness metadata.',
  'feed-unavailable': 'Ask the release operator to publish an eligible signed update.',
  'release-withdrawn': 'The release was withdrawn; check again after an approved replacement is published.',
  'target-unavailable': 'The signed object is unavailable; ask the release operator to restore the exact published bytes.',
};
export class ClientUpdateError extends Error {
  readonly code = 'CLIENT_UPDATE_FAILED';
  constructor(readonly reason: Exclude<ClientUpdateReason, 'none'>) {
    super(`Client update rejected: ${reason}.${guidance[reason] ? ` ${guidance[reason]}` : ''}`); this.name = 'ClientUpdateError';
  }
}
