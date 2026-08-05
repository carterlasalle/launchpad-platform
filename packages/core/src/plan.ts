import { canonicalJson, sha256Hex } from '@launchpad/shared';
import type { ProviderCapabilities } from './capabilities.js';
import { blockedOperation, diffApplication } from './diff.js';
import { redactDesired } from './fingerprints.js';
import { buildResourceGraph, topologicalLayers, validateResourceGraph } from './graph.js';
import { evaluatePolicies } from './policy.js';
import type { DesiredApplication, ObservedApplication, PlanMode, PlatformPlan, PlannedOperation, PolicyResult } from './types.js';

export interface BuildPlanInput {
  desired: DesiredApplication | null;
  observed: ObservedApplication;
  capabilities: ProviderCapabilities;
  sourceCommit: string;
  desiredGeneration: number;
  /** Expected ownership fingerprints recorded for this application (D1 resource_ownership), keyed by resourceKey. */
  ownership?: Record<string, string>;
  mode?: PlanMode;
  now?: string;
}

/**
 * Observed-state projection for fingerprinting: timestamps (observedAt,
 * createdAt, checkedAt) are excluded so equivalent observations at different
 * times produce identical plans. Ordering is normalized so equivalent state
 * in any resource order fingerprints identically.
 */
function observedFingerprintInput(observed: ObservedApplication): unknown {
  const latest = observed.health.latest;
  return {
    applicationId: observed.applicationId,
    desiredGeneration: observed.desiredGeneration,
    desiredHash: observed.desiredHash,
    observedHash: observed.observedHash,
    lifecycleState: observed.lifecycleState ?? null,
    resources: observed.resources
      .map(({ observedAt: _observedAt, ...resource }) => resource)
      .sort((left, right) => left.resourceKey.localeCompare(right.resourceKey)),
    deployments: observed.deployments
      .map(({ createdAt: _createdAt, ...deployment }) => deployment)
      .sort((left, right) => left.id.localeCompare(right.id)),
    health: latest === null
      ? { status: observed.health.status, latest: null }
      : {
          status: observed.health.status,
          latest: {
            id: latest.id,
            applicationId: latest.applicationId,
            environment: latest.environment,
            deploymentId: latest.deploymentId,
            url: latest.url,
            attempt: latest.attempt,
            dnsResolved: latest.dnsResolved,
            tlsValid: latest.tlsValid,
            statusCode: latest.statusCode,
            latencyMs: latest.latencyMs,
            assertionResults: latest.assertionResults,
            result: latest.result,
            errorCode: latest.errorCode,
          },
        },
  };
}

/**
 * Builds a deterministic plan from desired manifest state, observed provider
 * state, capability matrix, and ownership records. The fingerprint covers
 * the canonical desired manifest, application id, source commit, canonical
 * capabilities, observed/ownership state, resource graph with topological
 * layers, operations, downstream effects, drift, and policy results — and
 * never timestamps. Blocked plans (missing manifest, invalid graph,
 * unsupported fields, ambiguous ownership, policy blocks) fail closed.
 */
export async function buildPlan(input: BuildPlanInput): Promise<PlatformPlan> {
  const mode = input.mode ?? 'apply';
  const now = input.now ?? new Date().toISOString();
  const applicationId = input.desired?.metadata.id ?? input.observed.applicationId;
  const ownership = input.ownership ?? {};
  const observedStateHash = await sha256Hex(canonicalJson(observedFingerprintInput(input.observed)));
  const base = {
    schemaVersion: 'launchpad.plan/v1' as const,
    applicationId,
    desiredGeneration: input.desiredGeneration,
    sourceCommit: input.sourceCommit,
    createdAt: now,
    capabilitySnapshotHash: input.capabilities.snapshotHash,
    observedStateHash,
    mode,
  };

  const fingerprint = async (extra: Record<string, unknown>): Promise<string> => sha256Hex(canonicalJson({
    schemaVersion: 'launchpad.plan/v1',
    applicationId,
    mode,
    desiredGeneration: input.desiredGeneration,
    sourceCommit: input.sourceCommit,
    capabilities: canonicalJson(input.capabilities),
    desired: input.desired === null ? null : canonicalJson(input.desired),
    observed: canonicalJson(observedFingerprintInput(input.observed)),
    ownership,
    ...extra,
  }));

  if (input.desired === null) {
    const operations: PlannedOperation[] = [blockedOperation(applicationId, 'application.manifest', 'platform', 'manifest', 'The manifest for this application is missing from the catalog.')];
    const policyResults: PolicyResult[] = [{ rule: 'lifecycle.missingManifest', result: 'BLOCK', message: 'The manifest for this application is missing from the catalog; manifest removal never authorizes deletion.', remediation: 'Restore the manifest or run the reviewed decommission and destroy workflow.' }];
    const planFingerprint = await fingerprint({ blockedReason: 'BLOCKED_MISSING_MANIFEST', operations, policyResults });
    return { ...base, operations, downstreamEffects: [], policyResults, fingerprint: planFingerprint, result: 'BLOCKED', blockedReason: 'BLOCKED_MISSING_MANIFEST', layers: [], drift: null };
  }

  const graph = buildResourceGraph(input.desired, input.observed);
  const validation = validateResourceGraph(graph);
  const layers = validation.valid ? topologicalLayers(graph) ?? [] : [];
  if (!validation.valid) {
    const operations = validation.issues.map((issue) => blockedOperation(applicationId, issue.nodeKey ?? 'application.graph', 'platform', 'resource-graph', issue.message));
    const policyResults: PolicyResult[] = validation.issues.map((issue) => ({ rule: 'graph.valid', result: 'BLOCK', message: issue.message, remediation: 'Fix the manifest so the resource graph is acyclic with unique resource keys and known dependencies.' }));
    const planFingerprint = await fingerprint({ blockedReason: 'BLOCKED_INVALID_GRAPH', graph: validation.issues, operations, policyResults });
    return { ...base, operations, downstreamEffects: [], policyResults, fingerprint: planFingerprint, result: 'BLOCKED', blockedReason: 'BLOCKED_INVALID_GRAPH', layers, drift: null };
  }

  const diff = diffApplication(input.desired, input.observed, input.capabilities, { mode, ownership, now });
  const policyResults = evaluatePolicies(input.desired, diff.operations, diff.blocks);
  const driftRecords = [...diff.drift].sort((left, right) => left.resourceKey.localeCompare(right.resourceKey));
  const drift = mode === 'reconcile'
    ? { detected: driftRecords.length > 0, fingerprint: driftRecords.length > 0 ? await sha256Hex(canonicalJson(driftRecords)) : '', records: driftRecords }
    : null;
  const blocked = policyResults.some((result) => result.result === 'BLOCK');
  const destructive = diff.operations.some((operation) => operation.destructive);
  const result = blocked && destructive ? 'DESTRUCTIVE' : blocked ? 'BLOCKED' : 'READY';
  const blockedReason = blocked ? (diff.blocks[0]?.code ?? (destructive ? 'BLOCKED_DESTRUCTIVE_CHANGE' : 'LP-POLICY-BLOCK')) : null;
  const graphInput = graph.nodes.map((node) => ({ key: node.key, provider: node.provider, resourceType: node.resourceType, dependencies: node.dependencies }));
  const planFingerprint = await fingerprint({
    graph: { nodes: graphInput, layers },
    operations: diff.operations,
    downstreamEffects: diff.downstreamEffects,
    policyResults,
    drift: mode === 'reconcile' ? { detected: driftRecords.length > 0, records: driftRecords } : null,
  });

  return {
    ...base,
    operations: diff.operations,
    downstreamEffects: diff.downstreamEffects,
    policyResults,
    fingerprint: planFingerprint,
    result,
    blockedReason,
    layers,
    drift,
  };
}

/**
 * Source-commit-neutral review fingerprint of a computed plan.
 *
 * Binds a reviewed plan to its canonical plan semantics — desired
 * generation, observed/capability state hashes, operations, downstream
 * effects, policy results, graph layers, drift, and result — while excluding
 * `sourceCommit`, `createdAt`, and the plan's own fingerprint. A squash
 * merge therefore computes the identical review fingerprint at the merged
 * commit, while any change to desired state, provider state, or plan content
 * between review and apply changes it. Never includes raw environment or
 * secret values: every covered field carries keyed fingerprints only.
 */
export async function planReviewFingerprint(plan: PlatformPlan): Promise<string> {
  return sha256Hex(canonicalJson({
    schemaVersion: 'launchpad.plan-review/v1',
    applicationId: plan.applicationId,
    mode: plan.mode ?? 'apply',
    desiredGeneration: plan.desiredGeneration,
    result: plan.result,
    blockedReason: plan.blockedReason ?? null,
    observedStateHash: plan.observedStateHash,
    capabilitySnapshotHash: plan.capabilitySnapshotHash,
    operations: plan.operations,
    downstreamEffects: plan.downstreamEffects,
    policyResults: plan.policyResults,
    layers: plan.layers ?? [],
    drift: plan.drift === null || plan.drift === undefined ? null : { detected: plan.drift.detected, fingerprint: plan.drift.fingerprint, records: plan.drift.records },
  }));
}

/**
 * Deterministic desired-state hash for the plan-approval gate.
 *
 * Hashes the redacted desired manifest (secret values replaced with keyed
 * fingerprints), so the hash is stable for equivalent manifest content —
 * across a squash merge — and never incorporates raw secret values. Any
 * manifest change that leaves the plan semantics untouched still changes
 * this hash, so the attestation binding cannot be bypassed through plan
 * projection gaps.
 */
export async function desiredStateHash(desired: DesiredApplication): Promise<string> {
  return sha256Hex(canonicalJson(redactDesired(desired)));
}
