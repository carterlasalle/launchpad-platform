import { stableId } from '@launchpad/shared';
import type { ProviderName } from './types.js';

export type ErrorClass = 'VALIDATION' | 'AUTHENTICATION' | 'AUTHORIZATION' | 'NOT_FOUND' | 'CONFLICT' | 'UNSUPPORTED' | 'RATE_LIMITED' | 'TRANSIENT_PROVIDER' | 'MALFORMED_PROVIDER_RESPONSE' | 'TIMEOUT' | 'BUILD_FAILURE' | 'HEALTH_FAILURE' | 'POLICY_BLOCK' | 'STALE_PLAN' | 'INTERNAL';

export interface PlatformError {
  code: string;
  class: ErrorClass;
  message: string;
  remediation: string | null;
  provider: ProviderName | null;
  operationId: string | null;
  retryable: boolean;
  safeDetails: Record<string, unknown>;
  causeFingerprint: string;
}

export interface PlatformErrorInput {
  code: string;
  class: ErrorClass;
  message: string;
  remediation?: string | null;
  provider?: ProviderName | null;
  operationId?: string | null;
  retryable: boolean;
  safeDetails?: Record<string, unknown>;
  cause?: unknown;
}

export function createPlatformError(input: PlatformErrorInput): PlatformError {
  const causeText = input.cause instanceof Error ? input.cause.message : String(input.cause ?? input.message);
  return {
    code: input.code,
    class: input.class,
    message: input.message,
    remediation: input.remediation ?? null,
    provider: input.provider ?? null,
    operationId: input.operationId ?? null,
    retryable: input.retryable,
    safeDetails: input.safeDetails ?? {},
    causeFingerprint: stableId('cause', input.code, causeText),
  };
}

export class LaunchpadError extends Error {
  readonly platform: PlatformError;

  constructor(platform: PlatformError) {
    super(platform.message);
    this.name = platform.code;
    this.platform = platform;
  }
}
