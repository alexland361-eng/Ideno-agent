/**
 * Error taxonomy (§26 Failure Handling).
 *
 * Every failure surfaced to the UI carries a machine-readable code and a
 * human-readable recovery hint. Nothing collapses into "something went wrong".
 */

export const ERROR_CODES = [
  // Provider/runtime failures
  'PROVIDER_UNAVAILABLE', // endpoint unreachable / server error
  'AUTH_INVALID', // invalid credentials
  'RATE_LIMITED',
  'TIMEOUT',
  'CANCELLED',
  'CONTEXT_OVERFLOW', // input exceeds model context
  'MODEL_ERROR', // model produced unusable output (empty, malformed)
  'CAPABILITY_UNSUPPORTED', // required capability not available on any route
  // Configuration
  'CONFIG_INVALID',
  // Data flow
  'VALIDATION_FAILED', // schema/semantic validation failed
  'PROPOSAL_INVALID',
  'PROPOSAL_NOT_FOUND',
  'STATE_CONFLICT', // proposal no longer applies to current state
  'RESEARCH_UNAVAILABLE', // no research provider configured
  'AUTH_UNAVAILABLE', // no Supabase configured on this server
  'AUTH_REQUIRED', // request needs a signed-in user
  // Local system
  'PERSISTENCE_ERROR',
  'BAD_REQUEST',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiErrorShape {
  code: ErrorCode;
  message: string;
  detail?: string[];
  /** Whether retrying the same action may succeed (e.g. after fixing config). */
  recoverable: boolean;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly detail: string[];
  readonly recoverable: boolean;
  readonly status: number;

  constructor(
    code: ErrorCode,
    message: string,
    opts: { detail?: string[]; recoverable?: boolean; status?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = 'AppError';
    this.code = code;
    this.detail = opts.detail ?? [];
    this.recoverable = opts.recoverable ?? false;
    this.status = opts.status ?? httpStatusFor(code);
  }

  toJSON(): ApiErrorShape {
    return {
      code: this.code,
      message: this.message,
      detail: this.detail.length ? this.detail : undefined,
      recoverable: this.recoverable,
    };
  }
}

export function httpStatusFor(code: ErrorCode): number {
  switch (code) {
    case 'AUTH_INVALID':
      return 502; // our credentials toward the provider are bad; not client's fault
    case 'RATE_LIMITED':
      return 429;
    case 'TIMEOUT':
      return 504;
    case 'CANCELLED':
      return 499;
    case 'CONTEXT_OVERFLOW':
    case 'MODEL_ERROR':
    case 'PROVIDER_UNAVAILABLE':
    case 'CAPABILITY_UNSUPPORTED':
    case 'RESEARCH_UNAVAILABLE':
    case 'AUTH_UNAVAILABLE':
      return 502;
    case 'AUTH_REQUIRED':
      return 401;
    case 'CONFIG_INVALID':
      return 500;
    case 'VALIDATION_FAILED':
    case 'PROPOSAL_INVALID':
    case 'STATE_CONFLICT':
      return 422;
    case 'PROPOSAL_NOT_FOUND':
      return 404;
    case 'PERSISTENCE_ERROR':
      return 500;
    case 'BAD_REQUEST':
      return 400;
    case 'INTERNAL':
      return 500;
  }
}
