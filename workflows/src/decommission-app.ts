import { canonicalJson, idempotencyKey } from '@launchpad/shared';
import type { DesiredApplication, ObservedApplication } from '@launchpad/core';
import { LaunchpadRepositories } from '@launchpad/database';
import type { DnsProvider, ProjectProvider, ProviderContext } from '@launchpad/provider-contract';

export interface DecommissionInput { provider: ProjectProvider & DnsProvider; repositories: LaunchpadRepositories; desired: DesiredApplication; observed: ObservedApplication; approvalToken: string; now: string; context: ProviderContext; }
export interface DecommissionResult { status: 'DELETED' | 'BLOCKED'; applicationId: string; exportJson: string; tombstone: { applicationId: string; domain: string; retainUntil: string } | null; errorCode: string | null; }

export async function decommissionApplication(input: DecommissionInput): Promise<DecommissionResult> {
  const lifecycle = input.desired.lifecycle;
  if (lifecycle.state !== 'approved-for-deletion') return { status: 'BLOCKED', applicationId: input.desired.metadata.id, exportJson: '', tombstone: null, errorCode: 'LP-DESTROY-LIFECYCLE-BLOCKED' };
  if (lifecycle.deletionProtection || lifecycle.decommission.approvalToken !== input.approvalToken) return { status: 'BLOCKED', applicationId: input.desired.metadata.id, exportJson: '', tombstone: null, errorCode: 'LP-DESTROY-APPROVAL-INVALID' };
  if (!lifecycle.decommission.deleteAfter || new Date(input.now).getTime() < new Date(lifecycle.decommission.deleteAfter).getTime()) return { status: 'BLOCKED', applicationId: input.desired.metadata.id, exportJson: '', tombstone: null, errorCode: 'LP-DESTROY-COOLING-OFF' };
  if (input.desired.dependencies.applications.length > 0) return { status: 'BLOCKED', applicationId: input.desired.metadata.id, exportJson: '', tombstone: null, errorCode: 'LP-DESTROY-DEPENDENTS' };
  const exportJson = canonicalJson({ application: input.desired.metadata, resources: input.observed.resources, deployments: input.observed.deployments });
  for (const domain of input.desired.domains) {
    const zone = await input.provider.observeZone(domain.cloudflare.zoneRef, input.context);
    const record = await input.provider.observeRecord(zone.zoneId, domain.hostname, input.context);
    const ownershipFingerprint = idempotencyKey('ownership', input.desired.metadata.id, domain.hostname);
    if (record && record.ownershipFingerprint !== null && record.ownershipFingerprint !== ownershipFingerprint) return { status: 'BLOCKED', applicationId: input.desired.metadata.id, exportJson, tombstone: null, errorCode: 'LP-DNS-CONFLICT-UNOWNED' };
    if (record) await input.provider.deleteRecord(zone.zoneId, record.id, input.context);
  }
  await input.provider.deleteProject(input.desired.metadata.id, input.context);
  const firstDomain = input.desired.domains[0]?.hostname ?? `${input.desired.metadata.id}.unknown`;
  const retainUntil = new Date(new Date(input.now).getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const tombstone = { applicationId: input.desired.metadata.id, domain: firstDomain, retainUntil };
  input.repositories.createTombstone({ ...tombstone, deletedAt: input.now });
  input.repositories.appendAudit({ actor: `${input.context.actor.kind}:${input.context.actor.id}`, action: 'DELETED', applicationId: input.desired.metadata.id, details: { retainUntil } });
  return { status: 'DELETED', applicationId: input.desired.metadata.id, exportJson, tombstone, errorCode: null };
}
