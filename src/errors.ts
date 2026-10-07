export type PlumberErrorCode =
  | 'INVALID_INPUT'
  | 'UNSUPPORTED_CONTRACT'
  | 'STATE_LIMIT'
  | 'LEASE_LOST'
  | 'ENGINE_UNAVAILABLE'
  | 'ENGINE_FAILED';

export class PlumberError extends Error {
  readonly code: PlumberErrorCode;

  constructor(code: PlumberErrorCode, message: string) {
    super(message);
    this.name = 'PlumberError';
    this.code = code;
  }
}
