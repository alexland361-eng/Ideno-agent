import { AppError } from '../../shared/errors.js';

/**
 * Runtime error classes (§26). Each maps onto the shared error codes so the
 * UI can present useful recovery information instead of a generic failure.
 */

export class ProviderError extends AppError {
  constructor(message: string, detail: string[] = [], cause?: unknown) {
    super('PROVIDER_UNAVAILABLE', message, { detail, cause, recoverable: true });
    this.name = 'ProviderError';
  }
}

export class AuthError extends AppError {
  constructor(message: string, cause?: unknown) {
    super('AUTH_INVALID', message, { detail: ['Check the provider API key (env var or config).'], cause, recoverable: true });
    this.name = 'AuthError';
  }
}

export class RateLimitError extends AppError {
  constructor(message: string, detail: string[] = [], cause?: unknown) {
    super('RATE_LIMITED', message, { detail, cause, recoverable: true });
    this.name = 'RateLimitError';
  }
}

export class TimeoutError extends AppError {
  constructor(message: string, cause?: unknown) {
    super('TIMEOUT', message, { detail: ['The model took too long. Try again or raise timeout_ms in the provider config.'], cause, recoverable: true });
    this.name = 'TimeoutError';
  }
}

export class CancelledError extends AppError {
  constructor(message = 'Request cancelled') {
    super('CANCELLED', message, { recoverable: true });
    this.name = 'CancelledError';
  }
}

export class ContextOverflowError extends AppError {
  constructor(message: string, detail: string[] = [], cause?: unknown) {
    super('CONTEXT_OVERFLOW', message, {
      detail: ['The context sent to the model exceeded its limit.', ...detail],
      cause,
      recoverable: false,
    });
    this.name = 'ContextOverflowError';
  }
}

export class ModelOutputError extends AppError {
  constructor(message: string, detail: string[] = [], cause?: unknown) {
    super('MODEL_ERROR', message, { detail, cause, recoverable: true });
    this.name = 'ModelOutputError';
  }
}

export class CapabilityError extends AppError {
  constructor(message: string, detail: string[] = []) {
    super('CAPABILITY_UNSUPPORTED', message, { detail, recoverable: true });
    this.name = 'CapabilityError';
  }
}

export class ConfigurationError extends AppError {
  constructor(message: string, detail: string[] = [], cause?: unknown) {
    super('CONFIG_INVALID', message, { detail, cause, recoverable: true });
    this.name = 'ConfigurationError';
  }
}

/**
 * Classify an HTTP failure from an OpenAI-compatible endpoint.
 * Body text is searched for common provider-specific phrasings.
 */
export function classifyHttpFailure(
  status: number,
  bodyText: string,
  context: { providerId: string; url: string },
): AppError {
  const lower = bodyText.toLowerCase();
  const where = `${context.providerId} (${context.url})`;
  const hint = bodyText.slice(0, 500);

  if (status === 401 || status === 403) {
    return new AuthError(`Provider rejected credentials: ${where}`, [hint]);
  }
  if (status === 404) {
    return new ProviderError(`Endpoint or model not found: ${where}`, [hint]);
  }
  if (status === 429) {
    return new RateLimitError(`Rate limited by provider: ${where}`, [hint]);
  }
  if (status === 408) {
    return new TimeoutError(`Provider reported request timeout: ${where}`);
  }
  if (status === 400 && /context|max.?token|too long|too many tokens|length/.test(lower)) {
    return new ContextOverflowError(`Input exceeded the model context window: ${where}`, [hint]);
  }
  if (status >= 500) {
    return new ProviderError(`Provider server error (HTTP ${status}): ${where}`, [hint]);
  }
  return new ProviderError(`Provider returned HTTP ${status}: ${where}`, [hint]);
}

/** Classify a network-level fetch failure (DNS, refused, TLS, abort, timeout). */
export function classifyNetworkFailure(err: unknown, context: { providerId: string; url: string; timeoutMs: number }): AppError {
  const where = `${context.providerId} (${context.url})`;
  const errName = err instanceof Error ? err.name : String(err);
  const msg = err instanceof Error ? err.message : String(err);

  if (err instanceof Error && err.name === 'AbortError') {
    // Distinguish user cancellation from timeout by which signal fired —
    // callers that pass an external signal translate AbortError themselves.
    return new TimeoutError(`Request to ${where} timed out after ${context.timeoutMs}ms`);
  }
  if (err instanceof Error && err.name === 'TimeoutError') {
    return new TimeoutError(`Request to ${where} timed out after ${context.timeoutMs}ms`);
  }
  return new ProviderError(
    `Could not reach provider ${where}: ${msg}`,
    ['Check that the endpoint is running and reachable from the Ideno backend.'],
    errName === 'AbortError' ? undefined : err,
  );
}
