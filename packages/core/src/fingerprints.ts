import { stableId } from '@launchpad/shared';
import type { DesiredApplication, EnvironmentName, EnvironmentSpec, SecretBinding } from './types.js';

/**
 * Desired-state variable binding: either a literal value or a structured
 * sensitive reference. Sensitive references are never resolved inside the
 * planner; only their keyed fingerprint participates in plans.
 */
export type VariableBinding = string | { secretRef: string; sensitive: true };

/**
 * Deterministic keyed fingerprint of a manifest-level variable binding.
 *
 * The key binds the fingerprint to the environment and variable name, so the
 * same value in different variables produces different fingerprints, and the
 * raw value is never retained — only this hash enters plans, graphs, drift
 * records, and artifacts. Sync (FNV-1a) because the planner is sync; this is
 * the desired-side contract (what Git controls). Provider-observed value
 * fingerprints (e.g. SensitiveValue.keyedFingerprint) arrive inside observed
 * resource configuration and are compared canonically against this value.
 */
export function variableFingerprint(environment: string, name: string, binding: VariableBinding | undefined): string | null {
  if (binding === undefined) return null;
  return typeof binding === 'string'
    ? stableId('variable-fingerprint', environment, name, binding)
    : stableId('secret-ref-fingerprint', environment, name, binding.secretRef);
}

/**
 * Keyed fingerprint for a manifest-level secret binding. Reference-based
 * bindings fingerprint the reference; value-based bindings fingerprint the
 * value keyed by environment and binding name.
 */
export function secretBindingFingerprint(environment: EnvironmentName, binding: SecretBinding): string {
  if (binding.source !== undefined) return stableId('secret-ref-fingerprint', environment, binding.name, binding.source);
  return stableId('variable-fingerprint', environment, binding.name, binding.value ?? binding.name);
}

/**
 * Environment projection safe for plans, graphs, and artifacts: variable
 * bindings are replaced with their keyed fingerprints so raw values and
 * secret references never serialize.
 */
export function redactEnvironmentSpec(spec: EnvironmentSpec, environment: string): Record<string, unknown> {
  return {
    ...spec,
    variables: Object.fromEntries(
      Object.entries(spec.variables ?? {}).map(([name, binding]) => [name, { fingerprint: variableFingerprint(environment, name, binding) }]),
    ),
  };
}

/** Manifest projection safe for plans, graphs, and artifacts. */
export function redactDesired(desired: DesiredApplication): unknown {
  return {
    ...desired,
    environments: Object.fromEntries(
      Object.entries(desired.environments).map(([environment, spec]) => [environment, spec ? redactEnvironmentSpec(spec, environment) : spec]),
    ),
    secrets: desired.secrets.map((binding) => ({
      ...binding,
      ...(binding.value === undefined ? {} : { value: stableId('variable-fingerprint', '', binding.name, binding.value) }),
    })),
  };
}
