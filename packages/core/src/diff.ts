import { idempotencyKey, stableId } from '@launchpad/shared';
import type { ProviderCapabilities } from '@launchpad/provider-contract';
import type { DesiredApplication, DownstreamEffect, ObservedApplication, PlannedAction, PlannedOperation } from './types.js';

function operation(input: { key: string; provider: PlannedOperation['provider']; type: string; action: PlannedAction; before: unknown; after: unknown; prerequisites?: string[]; invalidates?: string[]; destructive?: boolean; retryClass?: PlannedOperation['retryClass'] }): PlannedOperation {
  return { id: stableId('operation', input.key, input.action), resourceKey: input.key, provider: input.provider, resourceType: input.type, action: input.action, before: input.before, after: input.after, prerequisites: input.prerequisites ?? [], invalidates: input.invalidates ?? [], idempotencyKey: idempotencyKey('operation', input.key, input.action), destructive: input.destructive ?? input.action === 'DESTROY', retryClass: input.retryClass ?? 'NONE' };
}

function projectFields(desired: DesiredApplication): Record<string, unknown> {
  const project = desired.vercel.project;
  return { name: project.name, framework: project.framework, rootDirectory: project.rootDirectory, nodeVersion: project.nodeVersion, installCommand: project.build.installCommand, buildCommand: project.build.buildCommand, outputDirectory: project.build.outputDirectory, ...project.settings };
}

function changedFields(desired: Record<string, unknown>, observed: Record<string, unknown>): string[] {
  return Object.keys(desired).filter((key) => JSON.stringify(desired[key]) !== JSON.stringify(observed[key]));
}

export interface DiffResult { operations: PlannedOperation[]; downstreamEffects: DownstreamEffect[]; }

export function diffApplication(desired: DesiredApplication, observed: ObservedApplication, capabilities: ProviderCapabilities): DiffResult {
  const operations: PlannedOperation[] = [];
  const downstreamEffects: DownstreamEffect[] = [];
  const resources = new Map(observed.resources.map((resource) => [resource.resourceKey, resource]));
  const projectResource = resources.get('vercel.project') ?? resources.get(desired.metadata.id);
  if (desired.lifecycle.state === 'approved-for-deletion' || desired.lifecycle.state === 'deleted') {
    operations.push(operation({ key: 'application.destroy', provider: 'vercel', type: 'application', action: 'DESTROY', before: observed.resources, after: null, destructive: true }));
    return { operations, downstreamEffects };
  }
  const projectDesired = projectFields(desired);
  const projectObserved = projectResource?.configuration ?? {};
  const projectChanges = changedFields(projectDesired, projectObserved);
  if (!projectResource) operations.push(operation({ key: 'vercel.project', provider: 'vercel', type: 'project', action: 'CREATE', before: null, after: projectDesired, retryClass: 'TRANSIENT' }));
  else if (projectChanges.length > 0) {
    operations.push(operation({ key: 'vercel.project', provider: 'vercel', type: 'project', action: 'UPDATE_IN_PLACE', before: projectObserved, after: projectDesired, retryClass: 'TRANSIENT' }));
    for (const field of projectChanges) {
      const capability = capabilities.fields[`project.${field}`] ?? capabilities.fields[`project.settings.${field}`];
      if (capability?.requiresRedeploy ?? ['rootDirectory', 'framework', 'nodeVersion', 'installCommand', 'buildCommand', 'outputDirectory'].includes(field)) {
        downstreamEffects.push({ resourceKey: 'production.candidate', action: 'REDEPLOY_REQUIRED', reason: `Project field '${field}' changes the build output.`, severity: 'INFO' });
      }
    }
  } else operations.push(operation({ key: 'vercel.project', provider: 'vercel', type: 'project', action: 'NO_CHANGE', before: projectObserved, after: projectDesired }));

  if (!resources.has('github.repository')) operations.push(operation({ key: 'github.repository', provider: 'github', type: 'repository-access', action: 'CREATE', before: null, after: desired.repository, retryClass: 'TRANSIENT' }));
  if (!resources.has('vercel.git')) operations.push(operation({ key: 'vercel.git', provider: 'vercel', type: 'git-connection', action: 'CREATE', before: null, after: desired.repository, prerequisites: ['vercel.project'], retryClass: 'TRANSIENT' }));
  for (const domain of desired.domains) {
    const domainKey = `vercel.domain.${domain.hostname}`;
    const dnsKey = `cloudflare.dns.${domain.hostname}`;
    if (!resources.has(domainKey)) operations.push(operation({ key: domainKey, provider: 'vercel', type: 'project-domain', action: 'CREATE', before: null, after: domain, prerequisites: ['vercel.project'], retryClass: 'PROVIDER_EVENTUAL_CONSISTENCY' }));
    if (!resources.has(dnsKey)) operations.push(operation({ key: dnsKey, provider: 'cloudflare', type: 'dns-record', action: 'CREATE', before: null, after: domain.cloudflare, prerequisites: [domainKey], retryClass: 'PROVIDER_EVENTUAL_CONSISTENCY' }));
  }
  const deployRequired = operations.some((candidate) => candidate.action === 'CREATE' || candidate.action === 'UPDATE_IN_PLACE') || downstreamEffects.some((effect) => effect.resourceKey === 'production.candidate');
  if (deployRequired || !resources.has('production.candidate')) {
    operations.push(operation({ key: 'production.candidate', provider: 'vercel', type: 'deployment', action: 'REDEPLOY_REQUIRED', before: resources.get('production.candidate')?.configuration ?? null, after: desired.environments.production ?? null, prerequisites: ['vercel.project', 'vercel.git'], invalidates: ['production.health'], retryClass: 'TRANSIENT' }));
    operations.push(operation({ key: 'production.health', provider: 'vercel', type: 'health-check', action: 'REDEPLOY_REQUIRED', before: null, after: desired.environments.production?.health ?? null, prerequisites: ['production.candidate'], retryClass: 'PROVIDER_EVENTUAL_CONSISTENCY' }));
    operations.push(operation({ key: 'production.promotion', provider: 'vercel', type: 'promotion', action: 'PROMOTE', before: null, after: desired.environments.production?.release ?? null, prerequisites: ['production.health'], retryClass: 'TRANSIENT' }));
  }
  return { operations, downstreamEffects };
}
