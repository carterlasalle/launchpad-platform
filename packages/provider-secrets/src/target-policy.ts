import type { EnvironmentName } from '@launchpad/core';

/** The environment (and optionally application) a secret value is being targeted at. */
export interface SecretTarget {
  environment: EnvironmentName;
  applicationId?: string | null;
}

/**
 * Decides whether a secret reference may be resolved for a given target.
 * Policies guard the target-aware resolve surface; a policy is required whenever
 * production-only values must never enter preview or staging.
 */
export interface SecretTargetPolicy {
  allows(reference: string, target: SecretTarget): boolean;
  describe(reference: string, target: SecretTarget): string;
}

/**
 * Allowlist/denylist keyed by environment. An environment maps to `false` when it must
 * never receive the referenced secret; absent environments are permitted.
 */
export class EnvironmentTargetPolicy implements SecretTargetPolicy {
  readonly rules: Readonly<Partial<Record<EnvironmentName, boolean>>>;
  readonly reason: string;

  constructor(rules: Partial<Record<EnvironmentName, boolean>>, reason = 'This environment is not permitted for the referenced secret.') {
    this.rules = { ...rules };
    this.reason = reason;
  }

  allows(_reference: string, target: SecretTarget): boolean {
    return this.rules[target.environment] !== false;
  }

  describe(reference: string, target: SecretTarget): string {
    if (this.allows(reference, target)) return `Secret reference '${reference}' is permitted for environment '${target.environment}'.`;
    return `${this.reason} Environment '${target.environment}' is denied for secret reference '${reference}'.`;
  }
}

/** Production-only values never enter preview or staging. */
export const productionOnlyTargetPolicy = new EnvironmentTargetPolicy(
  { preview: false, staging: false, production: true },
  'Production-only secret values must never enter preview or staging.',
);
