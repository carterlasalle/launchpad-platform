import type { ErrorClass, ProviderName } from '@launchpad/core';

export class ProviderRequestError extends Error {
  readonly code: string;
  readonly class: ErrorClass;
  readonly provider: ProviderName;
  readonly status: number | null;
  readonly retryable: boolean;
  readonly safeDetails: Record<string, unknown>;

  constructor(input: { code: string; class: ErrorClass; provider: ProviderName; message: string; status?: number | null; retryable: boolean; safeDetails?: Record<string, unknown> }) {
    super(input.message);
    this.name = input.code;
    this.code = input.code;
    this.class = input.class;
    this.provider = input.provider;
    this.status = input.status ?? null;
    this.retryable = input.retryable;
    this.safeDetails = input.safeDetails ?? {};
  }
}
