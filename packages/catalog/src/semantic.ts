import type { DesiredApplication, EnvironmentName, LifecycleState } from '@launchpad/core';
import type { CatalogIssue, PreviousRepository } from './source.js';

export interface SemanticValidationContext {
  files: ReadonlyMap<string, string>;
  resolvePosition(file: string, path: string): { line: number; column: number };
  previousLifecycle?: Record<string, string>;
  previousRepositories?: Record<string, PreviousRepository>;
  zones?: readonly string[];
}

const previewOnlyStrategies: Record<string, true> = { 'native-preview': true, 'shadow-project': true };
const teardownStates: Record<string, true> = { decommissioning: true, 'approved-for-deletion': true, deleted: true };

function issue(file: string, code: string, path: string, message: string, remediation: string, position: { line: number; column: number }): CatalogIssue {
  return { code, file, line: position.line, column: position.column, path, message, remediation };
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

function validTransition(previous: LifecycleState, next: LifecycleState, allowReactivate: boolean): boolean {
  if (previous === next) return true;
  if (previous === 'active') return next === 'decommissioning';
  if (previous === 'decommissioning') return next === 'approved-for-deletion' || (next === 'active' && allowReactivate);
  if (previous === 'approved-for-deletion') return next === 'deleted';
  return false;
}

function zoneName(zoneRef: string): string {
  const prefix = 'config://cloudflare/';
  return zoneRef.startsWith(prefix) ? zoneRef.slice(prefix.length) : zoneRef;
}

export function validateSemantics(applications: DesiredApplication[], context: SemanticValidationContext): CatalogIssue[] {
  const issues: CatalogIssue[] = [];
  const ids = new Map<string, DesiredApplication>();
  const projects = new Map<string, DesiredApplication>();
  const domainOwners = new Map<string, DesiredApplication>();
  const knownIds = new Set(applications.map((app) => app.metadata.id));
  const previousLifecycle = context.previousLifecycle ?? {};
  const previousRepositories = context.previousRepositories ?? {};

  for (const app of applications) {
    const file = app.sourcePath ?? 'catalog';
    const at = (path: string, code: string, message: string, remediation: string): void => {
      issues.push(issue(file, code, path, message, remediation, context.resolvePosition(file, path)));
    };

    if (ids.has(app.metadata.id)) at('metadata.id', 'LP-CATALOG-DUPLICATE-ID', `Application ID '${app.metadata.id}' is already declared.`, 'Choose a globally unique stable ID.');
    ids.set(app.metadata.id, app);
    const projectName = app.vercel.project.name;
    if (projects.has(projectName)) at('vercel.project.name', 'LP-CATALOG-DUPLICATE-PROJECT', `Vercel project '${projectName}' is already declared.`, 'Choose a unique project name.');
    projects.set(projectName, app);

    const canonicalCount = new Map<EnvironmentName, number>();
    app.domains.forEach((domain, index) => {
      const domainPath = `domains.${index}`;
      if (domainOwners.has(domain.hostname)) at(`${domainPath}.hostname`, 'LP-CATALOG-DUPLICATE-DOMAIN', `Hostname '${domain.hostname}' is already declared.`, 'Assign each hostname to one application and environment.');
      domainOwners.set(domain.hostname, app);
      const environment = app.environments[domain.environment];
      if (!environment) {
        at(`${domainPath}.environment`, 'LP-DOMAIN-UNKNOWN-ENVIRONMENT', `Domain '${domain.hostname}' references undeclared environment '${domain.environment}'.`, 'Declare the environment or assign the domain to a declared one.');
      } else if (!environment.enabled) {
        at(`${domainPath}.environment`, 'LP-DOMAIN-DISABLED-ENVIRONMENT', `Domain '${domain.hostname}' is assigned to disabled environment '${domain.environment}'.`, 'Enable the environment or reassign the domain.');
      }
      if (domain.canonical === true) {
        const count = (canonicalCount.get(domain.environment) ?? 0) + 1;
        canonicalCount.set(domain.environment, count);
        if (count > 1) at(`${domainPath}.canonical`, 'LP-DOMAIN-CANONICAL-DUPLICATE', `Environment '${domain.environment}' declares more than one canonical domain.`, 'Keep at most one canonical domain per environment.');
      }
      if (domain.cloudflare.mode === 'proxied' && domain.cloudflare.proxy?.acknowledgeDoubleCdn !== true) {
        at(`${domainPath}.cloudflare.proxy.acknowledgeDoubleCdn`, 'LP-DNS-PROXY-ACKNOWLEDGMENT', `Proxied mode for '${domain.hostname}' requires explicit double-CDN acknowledgment.`, 'Set cloudflare.proxy.acknowledgeDoubleCdn: true after compatibility review.');
      }
      if (context.zones !== undefined && !context.zones.includes(zoneName(domain.cloudflare.zoneRef))) {
        at(`${domainPath}.cloudflare.zoneRef`, 'LP-DOMAIN-ZONE-UNKNOWN', `Zone '${zoneName(domain.cloudflare.zoneRef)}' is not registered in the catalog zone registry.`, 'Register the zone in the catalog zone registry before assigning domains to it.');
      }
    });

    for (const envName of Object.keys(app.environments) as EnvironmentName[]) {
      const environment = app.environments[envName];
      if (!environment) continue;
      if (typeof environment.domain === 'string' && environment.domain.length > 0) {
        const declared = app.domains.some((domain) => domain.hostname === environment.domain && domain.environment === envName);
        if (!declared) at(`environments.${envName}.domain`, 'LP-CATALOG-ENV-DOMAIN-UNBOUND', `environments.${envName}.domain '${environment.domain}' is not declared in domains for '${envName}'.`, `Add the hostname to domains with environment: ${envName}.`);
      }
    }

    app.dependencies.applications.forEach((dependency, index) => {
      if (!knownIds.has(dependency)) at(`dependencies.applications.${index}`, 'LP-CATALOG-MISSING-DEPENDENCY', `Application dependency '${dependency}' does not exist.`, 'Declare the dependency or remove the reference.');
    });

    const secretNames = new Set(app.secrets.map((secret) => secret.name));
    const sensitiveSecretNames = new Set(app.secrets.filter((secret) => secret.sensitive === true || secret.source !== undefined).map((secret) => secret.name));
    const declaredSecrets: Array<{ name: string; environments: readonly EnvironmentName[] }> = [];
    app.secrets.forEach((secret, index) => {
      const secretPath = `secrets.${index}`;
      const hasSource = secret.source !== undefined;
      const hasValue = secret.value !== undefined;
      if (hasSource === hasValue) at(secretPath, 'LP-SECRET-SOURCE', `Secret '${secret.name}' must define exactly one source reference or non-sensitive value.`, 'Use source for sensitive values and value only when sensitive is false.');
      if (secret.sensitive === true && hasValue) at(`${secretPath}.value`, 'LP-SECRET-PLAINTEXT', `Sensitive value for '${secret.name}' must not be stored in the catalog.`, 'Use a provider secret reference.');
      for (const previous of declaredSecrets) {
        if (previous.name === secret.name && previous.environments.some((envName) => secret.environments.includes(envName))) {
          at(`${secretPath}.name`, 'LP-SECRET-DUPLICATE-ENVIRONMENT', `Secret '${secret.name}' is declared more than once for the same environments.`, 'Use one entry per environment with the same name, or distinct names.');
          break;
        }
      }
      declaredSecrets.push({ name: secret.name, environments: secret.environments });
    });

    for (const envName of Object.keys(app.environments) as EnvironmentName[]) {
      const environment = app.environments[envName];
      if (!environment) continue;
      for (const [variableName, value] of Object.entries(environment.variables ?? {})) {
        if (value !== null && typeof value === 'object' && 'secretRef' in value && typeof value.secretRef === 'string') {
          const secretRef = value.secretRef;
          const path = `environments.${envName}.variables.${variableName}`;
          if (!secretNames.has(secretRef)) at(path, 'LP-SECRET-REFERENCE-MISSING', `Variable '${variableName}' references secret '${secretRef}' which is not declared.`, 'Declare the secret or fix the reference.');
          else if (!sensitiveSecretNames.has(secretRef)) at(path, 'LP-SECRET-REFERENCE-SENSITIVITY', `Variable '${variableName}' requires sensitive secret '${secretRef}' but it is declared with a plaintext value.`, 'Convert the secret to a source reference.');
        }
      }
      for (const [headerName, value] of Object.entries(environment.health.headers ?? {})) {
        if (value !== null && typeof value === 'object' && 'secretRef' in value && typeof value.secretRef === 'string' && !secretNames.has(value.secretRef)) {
          at(`environments.${envName}.health.headers.${headerName}`, 'LP-SECRET-REFERENCE-MISSING', `Health header '${headerName}' references secret '${value.secretRef}' which is not declared.`, 'Declare the secret or fix the reference.');
        }
      }
    }

    const previous = previousLifecycle[app.metadata.id] as LifecycleState | undefined;
    const allowReactivate = app.lifecycle.recoveryPolicy?.allowReactivateBeforeDeletionApproval === true;
    if (previous !== undefined && !validTransition(previous, app.lifecycle.state, allowReactivate)) {
      if (previous === 'decommissioning' && app.lifecycle.state === 'active') {
        at('lifecycle.state', 'LP-LIFECYCLE-RECOVERY', `Reactivating '${app.metadata.id}' from decommissioning requires an explicit recovery policy.`, 'Set lifecycle.recoveryPolicy.allowReactivateBeforeDeletionApproval: true after review.');
      } else {
        at('lifecycle.state', 'LP-LIFECYCLE-TRANSITION', `Lifecycle transition '${previous}' → '${app.lifecycle.state}' is not allowed.`, 'Use the explicit decommissioning workflow.');
      }
    }
    if (app.lifecycle.state === 'approved-for-deletion') {
      if (app.lifecycle.deletionProtection) at('lifecycle.deletionProtection', 'LP-LIFECYCLE-PROTECTION', 'Deletion approval requires deletionProtection: false.', 'Complete the reviewed deletion approval flow.');
      if (!app.lifecycle.decommission.requestedAt) at('lifecycle.decommission.requestedAt', 'LP-LIFECYCLE-DECOMMISSION-REQUEST', 'Deletion approval requires the decommission request timestamp.', 'Set lifecycle.decommission.requestedAt to when decommissioning was requested.');
      if (!app.lifecycle.decommission.deleteAfter) at('lifecycle.decommission.deleteAfter', 'LP-LIFECYCLE-DELETION-SCHEDULE', 'Deletion approval requires a scheduled deletion time.', 'Set lifecycle.decommission.deleteAfter to the approved deletion time.');
    }

    for (const envName of ['staging', 'production'] as const) {
      const environment = app.environments[envName];
      if (environment?.strategy !== undefined && previewOnlyStrategies[environment.strategy] === true) {
        at(`environments.${envName}.strategy`, 'LP-CATALOG-UNSUPPORTED-SETTING', `Strategy '${environment.strategy}' is not supported for the '${envName}' environment.`, `Use custom-environment or separate-project for ${envName}, or omit strategy.`);
      }
    }

    const previousRepository = previousRepositories[app.metadata.id];
    if (previousRepository && previousRepository.name !== app.repository.name) {
      const renameProtected = typeof previousRepository.expectedRepositoryId === 'number' && previousRepository.expectedRepositoryId === app.repository.expectedRepositoryId;
      if (!renameProtected) at('repository.name', 'LP-CATALOG-REPOSITORY-RENAME', `Repository '${app.metadata.id}' changed from '${previousRepository.name}' to '${app.repository.name}' without rename protection.`, "Set repository.expectedRepositoryId to the repository's stable ID to permit renames.");
    }
  }

  const cycle = hasCycle(applications);
  if (cycle) {
    const start = applications.find((application) => application.metadata.id === cycle[0]);
    if (start) {
      const edgeTarget = cycle[1];
      const edgeIndex = edgeTarget !== undefined ? start.dependencies.applications.indexOf(edgeTarget) : -1;
      const path = edgeIndex >= 0 ? `dependencies.applications.${edgeIndex}` : 'dependencies.applications';
      const position = context.resolvePosition(start.sourcePath ?? 'catalog', path);
      issues.push(issue(start.sourcePath ?? 'catalog', 'LP-CATALOG-DEPENDENCY-CYCLE', path, `Dependency cycle detected: ${cycle.join(' → ')}.`, 'Remove one dependency edge to break the cycle.', position));
    }
  }

  const previousEntries = Object.entries(previousRepositories).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  if (previousEntries.length > 0) {
    const currentIds = new Set(applications.map((application) => application.metadata.id));
    for (const [previousId, previousRepository] of previousEntries) {
      if (currentIds.has(previousId)) continue;
      const previousState = previousLifecycle[previousId];
      if (previousState !== undefined && teardownStates[previousState] === true) continue;
      const match = applications.find(
        (application) =>
          application.metadata.id !== previousId &&
          (application.repository.name === previousRepository.name ||
            (typeof previousRepository.expectedRepositoryId === 'number' && previousRepository.expectedRepositoryId === application.repository.expectedRepositoryId)),
      );
      if (match) {
        const position = context.resolvePosition(match.sourcePath ?? 'catalog', 'metadata.id');
        issues.push(issue(match.sourcePath ?? 'catalog', 'LP-CATALOG-ID-CHANGED', 'metadata.id', `Application ID '${previousId}' changed to '${match.metadata.id}' for the same repository. metadata.id is immutable after first apply.`, 'Keep the original ID or create a new application through the decommissioning workflow.', position));
      }
    }
  }

  const redirectGraph = new Map<string, string[]>();
  const declaredDomains = new Map<string, { app: DesiredApplication; index: number }>();
  for (const app of applications) {
    app.domains.forEach((domain, index) => {
      declaredDomains.set(domain.hostname, { app, index });
    });
  }
  for (const [hostname, entry] of declaredDomains) {
    const domain = entry.app.domains[entry.index];
    redirectGraph.set(hostname, (domain?.redirects ?? []).filter((target) => declaredDomains.has(target)));
  }
  const redirectVisiting = new Set<string>();
  const redirectVisited = new Set<string>();
  const redirectStack: string[] = [];
  const findRedirectCycle = (hostname: string): string[] | null => {
    if (redirectVisiting.has(hostname)) return [...redirectStack.slice(redirectStack.indexOf(hostname)), hostname];
    if (redirectVisited.has(hostname)) return null;
    redirectVisiting.add(hostname);
    redirectStack.push(hostname);
    for (const target of redirectGraph.get(hostname) ?? []) {
      const redirectCycle = findRedirectCycle(target);
      if (redirectCycle) return redirectCycle;
    }
    redirectStack.pop();
    redirectVisiting.delete(hostname);
    redirectVisited.add(hostname);
    return null;
  };
  for (const hostname of redirectGraph.keys()) {
    const redirectCycle = findRedirectCycle(hostname);
    if (redirectCycle) {
      for (let index = 0; index < redirectCycle.length - 1; index += 1) {
        const from = redirectCycle[index];
        const entry = from !== undefined ? declaredDomains.get(from) : undefined;
        if (entry) {
          const position = context.resolvePosition(entry.app.sourcePath ?? 'catalog', `domains.${entry.index}.redirects`);
          issues.push(issue(entry.app.sourcePath ?? 'catalog', 'LP-DOMAIN-REDIRECT-CYCLE', `domains.${entry.index}.redirects`, `Redirect cycle detected: ${redirectCycle.join(' → ')}.`, 'Break the redirect loop or remove one redirect.', position));
        }
      }
      break;
    }
  }

  if (context.files.size === 0) issues.push(issue('catalog', 'LP-CATALOG-EMPTY', '$', 'The catalog contains no application manifests.', 'Add at least one application manifest.', { line: 1, column: 1 }));
  return issues;
}
