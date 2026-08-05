import { LaunchpadError, createPlatformError } from '@launchpad/core';
import { SensitiveValue } from '@launchpad/shared';
import type { ProviderContext, SecretProvider } from '@launchpad/provider-contract';
import { parseSecretReference } from './reference.js';
import type { SecretTarget, SecretTargetPolicy } from './target-policy.js';

export interface EnvironmentSecretProviderOptions {
  /** Target policy; when set, target-aware calls enforce it. */
  policy?: SecretTargetPolicy | null;
}

function targetDenied(policy: SecretTargetPolicy, reference: string, target: SecretTarget): LaunchpadError {
  return new LaunchpadError(createPlatformError({ code: 'LP-SECRET-TARGET-DENIED', class: 'AUTHORIZATION', message: policy.describe(reference, target), retryable: false }));
}

/** Resolves `env://` references from an injected value map or the process environment. */
export class EnvironmentSecretProvider implements SecretProvider {
  readonly values: Record<string, string>;
  readonly policy: SecretTargetPolicy | null;

  constructor(values: Record<string, string> = {}, options: EnvironmentSecretProviderOptions = {}) {
    this.values = { ...values };
    this.policy = options.policy ?? null;
  }

  private envName(reference: string): string {
    const parsed = parseSecretReference(reference);
    if (parsed.scheme !== 'env') {
      throw new LaunchpadError(createPlatformError({ code: 'LP-SECRET-UNSUPPORTED-SCHEME', class: 'UNSUPPORTED', message: `Secret reference scheme '${parsed.scheme}' is not supported by EnvironmentSecretProvider.`, retryable: false }));
    }
    return parsed.key;
  }

  async exists(reference: string, _ctx: ProviderContext): Promise<boolean> {
    const name = this.envName(reference);
    return this.values[name] !== undefined || (typeof process !== 'undefined' && process.env[name] !== undefined);
  }

  async resolve(reference: string, _ctx: ProviderContext): Promise<SensitiveValue<unknown>> {
    const name = this.envName(reference);
    const value = this.values[name] ?? (typeof process !== 'undefined' ? process.env[name] : undefined);
    if (value === undefined) {
      throw new LaunchpadError(createPlatformError({ code: 'LP-SECRET-NOT-FOUND', class: 'NOT_FOUND', message: `Secret reference '${reference}' is not configured.`, retryable: false }));
    }
    return new SensitiveValue(value);
  }

  /** Keyed fingerprint: SHA-256 over the reference and the resolved value; stable per reference+value. */
  async fingerprint(reference: string, ctx: ProviderContext): Promise<string> {
    const value = await this.resolve(reference, ctx);
    return value.keyedFingerprint(reference);
  }

  async assertTargetPermitted(reference: string, target: SecretTarget, _ctx: ProviderContext): Promise<void> {
    if (this.policy && !this.policy.allows(reference, target)) throw targetDenied(this.policy, reference, target);
  }

  /** Target-aware resolve: enforces the configured policy before reading the value. */
  async resolveForTarget(reference: string, target: SecretTarget, ctx: ProviderContext): Promise<SensitiveValue<unknown>> {
    await this.assertTargetPermitted(reference, target, ctx);
    return this.resolve(reference, ctx);
  }

  /** Target-aware fingerprint: enforces the configured policy before reading the value. */
  async fingerprintForTarget(reference: string, target: SecretTarget, ctx: ProviderContext): Promise<string> {
    await this.assertTargetPermitted(reference, target, ctx);
    return this.fingerprint(reference, ctx);
  }
}

/**
 * Wraps any `SecretProvider` with a target policy. The target-aware surface
 * (`resolveForTarget`, `fingerprintForTarget`, `assertTargetPermitted`) enforces the
 * policy; the plain contract surface delegates to the wrapped provider.
 */
export class TargetPolicySecretProvider implements SecretProvider {
  readonly inner: SecretProvider;
  readonly policy: SecretTargetPolicy;

  constructor(inner: SecretProvider, policy: SecretTargetPolicy) {
    this.inner = inner;
    this.policy = policy;
  }

  async resolve(reference: string, ctx: ProviderContext): Promise<SensitiveValue<unknown>> {
    return this.inner.resolve(reference, ctx);
  }

  async fingerprint(reference: string, ctx: ProviderContext): Promise<string> {
    return this.inner.fingerprint(reference, ctx);
  }

  async exists(reference: string, ctx: ProviderContext): Promise<boolean> {
    try {
      await this.inner.resolve(reference, ctx);
      return true;
    } catch (error) {
      if (error instanceof LaunchpadError && error.platform.class === 'NOT_FOUND') return false;
      throw error;
    }
  }

  async assertTargetPermitted(reference: string, target: SecretTarget, _ctx: ProviderContext): Promise<void> {
    if (!this.policy.allows(reference, target)) throw targetDenied(this.policy, reference, target);
  }

  async resolveForTarget(reference: string, target: SecretTarget, ctx: ProviderContext): Promise<SensitiveValue<unknown>> {
    await this.assertTargetPermitted(reference, target, ctx);
    return this.inner.resolve(reference, ctx);
  }

  async fingerprintForTarget(reference: string, target: SecretTarget, ctx: ProviderContext): Promise<string> {
    await this.assertTargetPermitted(reference, target, ctx);
    return this.inner.fingerprint(reference, ctx);
  }
}
