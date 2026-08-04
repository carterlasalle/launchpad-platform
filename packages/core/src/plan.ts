import { canonicalJson, sha256Hex } from '@launchpad/shared';
import type { ProviderCapabilities } from '@launchpad/provider-contract';
import { buildResourceGraph } from './graph.js';
import { diffApplication } from './diff.js';
import { evaluatePolicies } from './policy.js';
import type { DesiredApplication, ObservedApplication, PlatformPlan } from './types.js';

export interface BuildPlanInput { desired: DesiredApplication; observed: ObservedApplication; capabilities: ProviderCapabilities; sourceCommit: string; desiredGeneration: number; now?: string; }

export async function buildPlan(input: BuildPlanInput): Promise<PlatformPlan> {
  const graph = buildResourceGraph(input.desired, input.observed);
  const diff = diffApplication(input.desired, input.observed, input.capabilities);
  const policyResults = evaluatePolicies(input.desired, diff.operations);
  const observedStateHash = await sha256Hex(canonicalJson(input.observed.resources.slice().sort((left, right) => left.resourceKey.localeCompare(right.resourceKey))));
  const planInputs = { schemaVersion: 'launchpad.plan/v1', applicationId: input.desired.metadata.id, desiredGeneration: input.desiredGeneration, sourceCommit: input.sourceCommit, capabilitySnapshotHash: input.capabilities.snapshotHash, observedStateHash, graph: graph.nodes.map((node) => ({ key: node.key, provider: node.provider, resourceType: node.resourceType, dependencies: node.dependencies })), operations: diff.operations, downstreamEffects: diff.downstreamEffects, policyResults };
  const fingerprint = await sha256Hex(canonicalJson(planInputs));
  const blocked = policyResults.some((result) => result.result === 'BLOCK');
  const destructive = diff.operations.some((operation) => operation.destructive || operation.action === 'DESTROY');
  return { schemaVersion: 'launchpad.plan/v1', applicationId: input.desired.metadata.id, desiredGeneration: input.desiredGeneration, sourceCommit: input.sourceCommit, createdAt: input.now ?? new Date().toISOString(), capabilitySnapshotHash: input.capabilities.snapshotHash, observedStateHash, operations: diff.operations, downstreamEffects: diff.downstreamEffects, policyResults, fingerprint, result: blocked && destructive ? 'DESTRUCTIVE' : blocked ? 'BLOCKED' : 'READY' };
}
