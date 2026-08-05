import { createPlatformError, LaunchpadError } from '@launchpad/core';
import type { ErrorClass, ProviderName } from '@launchpad/core';

/**
 * Typed store errors following the platform error convention
 * (master plan section 20). Store errors are never retryable at the caller
 * level: each invariant failure is deterministic and must be resolved by the
 * caller (release a lock, pick a fresh generation, present the correct token).
 */
export function storeError(
  code: string,
  errorClass: ErrorClass,
  message: string,
  options: { provider?: ProviderName | null; operationId?: string | null; safeDetails?: Record<string, unknown> } = {},
): LaunchpadError {
  return new LaunchpadError(createPlatformError({ code, class: errorClass, message, retryable: false, provider: options.provider ?? null, operationId: options.operationId ?? null, ...(options.safeDetails !== undefined ? { safeDetails: options.safeDetails } : {}) }));
}

/** A row the operation depends on does not exist (or no longer exists). */
export function notFound(what: string, detail?: string): LaunchpadError {
  return storeError('LP-DB-NOT-FOUND', 'NOT_FOUND', `${what} was not found${detail ? ` (${detail})` : ''}`);
}

/** An invariant collision: lock held, key reused, tombstone, stale generation, etc. */
export function conflict(code: string, message: string, safeDetails?: Record<string, unknown>): LaunchpadError {
  return storeError(code, 'CONFLICT', message, safeDetails !== undefined ? { safeDetails } : {});
}

/** Caller violated a store contract (bad lock key, non-serializable payload). */
export function invalidArgument(code: string, message: string): LaunchpadError {
  return storeError(code, 'VALIDATION', message);
}
