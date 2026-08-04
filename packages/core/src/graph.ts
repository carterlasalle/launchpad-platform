import type { DesiredApplication, ObservedApplication, ProviderName } from './types.js';

export interface ResourceNode {
  key: string;
  provider: ProviderName;
  resourceType: string;
  dependencies: string[];
  desired: unknown;
  observed: unknown;
}

export interface ResourceGraph { nodes: ResourceNode[]; }

function node(key: string, provider: ProviderName, resourceType: string, dependencies: string[], desired: unknown, observed: unknown): ResourceNode {
  return { key, provider, resourceType, dependencies, desired, observed };
}

export function buildResourceGraph(desired: DesiredApplication, observed: ObservedApplication): ResourceGraph {
  const resources = new Map(observed.resources.map((resource) => [resource.resourceKey, resource]));
  const nodes: ResourceNode[] = [
    node('github.repository', 'github', 'repository', [], desired.repository, resources.get('github.repository') ?? null),
    node('vercel.project', 'vercel', 'project', ['github.repository'], desired.vercel.project, resources.get('vercel.project') ?? null),
    node('vercel.git', 'vercel', 'git-connection', ['vercel.project'], desired.repository, resources.get('vercel.git') ?? null),
    node('vercel.settings', 'vercel', 'project-settings', ['vercel.project'], desired.vercel.project.settings, resources.get('vercel.settings') ?? null),
  ];
  for (const [environment, spec] of Object.entries(desired.environments)) {
    if (!spec) continue;
    nodes.push(node(`vercel.environment.${environment}`, 'vercel', 'environment', ['vercel.project'], spec, resources.get(`vercel.environment.${environment}`) ?? null));
  }
  for (const domain of desired.domains) {
    const domainKey = `vercel.domain.${domain.hostname}`;
    const dnsKey = `cloudflare.dns.${domain.hostname}`;
    const verifyKey = `domain.verification.${domain.hostname}`;
    nodes.push(node(domainKey, 'vercel', 'project-domain', ['vercel.project'], domain, resources.get(domainKey) ?? null));
    nodes.push(node(dnsKey, 'cloudflare', 'dns-record', [domainKey], domain.cloudflare, resources.get(dnsKey) ?? null));
    nodes.push(node(verifyKey, 'vercel', 'domain-verification', [dnsKey], domain, resources.get(verifyKey) ?? null));
  }
  const productionEnabled = desired.environments.production?.enabled !== false;
  if (productionEnabled) {
    nodes.push(node('production.candidate', 'vercel', 'deployment', ['vercel.project', 'vercel.git', 'domain.verification'], desired.environments.production ?? null, resources.get('production.candidate') ?? null));
    nodes.push(node('production.health', 'vercel', 'health-check', ['production.candidate'], desired.environments.production?.health ?? null, resources.get('production.health') ?? null));
    nodes.push(node('production.promotion', 'vercel', 'promotion', ['production.health'], desired.environments.production?.release ?? null, resources.get('production.promotion') ?? null));
    nodes.push(node('production.post-health', 'vercel', 'health-check', ['production.promotion'], desired.environments.production?.health ?? null, resources.get('production.post-health') ?? null));
  }
  return { nodes };
}
