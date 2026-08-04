import type { DesiredApplication, LifecycleState } from '@launchpad/core';
import type { CatalogIssue } from './source.js';

function issue(file: string, code: string, path: string, message: string, remediation: string | null = null): CatalogIssue {
  return { code, file, line: 1, column: 1, path, message, remediation };
}

function hasCycle(applications: DesiredApplication[]): string[] | null {
  const graph = new Map(applications.map((app) => [app.metadata.id, app.dependencies.applications]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    if (visiting.has(id)) return [...stack.slice(stack.indexOf(id)), id];
    if (visited.has(id)) return null;
    visiting.add(id);
    stack.push(id);
    for (const dependency of graph.get(id) ?? []) {
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
    return null;
  };
  for (const app of applications) {
    const cycle = visit(app.metadata.id);
    if (cycle) return cycle;
  }
  return null;
}

function validTransition(previous: LifecycleState, next: LifecycleState): boolean {
  if (previous === next) return true;
  if (previous === 'active') return next === 'decommissioning';
  if (previous === 'decommissioning') return next === 'approved-for-deletion' || next === 'active';
  if (previous === 'approved-for-deletion') return next === 'deleted';
  return false;
}

export function validateSemantics(applications: DesiredApplication[], files: Map<string, string>, previousLifecycle: Record<string, string>): CatalogIssue[] {
  const issues: CatalogIssue[] = [];
  const ids = new Map<string, DesiredApplication>();
  const projects = new Map<string, DesiredApplication>();
  const domains = new Map<string, DesiredApplication>();
  const knownIds = new Set(applications.map((app) => app.metadata.id));

  for (const app of applications) {
    const file = app.sourcePath ?? 'catalog';
    const idOwner = ids.get(app.metadata.id);
    if (idOwner) issues.push(issue(file, 'LP-CATALOG-DUPLICATE-ID', 'metadata.id', `Application ID '${app.metadata.id}' is already declared.`, 'Choose a globally unique stable ID.'));
    ids.set(app.metadata.id, app);
    const projectName = app.vercel.project.name;
    if (projects.has(projectName)) issues.push(issue(file, 'LP-CATALOG-DUPLICATE-PROJECT', 'vercel.project.name', `Vercel project '${projectName}' is already declared.`, 'Choose a unique project name.'));
    projects.set(projectName, app);
    for (const domain of app.domains) {
      if (domains.has(domain.hostname)) issues.push(issue(file, 'LP-CATALOG-DUPLICATE-DOMAIN', `domains.${domain.hostname}`, `Hostname '${domain.hostname}' is already declared.`, 'Assign each hostname to one application and environment.'));
      domains.set(domain.hostname, app);
      if (domain.cloudflare.mode === 'proxied' && domain.cloudflare.proxy?.acknowledgeDoubleCdn !== true) issues.push(issue(file, 'LP-DNS-PROXY-ACKNOWLEDGMENT', `domains.${domain.hostname}.cloudflare.proxy.acknowledgeDoubleCdn`, 'Proxied mode requires explicit double-CDN acknowledgment.', 'Set acknowledgeDoubleCdn: true after compatibility review.'));
    }
    for (const dependency of app.dependencies.applications) {
      if (!knownIds.has(dependency)) issues.push(issue(file, 'LP-CATALOG-MISSING-DEPENDENCY', 'dependencies.applications', `Application dependency '${dependency}' does not exist.`, 'Declare the dependency or remove the reference.'));
    }
    for (const secret of app.secrets) {
      if ((secret.source === undefined) === (secret.value === undefined)) issues.push(issue(file, 'LP-SECRET-SOURCE', `secrets.${secret.name}`, 'A secret must define exactly one source reference or non-sensitive value.', 'Use source for sensitive values and value only when sensitive is false.'));
      if (secret.sensitive === true && secret.value !== undefined) issues.push(issue(file, 'LP-SECRET-PLAINTEXT', `secrets.${secret.name}.value`, 'Sensitive values must not be stored in the catalog.', 'Use a provider secret reference.'));
    }
    const previous = previousLifecycle[app.metadata.id];
    if (previous && !validTransition(previous as LifecycleState, app.lifecycle.state)) issues.push(issue(file, 'LP-LIFECYCLE-TRANSITION', 'lifecycle.state', `Lifecycle transition '${previous}' → '${app.lifecycle.state}' is not allowed.`, 'Use the explicit decommissioning workflow.'));
    if (app.lifecycle.state === 'approved-for-deletion' && app.lifecycle.deletionProtection) issues.push(issue(file, 'LP-LIFECYCLE-PROTECTION', 'lifecycle.deletionProtection', 'Deletion approval requires deletionProtection: false.', 'Complete the reviewed deletion approval flow.'));
  }
  const cycle = hasCycle(applications);
  if (cycle) issues.push(issue(applications.find((app) => app.metadata.id === cycle[0])?.sourcePath ?? 'catalog', 'LP-CATALOG-DEPENDENCY-CYCLE', 'dependencies.applications', `Dependency cycle detected: ${cycle.join(' → ')}.`, 'Remove one dependency edge.'));
  if (files.size === 0) issues.push(issue('catalog', 'LP-CATALOG-EMPTY', '$', 'The catalog contains no application manifests.', 'Add at least one application manifest.'));
  return issues;
}
