import type { DesiredApplication, EnvironmentName, ObservedApplication, ProviderName } from './types.js';
import { redactDesired, redactEnvironmentSpec, secretBindingFingerprint, variableFingerprint } from './fingerprints.js';

export interface ResourceNode {
  key: string;
  provider: ProviderName;
  resourceType: string;
  dependencies: string[];
  desired: unknown;
  observed: unknown;
}

export interface ResourceGraph {
  nodes: ResourceNode[];
}

export type GraphIssueCode = 'DUPLICATE_KEY' | 'UNKNOWN_DEPENDENCY' | 'CYCLE';

export interface GraphIssue {
  code: GraphIssueCode;
  message: string;
  nodeKey?: string;
}

export interface GraphValidation {
  valid: boolean;
  issues: GraphIssue[];
}

function node(key: string, provider: ProviderName, resourceType: string, dependencies: string[], desired: unknown, observed: unknown): ResourceNode {
  return { key, provider, resourceType, dependencies, desired, observed };
}

/** Desired repository-access posture used by both the graph and the diff. */
export function accessDesired(desired: DesiredApplication): Record<string, unknown> {
  return {
    productionBranch: desired.repository.productionBranch,
    deploymentRef: desired.repository.deploymentRef,
    requirePrivateAccessVerification: desired.repository.access?.requirePrivateAccessVerification ?? true,
    requireVercelGitAccess: desired.repository.access?.requireVercelGitAccess ?? true,
  };
}

/**
 * Compiles a manifest into the directed acyclic resource graph. Every
 * manifest dimension contributes nodes: repository and repository access,
 * project/Git/settings, environments and keyed variable/secret fingerprints,
 * domains, DNS, verification and TLS, the staged candidate/health/promotion/
 * post-health release chain, the lifecycle record, and the manifest itself.
 */
export function buildResourceGraph(desired: DesiredApplication, observed: ObservedApplication): ResourceGraph {
  const resources = new Map(observed.resources.map((resource) => [resource.resourceKey, resource]));
  const nodes: ResourceNode[] = [
    node('application.manifest', 'platform', 'manifest', [], redactDesired(desired), null),
    node('github.repository', 'github', 'repository', ['application.manifest'], desired.repository, resources.get('github.repository') ?? null),
    node('github.repository-access', 'github', 'repository-access', ['github.repository'], accessDesired(desired), resources.get('github.repository-access') ?? null),
    node('vercel.project', 'vercel', 'project', ['github.repository'], desired.vercel.project, resources.get('vercel.project') ?? resources.get(desired.metadata.id) ?? null),
    node('vercel.git', 'vercel', 'git-connection', ['vercel.project'], desired.vercel.project.git, resources.get('vercel.git') ?? null),
    node('vercel.settings', 'vercel', 'project-settings', ['vercel.project'], desired.vercel.project.settings, resources.get('vercel.settings') ?? null),
  ];
  const productionDomainVerification: string[] = [];
  for (const [environment, spec] of Object.entries(desired.environments)) {
    if (!spec || spec.enabled === false) continue;
    const envKey = `vercel.environment.${environment}`;
    nodes.push(node(envKey, 'vercel', 'environment', ['vercel.project'], redactEnvironmentSpec(spec, environment), resources.get(envKey) ?? null));
    for (const [name, binding] of Object.entries(spec.variables ?? {})) {
      const key = `vercel.variable.${environment}.${name}`;
      nodes.push(node(key, 'vercel', 'environment-variable', [envKey], { fingerprint: variableFingerprint(environment, name, binding) }, resources.get(key) ?? null));
    }
    for (const binding of desired.secrets) {
      if (!binding.environments.includes(environment as EnvironmentName)) continue;
      const key = `vercel.variable.${environment}.${binding.name}`;
      nodes.push(node(key, 'vercel', 'environment-variable', [envKey], { fingerprint: secretBindingFingerprint(environment as EnvironmentName, binding) }, resources.get(key) ?? null));
    }
  }
  for (const domain of desired.domains) {
    const domainKey = `vercel.domain.${domain.hostname}`;
    const dnsKey = `cloudflare.dns.${domain.hostname}`;
    const verifyKey = `domain.verification.${domain.hostname}`;
    nodes.push(node(domainKey, 'vercel', 'project-domain', ['vercel.project'], domain, resources.get(domainKey) ?? null));
    nodes.push(node(dnsKey, 'cloudflare', 'dns-record', [domainKey], domain.cloudflare, resources.get(dnsKey) ?? null));
    nodes.push(node(verifyKey, 'vercel', 'domain-verification', [dnsKey], { hostname: domain.hostname }, resources.get(verifyKey) ?? null));
    if (domain.environment === 'production') productionDomainVerification.push(verifyKey);
    const tls = desired.environments[domain.environment]?.health?.tls;
    if (tls?.required) {
      const tlsKey = `domain.tls.${domain.hostname}`;
      nodes.push(node(tlsKey, 'vercel', 'domain-tls', [verifyKey], tls, resources.get(tlsKey) ?? null));
    }
  }
  const productionEnabled = desired.environments.production?.enabled !== false && desired.lifecycle.state !== 'approved-for-deletion' && desired.lifecycle.state !== 'deleted';
  if (productionEnabled) {
    nodes.push(node('production.candidate', 'vercel', 'deployment', ['vercel.project', 'vercel.git', ...productionDomainVerification], desired.environments.production ? redactEnvironmentSpec(desired.environments.production, 'production') : null, resources.get('production.candidate') ?? null));
    nodes.push(node('production.health', 'vercel', 'health-check', ['production.candidate'], desired.environments.production?.health ?? null, resources.get('production.health') ?? null));
    nodes.push(node('production.promotion', 'vercel', 'promotion', ['production.health'], desired.environments.production?.release ?? null, resources.get('production.promotion') ?? null));
    nodes.push(node('production.post-health', 'vercel', 'health-check', ['production.promotion'], desired.environments.production?.health ?? null, resources.get('production.post-health') ?? null));
  }
  nodes.push(node(
    'application.lifecycle',
    'platform',
    'lifecycle',
    ['application.manifest'],
    { state: desired.lifecycle.state, deletionProtection: desired.lifecycle.deletionProtection, orphanPolicy: desired.lifecycle.orphanPolicy },
    observed.lifecycleState ? { state: observed.lifecycleState } : null,
  ));
  return { nodes };
}

/**
 * Validates graph invariants: no duplicate node keys (duplicate domains or
 * variable declarations), every dependency refers to a real node, and the
 * dependency relation is acyclic. Invalid graphs block planning.
 */
export function validateResourceGraph(graph: ResourceGraph): GraphValidation {
  const issues: GraphIssue[] = [];
  const seen = new Map<string, ResourceNode>();
  for (const graphNode of graph.nodes) {
    if (seen.has(graphNode.key)) issues.push({ code: 'DUPLICATE_KEY', message: `Duplicate resource node '${graphNode.key}'.`, nodeKey: graphNode.key });
    seen.set(graphNode.key, graphNode);
  }
  for (const graphNode of graph.nodes) {
    for (const dependency of graphNode.dependencies) {
      if (!seen.has(dependency)) issues.push({ code: 'UNKNOWN_DEPENDENCY', message: `Node '${graphNode.key}' depends on unknown resource '${dependency}'.`, nodeKey: graphNode.key });
    }
  }
  if (issues.length === 0 && topologicalLayers(graph) === null) issues.push({ code: 'CYCLE', message: 'Resource dependency graph contains a cycle.' });
  return { valid: issues.length === 0, issues };
}

/**
 * Deterministic topological layers via Kahn's algorithm. Within each layer
 * nodes are sorted by key, so equivalent graphs always produce identical
 * layers. Returns null when the graph cannot be fully ordered (cycle or
 * unknown dependencies) — call validateResourceGraph first.
 */
export function topologicalLayers(graph: ResourceGraph): string[][] | null {
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const graphNode of graph.nodes) {
    indegree.set(graphNode.key, graphNode.dependencies.length);
    for (const dependency of graphNode.dependencies) {
      const list = dependents.get(dependency) ?? [];
      list.push(graphNode.key);
      dependents.set(dependency, list);
    }
  }
  const layers: string[][] = [];
  const ready = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([key]) => key).sort();
  const placed = new Set<string>();
  while (ready.length > 0) {
    layers.push([...ready]);
    const next: string[] = [];
    for (const key of ready) {
      placed.add(key);
      for (const dependent of dependents.get(key) ?? []) {
        if (placed.has(dependent)) continue;
        const degree = (indegree.get(dependent) ?? 1) - 1;
        indegree.set(dependent, degree);
        if (degree === 0) next.push(dependent);
      }
    }
    ready.length = 0;
    ready.push(...next.sort());
  }
  return placed.size === graph.nodes.length ? layers : null;
}
