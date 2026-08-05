import type { ProviderName } from './types.js';

/**
 * Provider-neutral capability matrix for a single manageable field.
 *
 * The planner uses this matrix as a plan input: a desired field that is
 * changed or created without a declared capability (or with the required
 * operation disabled) produces a BLOCKED plan rather than a guessed write.
 */
export interface FieldCapability {
  read: boolean;
  create: boolean;
  update: boolean;
  delete: boolean;
  requiresRedeploy: boolean;
  destructiveWhenChanged: boolean;
}

/**
 * Snapshot of what an adapter can manage, used to validate every planned
 * mutation before any provider write. Deterministic for fingerprinting:
 * every member is canonicalizable and none contains timestamps.
 */
export interface ProviderCapabilities {
  provider: ProviderName | 'fake';
  adapterVersion: string;
  fields: Record<string, FieldCapability>;
  features: Record<string, boolean>;
  snapshotHash: string;
}
