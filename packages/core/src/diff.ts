import { idempotencyKey, stableId } from '@launchpad/shared';
import type { ProviderCapabilities } from './capabilities.js';
import { canonicalEqual } from './canonical.js';
import { accessDesired } from './graph.js';
import { secretBindingFingerprint, redactEnvironmentSpec, variableFingerprint } from './fingerprints.js';
import type {
  DesiredApplication,
  DownstreamEffect,
  DriftCategory,
  DriftRecord,
  EnvironmentName,
  ObservedApplication,
  PlanBlock,
  PlanMode,
  PlannedAction,
  PlannedOperation,
  ProviderName,
} from './types.js';

export interface DiffOptions {
  mode?: PlanMode;
  /** Expected ownership fingerprints recorded for this application (D1 resource_ownership), keyed by resourceKey. */
  ownership?: Record<string, string>;
  now?: string;
}

export interface DiffResult {
  operations: PlannedOperation[];
  downstreamEffects: DownstreamEffect[];
  blocks: PlanBlock[];
  drift: DriftRecord[];
}

interface Leaf {
  path: string;
  key: string;
  value: unknown;
}

function isTrivial(value: unknown): boolean {
  return value === null || value === undefined || value === ''
    || (Array.isArray(value) && value.length === 0)
    || (typeof value === 'object' && value !== null && Object.keys(value).length === 0);
}

function operation(input: { applicationId: string; key: string; provider: ProviderName; type: string; action: PlannedAction; before: unknown; after: unknown; prerequisites?: string[]; invalidates?: string[]; destructive?: boolean; retryClass?: PlannedOperation['retryClass'] }): PlannedOperation {
  return {
    id: stableId('operation', input.applicationId, input.key, input.action),
    resourceKey: input.key,
    provider: input.provider,
    resourceType: input.type,
    action: input.action,
    before: input.before,
    after: input.after,
    prerequisites: input.prerequisites ?? [],
    invalidates: input.invalidates ?? [],
    idempotencyKey: idempotencyKey('operation', input.applicationId, input.key, input.action),
    destructive: input.destructive ?? input.action === 'DESTROY',
    retryClass: input.retryClass ?? 'NONE',
  };
}

/** Application-scoped BLOCKED operation used for plan-level failures. */
export function blockedOperation(applicationId: string, key: string, provider: ProviderName, type: string, reason: string): PlannedOperation {
  return operation({ applicationId, key, provider, type, action: 'BLOCKED', before: null, after: { reason } });
}

/**
 * Desired-vs-observed comparison over the desired projection only, so
 * provider-computed fields (ids, timestamps, provider noise) never produce
 * phantom diffs. Trivial desired values (null/empty) are considered
 * satisfied when the observed side has no value for the key.
 */
function desiredProjectionChanged(desired: Record<string, unknown>, observed: Record<string, unknown> | null | undefined): boolean {
  if (observed === null || observed === undefined) return true;
  return Object.entries(desired).some(([key, value]) => {
    if (isTrivial(value) && !(key in observed)) return false;
    return !canonicalEqual(key in observed ? observed[key] : null, value);
  });
}

interface ChangeInput {
  applicationId: string;
  key: string;
  provider: ProviderName;
  type: string;
  exists: boolean;
  changed: boolean;
  desired: unknown;
  observed: unknown;
  category: DriftCategory;
  detail: string;
  retryClass?: PlannedOperation['retryClass'];
  prerequisites?: string[];
  invalidates?: string[];
  destructive?: boolean;
  /** Explicit action override (DECOMMISSION, DESTROY, REDEPLOY_REQUIRED, NO_CHANGE). */
  action?: PlannedAction;
  /** Emits a downstream REDEPLOY_REQUIRED effect when the resource changes. */
  redeploy?: { reason: string };
}

interface DiffContext {
  operations: PlannedOperation[];
  downstreamEffects: DownstreamEffect[];
  drift: DriftRecord[];
  mode: PlanMode;
}

function pushChange(input: ChangeInput, ctx: DiffContext): PlannedAction {
  const action = input.action
    ?? (!input.exists ? 'CREATE' : input.changed ? (ctx.mode === 'reconcile' ? 'RECONCILE' : 'UPDATE_IN_PLACE') : 'NO_CHANGE');
  ctx.operations.push(operation({
    applicationId: input.applicationId,
    key: input.key,
    provider: input.provider,
    type: input.type,
    action,
    before: input.exists ? input.observed : null,
    after: action === 'DESTROY' ? null : input.desired,
    prerequisites: input.prerequisites ?? [],
    invalidates: input.invalidates ?? [],
    destructive: input.destructive ?? action === 'DESTROY',
    retryClass: input.retryClass ?? 'NONE',
  }));
  if (action === 'CREATE' || input.changed) {
    ctx.drift.push({ resourceKey: input.key, category: input.category, detail: input.detail });
  }
  if (input.redeploy && (action === 'CREATE' || input.changed)) {
    ctx.downstreamEffects.push({ resourceKey: 'production.candidate', action: 'REDEPLOY_REQUIRED', reason: input.redeploy.reason, severity: 'INFO' });
  }
  return action;
}

function unsupportedBlock(path: string, key: string, verb: string): PlanBlock {
  return {
    code: 'LP-UNSUPPORTED-FIELD',
    rule: 'capability.unsupported',
    message: `Field '${path}' (capability '${key}') cannot be ${verb} by the configured provider adapter.`,
    remediation: 'Extend the adapter capability matrix or remove the field from the manifest.',
  };
}

/** Blocks when a changed/created field has no capability or the required operation is disabled. */
function enforceCapabilityLeaves(input: { capabilities: ProviderCapabilities; blocks: PlanBlock[]; exists: boolean; leaves: Leaf[] }): void {
  for (const leaf of input.leaves) {
    const cap = input.capabilities.fields[leaf.key];
    if (!cap) {
      input.blocks.push(unsupportedBlock(leaf.path, leaf.key, input.exists ? 'updated' : 'created'));
      continue;
    }
    if (input.exists && !cap.update) input.blocks.push(unsupportedBlock(leaf.path, leaf.key, 'updated'));
    if (!input.exists && !cap.create) input.blocks.push(unsupportedBlock(leaf.path, leaf.key, 'created'));
  }
}

const PROJECT_CAPABILITY_KEYS: Record<string, string> = {
  name: 'project.name',
  framework: 'project.framework',
  rootDirectory: 'project.rootDirectory',
  nodeVersion: 'project.nodeVersion',
  installCommand: 'project.build.installCommand',
  buildCommand: 'project.build.buildCommand',
  outputDirectory: 'project.build.outputDirectory',
  developmentCommand: 'project.build.developmentCommand',
  ignoredBuildStep: 'project.build.ignoredBuildStep',
  autoAssignProductionDomains: 'project.settings.autoAssignProductionDomains',
  prioritizeProductionBuilds: 'project.settings.prioritizeProductionBuilds',
  rollingRelease: 'project.settings.rollingRelease',
  skewProtection: 'project.settings.skewProtection',
  functions: 'project.regions.functions',
};

function projectFlat(project: DesiredApplication['vercel']['project']): Record<string, unknown> {
  return {
    name: project.name,
    framework: project.framework,
    rootDirectory: project.rootDirectory,
    nodeVersion: project.nodeVersion,
    installCommand: project.build.installCommand,
    buildCommand: project.build.buildCommand,
    outputDirectory: project.build.outputDirectory,
    developmentCommand: project.build.developmentCommand,
    ignoredBuildStep: project.build.ignoredBuildStep,
    autoAssignProductionDomains: project.deployment.autoAssignProductionDomains,
    prioritizeProductionBuilds: project.deployment.prioritizeProductionBuilds,
    rollingRelease: project.deployment.rollingRelease,
    skewProtection: project.deployment.skewProtection,
    functions: project.regions.functions,
  };
}

function changedProjectLeaves(project: DesiredApplication['vercel']['project'], observedConfig: Record<string, unknown>): Leaf[] {
  const leaves: Leaf[] = [];
  for (const [name, value] of Object.entries(projectFlat(project))) {
    const observed = name in observedConfig ? observedConfig[name] : null;
    if (observed === null && isTrivial(value)) continue;
    if (canonicalEqual(value, observed)) continue;
    leaves.push({ path: name, key: PROJECT_CAPABILITY_KEYS[name] ?? `project.${name}`, value });
  }
  const observedProtection = (observedConfig.protection ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(project.protection)) {
    const observed = key in observedProtection ? observedProtection[key] : null;
    if (observed === null && isTrivial(value)) continue;
    if (canonicalEqual(value, observed)) continue;
    leaves.push({ path: `protection.${key}`, key: `project.protection.${key}`, value });
  }
  for (const key of Object.keys(observedProtection)) {
    if (!(key in project.protection)) leaves.push({ path: `protection.${key}`, key: `project.protection.${key}`, value: null });
  }
  return leaves;
}

function changedSettingsLeaves(settings: DesiredApplication['vercel']['project']['settings'], observedConfig: Record<string, unknown>): Leaf[] {
  const leaves: Leaf[] = [];
  for (const [key, value] of Object.entries(settings)) {
    const observed = key in observedConfig ? observedConfig[key] : null;
    if (observed === null && isTrivial(value)) continue;
    if (canonicalEqual(value, observed)) continue;
    leaves.push({ path: `settings.${key}`, key: `project.settings.${key}`, value });
  }
  for (const key of Object.keys(observedConfig)) {
    if (!(key in settings)) leaves.push({ path: `settings.${key}`, key: `project.settings.${key}`, value: null });
  }
  return leaves;
}

/**
 * Compares desired manifest state against observed provider state and
 * classifies every resource into CREATE / UPDATE_IN_PLACE / RECONCILE /
 * REDEPLOY_REQUIRED / PROMOTE / DECOMMISSION / DESTROY / NO_CHANGE /
 * BLOCKED operations with app-scoped ids and idempotency keys, downstream
 * effects, capability/ownership blocks, and stable drift records.
 */
export function diffApplication(desired: DesiredApplication, observed: ObservedApplication, capabilities: ProviderCapabilities, options: DiffOptions = {}): DiffResult {
  const mode = options.mode ?? 'apply';
  const applicationId = desired.metadata.id;
  const now = options.now ?? new Date().toISOString();
  const resources = new Map(observed.resources.map((resource) => [resource.resourceKey, resource]));
  const operations: PlannedOperation[] = [];
  const downstreamEffects: DownstreamEffect[] = [];
  const blocks: PlanBlock[] = [];
  const drift: DriftRecord[] = [];
  const ctx: DiffContext = { operations, downstreamEffects, drift, mode };
  const referencedKeys = new Set<string>();

  const projectResource = resources.get('vercel.project') ?? resources.get(desired.metadata.id);
  referencedKeys.add('vercel.project');
  if (projectResource && projectResource.resourceKey !== 'vercel.project') referencedKeys.add(projectResource.resourceKey);
  referencedKeys.add('vercel.settings');
  referencedKeys.add('github.repository');
  referencedKeys.add('github.repository-access');
  referencedKeys.add('vercel.git');
  referencedKeys.add('application.lifecycle');

  const deletionState = desired.lifecycle.state === 'approved-for-deletion' || desired.lifecycle.state === 'deleted';

  // Ownership verification: an observed resource must match the recorded
  // ownership fingerprint. Null-fingerprint checks run once all referenced
  // keys are known (see below).
  for (const [key, expected] of Object.entries(options.ownership ?? {})) {
    const resource = resources.get(key);
    if (!resource) continue;
    if (resource.ownershipFingerprint !== expected) {
      blocks.push({
        code: 'LP-OWNERSHIP-AMBIGUOUS',
        rule: 'ownership.ambiguous',
        message: `Observed resource '${key}' does not match the recorded ownership fingerprint for this application.`,
        remediation: 'Adopt the resource through the reviewed reconciliation workflow or restore the recorded ownership.',
      });
    }
  }

  if (deletionState) {
    for (const resource of observed.resources) {
      if (resource.ownershipFingerprint === null) {
        blocks.push({
          code: 'LP-OWNERSHIP-AMBIGUOUS',
          rule: 'ownership.ambiguous',
          message: `Observed resource '${resource.resourceKey}' has no ownership evidence; destroying it could affect another application.`,
          remediation: 'Record ownership for the resource before destroying it.',
        });
      }
    }
    const gateBlocks: PlanBlock[] = [];
    if (desired.lifecycle.deletionProtection) gateBlocks.push({ code: 'LP-DELETION-PROTECTION-ENABLED', rule: 'lifecycle.deletionGate', message: 'Deletion protection is still enabled.', remediation: 'Set deletionProtection: false after the cooling-off period.' });
    if (desired.lifecycle.decommission.approvalToken === null) gateBlocks.push({ code: 'LP-DELETION-TOKEN-MISSING', rule: 'lifecycle.deletionGate', message: 'No deletion approval token is supplied.', remediation: 'Generate and supply the single-use deletion token.' });
    if (desired.lifecycle.decommission.deleteAfter === null || desired.lifecycle.decommission.deleteAfter > now) gateBlocks.push({ code: 'LP-DELETION-COOLING-OFF', rule: 'lifecycle.deletionGate', message: 'The deletion cooling-off period has not elapsed.', remediation: 'Wait until deleteAfter before requesting deletion.' });
    const leadingBlock = gateBlocks[0];
    if (leadingBlock !== undefined) {
      blocks.push(...gateBlocks);
      operations.push(blockedOperation(applicationId, 'application.destroy', 'platform', 'application', leadingBlock.message));
      return { operations, downstreamEffects, blocks, drift };
    }
    for (const resource of observed.resources.slice().sort((left, right) => left.resourceKey.localeCompare(right.resourceKey))) {
      operations.push(operation({ applicationId, key: resource.resourceKey, provider: resource.provider, type: resource.resourceType, action: 'DESTROY', before: resource.configuration, after: null, destructive: true }));
    }
    operations.push(operation({ applicationId, key: 'application.destroy', provider: 'platform', type: 'application', action: 'DESTROY', before: null, after: null, destructive: true }));
    return { operations, downstreamEffects, blocks, drift };
  }

  // 1. Repository and repository access.
  const repoResource = resources.get('github.repository');
  pushChange({
    applicationId, key: 'github.repository', provider: 'github', type: 'repository',
    exists: repoResource !== undefined,
    changed: desiredProjectionChanged(desired.repository as unknown as Record<string, unknown>, repoResource?.configuration),
    desired: desired.repository, observed: repoResource?.configuration ?? null,
    category: 'changed', detail: 'Repository declaration differs from observed state.',
    retryClass: 'TRANSIENT',
  }, ctx);

  const accessResource = resources.get('github.repository-access');
  const accessDesiredValue = accessDesired(desired);
  pushChange({
    applicationId, key: 'github.repository-access', provider: 'github', type: 'repository-access',
    exists: accessResource !== undefined,
    changed: desiredProjectionChanged(accessDesiredValue, accessResource?.configuration),
    desired: accessDesiredValue, observed: accessResource?.configuration ?? null,
    category: 'access', detail: 'Repository or Vercel Git access differs from the manifest.',
    retryClass: 'TRANSIENT',
  }, ctx);

  // 2. Project, settings, and Git connection.
  const projectConfig = projectResource?.configuration ?? {};
  const projectLeaves = changedProjectLeaves(desired.vercel.project, projectConfig);
  const projectExists = projectResource !== undefined;
  enforceCapabilityLeaves({ capabilities, blocks, exists: projectExists, leaves: projectLeaves });
  const redeployLeaves = projectLeaves.filter((leaf) => capabilities.fields[leaf.key]?.requiresRedeploy === true);
  const projectDestructive = projectLeaves.some((leaf) => capabilities.fields[leaf.key]?.destructiveWhenChanged === true);
  const projectChange: ChangeInput = {
    applicationId, key: 'vercel.project', provider: 'vercel', type: 'project',
    exists: projectExists, changed: projectLeaves.length > 0,
    desired: projectFlat(desired.vercel.project), observed: projectConfig,
    category: 'changed', detail: 'Project configuration differs from the manifest.',
    retryClass: 'TRANSIENT',
    destructive: projectDestructive,
    ...(redeployLeaves.length > 0 ? { invalidates: ['production.health', 'production.promotion', 'production.post-health'], redeploy: { reason: `Project setting change requires a new build: ${redeployLeaves.map((leaf) => leaf.path).join(', ')}.` } } : {}),
  };
  pushChange(projectChange, ctx);

  const settingsResource = resources.get('vercel.settings') ?? projectResource;
  const settingsExists = settingsResource !== undefined;
  // When settings are observed through the project resource, project each
  // desired key explicitly and normalize missing keys to null so absent
  // optional settings never surface as undefined in comparisons or plans.
  const settingsObserved = settingsResource === projectResource
    ? Object.fromEntries(Object.keys(desired.vercel.project.settings).map((key) => [key, settingsResource?.configuration[key] ?? null]))
    : settingsResource?.configuration ?? {};
  const settingsLeaves = changedSettingsLeaves(desired.vercel.project.settings, settingsObserved);
  enforceCapabilityLeaves({ capabilities, blocks, exists: settingsExists, leaves: settingsLeaves });
  pushChange({
    applicationId, key: 'vercel.settings', provider: 'vercel', type: 'project-settings',
    exists: settingsExists, changed: settingsLeaves.length > 0,
    desired: desired.vercel.project.settings, observed: settingsObserved,
    category: 'changed', detail: 'Project settings differ from the manifest.',
    retryClass: 'TRANSIENT',
  }, ctx);

  const gitResource = resources.get('vercel.git');
  const gitDesiredValue = { connected: desired.vercel.project.git.connected, productionBranch: desired.vercel.project.git.productionBranch, repository: desired.repository.name };
  const gitChanged = desiredProjectionChanged(gitDesiredValue, gitResource?.configuration);
  pushChange({
    applicationId, key: 'vercel.git', provider: 'vercel', type: 'git-connection',
    exists: gitResource !== undefined, changed: gitChanged,
    desired: gitDesiredValue, observed: gitResource?.configuration ?? null,
    category: 'access', detail: 'Vercel Git connection differs from the manifest.',
    prerequisites: ['vercel.project'], retryClass: 'TRANSIENT',
    ...(gitChanged ? { redeploy: { reason: 'Vercel Git connection change requires a new build.' } } : {}),
  }, ctx);

  // 3. Environments and keyed variable/secret fingerprints.
  const emittedVariables = new Set<string>();
  for (const [environment, spec] of Object.entries(desired.environments)) {
    const envKey = `vercel.environment.${environment}`;
    referencedKeys.add(envKey);
    const envResource = resources.get(envKey);
    const specEnabled = spec !== undefined && spec.enabled !== false;
    if (!specEnabled) {
      if (envResource) {
        pushChange({
          applicationId, key: envKey, provider: 'vercel', type: 'environment',
          exists: true, changed: true, desired: null, observed: envResource.configuration,
          action: 'DESTROY', destructive: true,
          category: 'changed', detail: `Environment '${environment}' is disabled but still exists.`,
        }, ctx);
      }
      continue;
    }
    const envSpec = spec as NonNullable<DesiredApplication['environments'][EnvironmentName]>;
    if (envSpec.strategy === 'custom-environment' && capabilities.features.customEnvironment !== true) {
      blocks.push({ code: 'LP-UNSUPPORTED-FEATURE', rule: 'capability.feature', message: `Environment '${environment}' requests strategy 'custom-environment', which the configured provider adapter does not support.`, remediation: 'Use a supported strategy or extend provider features.' });
    }
    if (envSpec.strategy === 'separate-project' && capabilities.features.separateProject !== true) {
      blocks.push({ code: 'LP-UNSUPPORTED-FEATURE', rule: 'capability.feature', message: `Environment '${environment}' requests strategy 'separate-project', which the configured provider adapter does not support.`, remediation: 'Use a supported strategy or extend provider features.' });
    }
    const envChanged = desiredProjectionChanged(envSpec as unknown as Record<string, unknown>, envResource?.configuration);
    pushChange({
      applicationId, key: envKey, provider: 'vercel', type: 'environment',
      exists: envResource !== undefined, changed: envChanged,
      desired: redactEnvironmentSpec(envSpec, environment), observed: envResource?.configuration ?? null,
      category: 'changed', detail: `Environment '${environment}' configuration differs from the manifest.`,
      retryClass: 'TRANSIENT',
    }, ctx);
    for (const [name, binding] of Object.entries(envSpec.variables ?? {})) {
      const varKey = `vercel.variable.${environment}.${name}`;
      referencedKeys.add(varKey);
      if (emittedVariables.has(varKey)) continue;
      emittedVariables.add(varKey);
      const varResource = resources.get(varKey);
      const desiredConfig = { fingerprint: variableFingerprint(environment, name, binding), sensitive: typeof binding !== 'string' };
      pushChange({
        applicationId, key: varKey, provider: 'vercel', type: 'environment-variable',
        exists: varResource !== undefined,
        changed: desiredProjectionChanged(desiredConfig, varResource?.configuration),
        desired: desiredConfig, observed: varResource?.configuration ?? null,
        category: typeof binding === 'string' ? 'changed' : 'secret',
        detail: `Environment variable '${name}' in '${environment}' differs from the manifest.`,
        prerequisites: [envKey], retryClass: 'TRANSIENT',
        redeploy: { reason: `Environment variable '${name}' in '${environment}' changed; previous deployments retain the old value.` },
      }, ctx);
    }
  }
  for (const binding of desired.secrets) {
    for (const environment of binding.environments) {
      const environmentSpec = desired.environments[environment];
      if (environmentSpec === undefined || environmentSpec.enabled === false) {
        blocks.push({ code: 'LP-ENV-UNKNOWN', rule: 'variables.environment', message: `Secret binding '${binding.name}' targets '${environment}', which is not an enabled environment in the manifest.`, remediation: 'Declare and enable the environment or remove it from the binding.' });
        continue;
      }
      const varKey = `vercel.variable.${environment}.${binding.name}`;
      referencedKeys.add(varKey);
      if (emittedVariables.has(varKey)) continue;
      emittedVariables.add(varKey);
      const varResource = resources.get(varKey);
      const desiredConfig = { fingerprint: secretBindingFingerprint(environment, binding), sensitive: binding.sensitive ?? binding.source !== undefined };
      pushChange({
        applicationId, key: varKey, provider: 'vercel', type: 'environment-variable',
        exists: varResource !== undefined,
        changed: desiredProjectionChanged(desiredConfig, varResource?.configuration),
        desired: desiredConfig, observed: varResource?.configuration ?? null,
        category: 'secret', detail: `Secret binding '${binding.name}' in '${environment}' differs from the manifest.`,
        prerequisites: [`vercel.environment.${environment}`], retryClass: 'TRANSIENT',
        redeploy: { reason: `Secret binding '${binding.name}' in '${environment}' changed; previous deployments retain the old value.` },
      }, ctx);
    }
  }

  // 4. Domains, DNS, verification, and TLS.
  const productionDomainVerification: string[] = [];
  for (const domain of desired.domains) {
    const domainKey = `vercel.domain.${domain.hostname}`;
    const dnsKey = `cloudflare.dns.${domain.hostname}`;
    const verifyKey = `domain.verification.${domain.hostname}`;
    referencedKeys.add(domainKey);
    referencedKeys.add(dnsKey);
    referencedKeys.add(verifyKey);
    const domainResource = resources.get(domainKey);
    const domainExists = domainResource !== undefined;
    const domainDesiredValue = { hostname: domain.hostname, environment: domain.environment, canonical: domain.canonical ?? false, mode: domain.cloudflare.mode, ttl: domain.cloudflare.ttl, zoneRef: domain.cloudflare.zoneRef };
    const domainLeaves: Leaf[] = [
      { path: 'hostname', key: 'domain.hostname', value: domain.hostname },
      { path: 'environment', key: 'domain.environment', value: domain.environment },
      { path: 'canonical', key: 'domain.canonical', value: domain.canonical ?? false },
      { path: 'mode', key: 'domain.mode', value: domain.cloudflare.mode },
      { path: 'ttl', key: 'domain.ttl', value: domain.cloudflare.ttl },
      { path: 'zoneRef', key: 'domain.zoneRef', value: domain.cloudflare.zoneRef },
    ];
    const domainChanged = desiredProjectionChanged(domainDesiredValue, domainResource?.configuration);
    enforceCapabilityLeaves({
      capabilities, blocks, exists: domainExists,
      leaves: domainExists ? domainLeaves.filter((leaf) => !canonicalEqual(leaf.value, domainResource.configuration[leaf.path] ?? null)) : domainLeaves,
    });
    pushChange({
      applicationId, key: domainKey, provider: 'vercel', type: 'project-domain',
      exists: domainExists, changed: domainChanged,
      desired: domainDesiredValue, observed: domainResource?.configuration ?? null,
      category: 'changed', detail: `Domain '${domain.hostname}' differs from the manifest.`,
      prerequisites: ['vercel.project'], retryClass: 'PROVIDER_EVENTUAL_CONSISTENCY',
    }, ctx);

    const dnsResource = resources.get(dnsKey);
    const dnsExists = dnsResource !== undefined;
    const dnsDesiredValue = { zoneRef: domain.cloudflare.zoneRef, mode: domain.cloudflare.mode, ttl: domain.cloudflare.ttl, proxied: domain.cloudflare.mode === 'proxied' };
    const dnsLeaves: Leaf[] = [
      { path: 'zoneRef', key: 'dns.record.zoneRef', value: domain.cloudflare.zoneRef },
      { path: 'mode', key: 'dns.record.proxied', value: domain.cloudflare.mode },
      { path: 'ttl', key: 'dns.record.ttl', value: domain.cloudflare.ttl },
    ];
    const dnsChanged = desiredProjectionChanged(dnsDesiredValue, dnsResource?.configuration);
    enforceCapabilityLeaves({
      capabilities, blocks, exists: dnsExists,
      leaves: dnsExists ? dnsLeaves.filter((leaf) => !canonicalEqual(leaf.value, dnsResource.configuration[leaf.path] ?? null)) : dnsLeaves,
    });
    pushChange({
      applicationId, key: dnsKey, provider: 'cloudflare', type: 'dns-record',
      exists: dnsExists, changed: dnsChanged,
      desired: dnsDesiredValue, observed: dnsResource?.configuration ?? null,
      category: 'changed', detail: `DNS record for '${domain.hostname}' differs from the manifest.`,
      prerequisites: [domainKey], retryClass: 'PROVIDER_EVENTUAL_CONSISTENCY',
    }, ctx);

    const verifyResource = resources.get(verifyKey);
    const verified = verifyResource?.configuration?.verified === true;
    pushChange({
      applicationId, key: verifyKey, provider: 'vercel', type: 'domain-verification',
      exists: verifyResource !== undefined, changed: !verified,
      desired: { hostname: domain.hostname }, observed: verifyResource?.configuration ?? null,
      category: 'changed', detail: `Domain verification for '${domain.hostname}' is not confirmed.`,
      prerequisites: [dnsKey], retryClass: 'PROVIDER_EVENTUAL_CONSISTENCY',
    }, ctx);
    if (domain.environment === 'production') productionDomainVerification.push(verifyKey);

    const tlsSpec = desired.environments[domain.environment]?.health?.tls;
    if (tlsSpec?.required) {
      const tlsKey = `domain.tls.${domain.hostname}`;
      referencedKeys.add(tlsKey);
      const tlsResource = resources.get(tlsKey);
      const observedTls = tlsResource?.configuration ?? {};
      const tlsValid = observedTls.valid === true && (tlsSpec.minimumDaysRemaining === undefined || typeof observedTls.daysRemaining !== 'number' || observedTls.daysRemaining >= tlsSpec.minimumDaysRemaining);
      pushChange({
        applicationId, key: tlsKey, provider: 'vercel', type: 'domain-tls',
        exists: tlsResource !== undefined, changed: !tlsValid,
        desired: tlsSpec, observed: tlsResource?.configuration ?? null,
        category: 'changed', detail: `TLS certificate for '${domain.hostname}' is not valid or expiring.`,
        prerequisites: [verifyKey], retryClass: 'PROVIDER_EVENTUAL_CONSISTENCY',
      }, ctx);
    }
  }

  // 5. Staged candidate, health, promotion, and post-promotion health.
  const productionDesired = desired.environments.production;
  const productionActive = productionDesired?.enabled !== false;
  if (productionActive) {
    const candidateKey = 'production.candidate';
    const healthKey = 'production.health';
    const promotionKey = 'production.promotion';
    const postHealthKey = 'production.post-health';
    referencedKeys.add(candidateKey);
    referencedKeys.add(healthKey);
    referencedKeys.add(promotionKey);
    referencedKeys.add(postHealthKey);
    const deployRequired = operations.some((candidate) => candidate.resourceKey !== candidateKey
      && !candidate.resourceKey.startsWith('domain.verification.')
      && !candidate.resourceKey.startsWith('domain.tls.')
      && candidate.resourceKey !== 'application.lifecycle'
      && (candidate.action === 'CREATE' || candidate.action === 'UPDATE_IN_PLACE' || candidate.action === 'RECONCILE' || candidate.action === 'DESTROY'))
      || downstreamEffects.some((effect) => effect.resourceKey === 'production.candidate' && effect.action === 'REDEPLOY_REQUIRED');
    const candidateResource = resources.get(candidateKey);
    const candidateExists = candidateResource !== undefined;
    const candidateNeeded = deployRequired || !candidateExists;
    pushChange({
      applicationId, key: candidateKey, provider: 'vercel', type: 'deployment',
      exists: candidateExists, changed: candidateNeeded,
      desired: productionDesired ? redactEnvironmentSpec(productionDesired, 'production') : null, observed: candidateResource?.configuration ?? null,
      action: candidateNeeded ? 'REDEPLOY_REQUIRED' : 'NO_CHANGE',
      category: 'deployment', detail: 'Staged production deployment is required.',
      prerequisites: ['vercel.project', 'vercel.git', ...productionDomainVerification],
      ...(candidateNeeded ? { invalidates: ['production.health', 'production.promotion', 'production.post-health'] } : {}),
      retryClass: 'TRANSIENT',
    }, ctx);

    const healthResource = resources.get(healthKey);
    pushChange({
      applicationId, key: healthKey, provider: 'vercel', type: 'health-check',
      exists: healthResource !== undefined, changed: candidateNeeded,
      desired: productionDesired?.health ?? null, observed: healthResource?.configuration ?? null,
      action: candidateNeeded ? 'REDEPLOY_REQUIRED' : 'NO_CHANGE',
      category: 'health', detail: 'Health check must run against the staged candidate.',
      prerequisites: [candidateKey], retryClass: 'PROVIDER_EVENTUAL_CONSISTENCY',
    }, ctx);

    const decommissioning = desired.lifecycle.state === 'decommissioning';
    const promotionResource = resources.get(promotionKey);
    const promotionAction: PlannedAction = decommissioning ? 'DECOMMISSION' : candidateNeeded ? 'PROMOTE' : 'NO_CHANGE';
    pushChange({
      applicationId, key: promotionKey, provider: 'vercel', type: 'promotion',
      exists: promotionResource !== undefined, changed: decommissioning || candidateNeeded,
      desired: productionDesired?.release ?? null, observed: promotionResource?.configuration ?? null,
      action: promotionAction,
      category: 'deployment', detail: decommissioning ? 'Promotion is disabled while the application is decommissioning.' : 'A verified candidate will be promoted to production.',
      prerequisites: [healthKey],
      ...(candidateNeeded ? { invalidates: ['production.post-health'] } : {}),
      retryClass: 'TRANSIENT',
    }, ctx);

    const postHealthResource = resources.get(postHealthKey);
    pushChange({
      applicationId, key: postHealthKey, provider: 'vercel', type: 'health-check',
      exists: postHealthResource !== undefined, changed: promotionAction === 'PROMOTE',
      desired: productionDesired?.health ?? null, observed: postHealthResource?.configuration ?? null,
      action: promotionAction === 'PROMOTE' ? 'REDEPLOY_REQUIRED' : 'NO_CHANGE',
      category: 'health', detail: 'Post-promotion health check must pass.',
      prerequisites: [promotionKey], retryClass: 'PROVIDER_EVENTUAL_CONSISTENCY',
    }, ctx);
  }

  // 6. Lifecycle record.
  const lifecycleObserved = observed.lifecycleState ? { state: observed.lifecycleState } : null;
  pushChange({
    applicationId, key: 'application.lifecycle', provider: 'platform', type: 'lifecycle',
    exists: lifecycleObserved !== null,
    changed: !canonicalEqual({ state: desired.lifecycle.state }, lifecycleObserved),
    desired: { state: desired.lifecycle.state, deletionProtection: desired.lifecycle.deletionProtection, orphanPolicy: desired.lifecycle.orphanPolicy },
    observed: lifecycleObserved,
    category: 'changed', detail: `Lifecycle transition to '${desired.lifecycle.state}'.`,
  }, ctx);

  // 7. Untracked observed resources are surfaced, never silently mutated.
  for (const resource of observed.resources) {
    if (referencedKeys.has(resource.resourceKey)) continue;
    downstreamEffects.push({ resourceKey: resource.resourceKey, action: 'UNTRACKED', reason: `Observed resource '${resource.resourceKey}' is not declared by the manifest.`, severity: 'WARNING' });
    drift.push({ resourceKey: resource.resourceKey, category: 'untracked', detail: 'Observed resource is not declared by the manifest.' });
  }

  // 8. Referenced observed resources must carry ownership evidence.
  for (const resource of observed.resources) {
    if (referencedKeys.has(resource.resourceKey) && resource.ownershipFingerprint === null) {
      blocks.push({
        code: 'LP-OWNERSHIP-AMBIGUOUS',
        rule: 'ownership.ambiguous',
        message: `Observed resource '${resource.resourceKey}' has no ownership evidence; mutating it could affect another application.`,
        remediation: 'Record ownership for the resource before mutating it.',
      });
    }
  }

  return { operations, downstreamEffects, blocks, drift };
}
