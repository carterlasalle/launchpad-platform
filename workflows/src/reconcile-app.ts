import { canonicalJson, stableId } from '@launchpad/shared';
import type { DesiredApplication, ObservedApplication } from '@launchpad/core';
import type { ProjectProvider, ProviderContext, SourceProvider } from '@launchpad/provider-contract';

export interface DriftRecord { resourceKey: string; desired: unknown; observed: unknown; category: 'CHANGED_SETTING' | 'MISSING_RESOURCE' | 'ACCESS_DRIFT' | 'UNKNOWN'; }
export interface ReconcileInput { provider: ProjectProvider; source: SourceProvider; desired: DesiredApplication; observed: ObservedApplication; context: ProviderContext; mode: 'open-pr' | 'auto-restore' | 'adopt-observed-state'; mainCommit: string; }
export interface ReconcileResult { status: 'SYNCED' | 'OUT_OF_SYNC' | 'UNKNOWN'; drift: DriftRecord[]; driftFingerprint: string | null; pullRequest: { number: number; url: string } | null; operation: 'restore-desired-state' | 'adopt-observed-state' | null; manifest: string | null; }

export async function reconcileApplication(input: ReconcileInput): Promise<ReconcileResult> {
  let observedProject = input.observed.resources.find((resource) => resource.resourceKey === 'vercel.project' || resource.resourceKey === input.desired.metadata.id);
  try {
    observedProject = await input.provider.observeProject({ projectId: input.desired.metadata.id }, input.context) ?? observedProject;
  } catch {
    return { status: 'UNKNOWN', drift: [{ resourceKey: 'vercel.project', desired: input.desired.vercel.project, observed: null, category: 'UNKNOWN' }], driftFingerprint: null, pullRequest: null, operation: null, manifest: null };
  }
  const drift: DriftRecord[] = [];
  const observedRoot = typeof observedProject?.configuration.rootDirectory === 'string' ? observedProject.configuration.rootDirectory : null;
  if (!observedProject) drift.push({ resourceKey: 'vercel.project', desired: input.desired.vercel.project, observed: null, category: 'MISSING_RESOURCE' });
  else if (observedRoot !== input.desired.vercel.project.rootDirectory) drift.push({ resourceKey: 'vercel.project.rootDirectory', desired: input.desired.vercel.project.rootDirectory, observed: observedRoot, category: 'CHANGED_SETTING' });
  if (drift.length === 0) return { status: 'SYNCED', drift, driftFingerprint: null, pullRequest: null, operation: null, manifest: null };
  const driftFingerprint = stableId('drift', input.desired.metadata.id, canonicalJson(drift));
  if (input.mode === 'auto-restore') throw new Error('LP-RECONCILIATION-AUTO-RESTORE-DISABLED');
  const operation = input.mode === 'adopt-observed-state' ? 'adopt-observed-state' : 'restore-desired-state';
  const branch = `reconcile/${input.desired.metadata.id}/${driftFingerprint}`;
  const adoptedManifest = operation === 'adopt-observed-state' && observedRoot ? JSON.stringify({ ...input.desired, vercel: { ...input.desired.vercel, project: { ...input.desired.vercel.project, rootDirectory: observedRoot } } }, null, 2) : null;
  const body = `## Launchpad reconciliation\n\nApplication: ${input.desired.metadata.id}\nDesired commit: ${input.mainCommit}\nDrift fingerprint: ${driftFingerprint}\nOperation: ${operation}\n\n${drift.map((item) => `- ${item.resourceKey}: ${item.category}\n  Desired: ${JSON.stringify(item.desired)}\n  Observed: ${JSON.stringify(item.observed)}`).join('\n')}\n\n${operation === 'adopt-observed-state' ? 'This PR updates Git to the observed provider setting after review.' : 'This PR restores the Git-defined setting after review.'}`;
  const files = operation === 'adopt-observed-state' && adoptedManifest ? { [`catalog/apps/${input.desired.metadata.id}.yaml`]: adoptedManifest } : { [`reconciliation/${input.desired.metadata.id}.yaml`]: `apiVersion: launchpad.dev/v1\nkind: ReconciliationRequest\nmetadata:\n  app: ${input.desired.metadata.id}\nspec:\n  desiredGeneration: ${input.observed.desiredGeneration}\n  operation: ${operation}\n  driftFingerprint: ${driftFingerprint}\n` };
  const pullRequest = await input.source.createOrUpdatePullRequest({ repository: input.desired.repository.name, branch, title: `reconcile: ${input.desired.metadata.id} drift ${driftFingerprint}`, body, files }, input.context);
  return { status: 'OUT_OF_SYNC', drift, driftFingerprint, pullRequest, operation, manifest: adoptedManifest };
}
