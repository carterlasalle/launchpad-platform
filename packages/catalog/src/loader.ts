import { canonicalJson } from '@launchpad/shared';
import type { DesiredApplication } from '@launchpad/core';
import { parseDocument } from 'yaml';
const supportedSchemaVersions = ['launchpad.dev/v1'] as const;
const isSupportedSchemaVersion = (value: unknown): value is (typeof supportedSchemaVersions)[number] => typeof value === 'string' && (supportedSchemaVersions as readonly string[]).includes(value);
import { validateDocument } from './schema.js';
import { validateSemantics } from './semantic.js';
import type { CatalogFile, CatalogIssue, CatalogLoadOptions } from './source.js';

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function lineFor(content: string, path: string): { line: number; column: number } {
  const key = path.split('.').at(-1) ?? '';
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lines = content.split(/\r?\n/);
  const index = lines.findIndex((line) => new RegExp(`^\\s*${escaped}\\s*:`).test(line));
  return { line: index >= 0 ? index + 1 : 1, column: index >= 0 ? (lines[index]?.search(/\S/) ?? 0) + 1 : 1 };
}

function defaults(value: Record<string, unknown>): Record<string, unknown> {
  const repository = asRecord(value.repository);
  const vercel = asRecord(value.vercel);
  const project = asRecord(vercel.project);
  const build = asRecord(project.build);
  const git = asRecord(project.git);
  const deployment = asRecord(project.deployment);
  const metadata = asRecord(value.metadata);
  const policies = asRecord(value.policies);
  const lifecycle = asRecord(value.lifecycle);
  const decommission = asRecord(lifecycle.decommission);
  const environments = asRecord(value.environments);
  const health = { path: '/api/health', method: 'GET', expectedStatus: [200], timeoutSeconds: 10, attempts: 10, intervalSeconds: 10 };
  const normalizedEnvironment = (environment: unknown): Record<string, unknown> => ({ enabled: true, strategy: 'native-preview', health, ...asRecord(environment) });
  const normalizedProject = {
    name: project.name,
    framework: project.framework ?? null,
    rootDirectory: project.rootDirectory ?? '.',
    nodeVersion: project.nodeVersion ?? null,
    build: { installCommand: null, buildCommand: null, outputDirectory: null, developmentCommand: null, ignoredBuildStep: null, ...build },
    git: { connected: true, productionBranch: repository.productionBranch ?? 'main', ...git },
    deployment: { autoAssignProductionDomains: false, prioritizeProductionBuilds: true, rollingRelease: null, skewProtection: false, ...deployment },
    regions: { functions: [], ...asRecord(project.regions) },
    protection: asRecord(project.protection),
    settings: asRecord(project.settings),
  };
  return {
    ...value,
    metadata: { displayName: metadata.id, description: null, owners: [], labels: {}, annotations: {}, ...metadata },
    repository: { access: { requirePrivateAccessVerification: true, requireVercelGitAccess: true }, onboarding: { managedWorkflow: false, workflowVersion: 'v1', openOnboardingPr: false }, ...repository },
    vercel: { scope: {}, ...vercel, project: normalizedProject },
    environments: { preview: normalizedEnvironment(environments.preview), ...(environments.staging ? { staging: normalizedEnvironment(environments.staging) } : {}), production: normalizedEnvironment(environments.production) },
    domains: Array.isArray(value.domains) ? value.domains : [],
    secrets: Array.isArray(value.secrets) ? value.secrets : [],
    dependencies: { applications: [], external: [], ...asRecord(value.dependencies) },
    policies: {
      drift: { mode: 'open-pr', checkIntervalMinutes: 30, ...asRecord(policies.drift) },
      destructiveChanges: { allowInNormalApply: false, ...asRecord(policies.destructiveChanges) },
      preview: { requiredForMerge: true, ...asRecord(policies.preview) },
      staging: { requiredForProduction: true, ...asRecord(policies.staging) },
      health: { requiredForPromotion: true, ...asRecord(policies.health) },
      failures: { createIssueAfterFinalRetry: true, notifyOwners: true, ...asRecord(policies.failures) },
    },
    lifecycle: { state: 'active', deletionProtection: true, orphanPolicy: 'retain', ...lifecycle, decommission: { requestedAt: null, deleteAfter: null, approvalToken: null, preserveDeployments: true, ...decommission } },
  };
}

export interface CatalogResult {
  applications: DesiredApplication[];
  issues: CatalogIssue[];
  canonical: string;
}

export function loadCatalog(files: readonly CatalogFile[], options: CatalogLoadOptions = {}): CatalogResult {
  const applications: DesiredApplication[] = [];
  const issues: CatalogIssue[] = [];
  const sortedFiles = [...files].sort((left, right) => left.path.localeCompare(right.path));
  const fileContents = new Map(sortedFiles.map((file) => [file.path, file.content]));
  for (const file of sortedFiles) {
    const document = parseDocument(file.content, { uniqueKeys: true });
    for (const error of document.errors) {
      issues.push({ code: 'LP-SCHEMA-YAML', file: file.path, line: error.linePos?.[0]?.line ?? 1, column: error.linePos?.[0]?.col ?? 1, path: '$', message: error.message, remediation: 'Fix YAML syntax and duplicate keys.' });
    }
    const raw = document.toJS({ mapAsMap: false }) as unknown;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      issues.push({ code: 'LP-SCHEMA-ROOT', file: file.path, line: 1, column: 1, path: '$', message: 'Application manifest must be a YAML object.', remediation: 'Use the Application manifest shape.' });
      continue;
    }
    const normalized = defaults(raw as Record<string, unknown>);
    if (!isSupportedSchemaVersion(normalized.apiVersion)) issues.push({ code: 'LP-SCHEMA-VERSION', file: file.path, line: 1, column: 1, path: 'apiVersion', message: 'Unsupported or missing API version.', remediation: 'Use launchpad.dev/v1.' });
    const schemaIssues = validateDocument(normalized, file.path, (path) => lineFor(file.content, path));
    issues.push(...schemaIssues);
    if (schemaIssues.length > 0) continue;
    applications.push({ ...(normalized as unknown as DesiredApplication), sourcePath: file.path });
  }
  issues.push(...validateSemantics(applications, fileContents, options.previousLifecycle ?? {}));
  const canonical = canonicalJson(applications.map(({ sourcePath: _sourcePath, ...application }) => application));
  return { applications, issues, canonical };
}
