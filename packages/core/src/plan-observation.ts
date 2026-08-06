import { stableId } from '@launchpad/shared';
import type { DeploymentRecord, DesiredApplication, ObservedApplication, ObservedResource } from './types.js';

/**
 * Non-trivial desired projection that satisfies the planner's comparison when
 * the apply pipeline does not read the resource back.
 */
export function satisfiedProjection(desired: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(desired)) {
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}

/** DNS evidence observed for one production domain of the desired application. */
export interface PlanDnsObservation {
  domain: DesiredApplication['domains'][number];
  zoneId: string;
  record: { id: string; ownershipFingerprint: string | null } | null;
}

/**
 * Assembles the observed-state projection used for plan computation.
 *
 * This is the single shared contract between the approving CLI (which sees
 * only live provider state) and the apply machine's replan gate (which could
 * see store bookkeeping too). Both sides MUST call this builder so the
 * recomputed plan fingerprint is satisfiable by construction; store-derived
 * bookkeeping (desired generation records, health-check history, deployment
 * rows, lifecycle records, ownership tables) is deliberately NOT reflected
 * here — the approved plan cannot see it, so the replan gate must not either.
 * Deployments are the provider-visible deployment for the exact source
 * commit, health is UNKNOWN until execution-time checks, and lifecycle state
 * comes from the manifest (`desired`) rather than the store.
 */
export function buildPlanObservedState(input: {
  applicationId: string;
  desired: DesiredApplication;
  project: ObservedResource | null;
  deployment: DeploymentRecord | null;
  dns: PlanDnsObservation[];
}): ObservedApplication {
  const { applicationId, desired, project, deployment, dns } = input;
  const now = new Date().toISOString();
  const resources: ObservedResource[] = [];
  if (project) resources.push(project);
  for (const observation of dns) {
    const domain = observation.domain;
    const domainKey = `vercel.domain.${domain.hostname}`;
    const domainProjection = satisfiedProjection({ hostname: domain.hostname, environment: domain.environment, canonical: domain.canonical ?? false, mode: domain.cloudflare.mode, ttl: domain.cloudflare.ttl, zoneRef: domain.cloudflare.zoneRef });
    resources.push({ provider: 'vercel', resourceType: 'project-domain', resourceKey: domainKey, providerResourceId: `${desired.metadata.id}:${domain.hostname}`, configuration: domainProjection, ownershipFingerprint: stableId('ownership', 'project-domain', domainKey), observedAt: now });
    if (observation.record !== null) {
      resources.push({ provider: 'cloudflare', resourceType: 'dns-record', resourceKey: `cloudflare.dns.${domain.hostname}`, providerResourceId: observation.record.id, configuration: { zoneRef: domain.cloudflare.zoneRef, mode: domain.cloudflare.mode, ttl: domain.cloudflare.ttl, proxied: domain.cloudflare.mode === 'proxied' }, ownershipFingerprint: observation.record.ownershipFingerprint, observedAt: now });
    }
  }
  return {
    applicationId,
    observedAt: now,
    desiredGeneration: 0,
    desiredHash: '',
    observedHash: '',
    lifecycleState: null,
    resources,
    deployments: deployment === null ? [] : [deployment],
    health: { status: 'UNKNOWN', latest: null },
  };
}
