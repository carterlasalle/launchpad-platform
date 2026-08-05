import { canonicalJson } from '@launchpad/shared';
import type { DesiredApplication } from '@launchpad/core';
import { LineCounter, isAlias, isNode, isPair, isMap, parseAllDocuments, type Document, type Node } from 'yaml';
import { isSupportedSchemaVersion, migrateSchemaVersion } from './migrate.js';
import { validateDocument } from './schema.js';
import { validateSemantics, type SemanticValidationContext } from './semantic.js';
import type { CatalogFile, CatalogIssue, CatalogLoadOptions } from './source.js';

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
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
  const normalizedEnvironment = (environment: unknown, name: string): Record<string, unknown> => {
    const base: Record<string, unknown> = { enabled: true, health };
    if (name === 'preview') base.strategy = 'native-preview';
    return { ...base, ...asRecord(environment) };
  };
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
    metadata: {
      owners: [],
      labels: {},
      annotations: {},
      ...metadata,
      ...(typeof metadata.displayName === 'string'
        ? { displayName: metadata.displayName }
        : typeof metadata.id === 'string'
          ? { displayName: metadata.id }
          : {}),
    },
    repository: { access: { requirePrivateAccessVerification: true, requireVercelGitAccess: true }, onboarding: { managedWorkflow: false, workflowVersion: 'v1', openOnboardingPr: false }, ...repository },
    vercel: { scope: {}, ...vercel, project: normalizedProject },
    environments: {
      preview: normalizedEnvironment(environments.preview, 'preview'),
      ...(environments.staging ? { staging: normalizedEnvironment(environments.staging, 'staging') } : {}),
      production: normalizedEnvironment(environments.production, 'production'),
    },
    domains: Array.isArray(value.domains) ? [...value.domains] : [],
    secrets: Array.isArray(value.secrets) ? [...value.secrets] : [],
    dependencies: { applications: [], external: [], ...asRecord(value.dependencies) },
    policies: {
      drift: { mode: 'open-pr', checkIntervalMinutes: 30, ...asRecord(policies.drift) },
      destructiveChanges: { allowInNormalApply: false, ...asRecord(policies.destructiveChanges) },
      preview: { requiredForMerge: true, ...asRecord(policies.preview) },
      staging: { requiredForProduction: true, ...asRecord(policies.staging) },
      health: { requiredForPromotion: true, ...asRecord(policies.health) },
      failures: { createIssueAfterFinalRetry: true, notifyOwners: true, ...asRecord(policies.failures) },
    },
    lifecycle: {
      state: 'active',
      deletionProtection: true,
      orphanPolicy: 'retain',
      ...lifecycle,
      decommission: { requestedAt: null, deleteAfter: null, approvalToken: null, preserveDeployments: true, ...decommission },
      recoveryPolicy: { allowReactivateBeforeDeletionApproval: false, ...asRecord(lifecycle.recoveryPolicy) },
    },
  };
}

/** Resolve exact source positions for dot-joined paths against a parsed document. */
function positionResolver(content: string, document: Document, counter: LineCounter): (path: string) => { line: number; column: number } {
  const cache = new Map<string, { line: number; column: number }>();
  const nodeAt = (segments: Array<string | number>): Node | null => {
    if (segments.length === 0) return document.contents;
    return document.getIn(segments, true) as Node | null;
  };
  const keyNode = (map: unknown, segment: string | number): Node | null => {
    if (!isMap(map)) return null;
    for (const pair of map.items) {
      const key = pair.key;
      if (key !== null && typeof key === 'object' && 'value' in key && key.value === segment) return key as Node;
    }
    return null;
  };
  return (path: string): { line: number; column: number } => {
    const cached = cache.get(path);
    if (cached) return cached;
    const segments = path === '$' ? [] : path.split('.').map((segment) => (/^\d+$/.test(segment) ? Number(segment) : segment));
    let position: { line: number; column: number } | null = null;
    for (let length = segments.length; length >= 0 && position === null; length -= 1) {
      if (length > 0) {
        const segment = segments[length - 1];
        if (segment !== undefined) {
          const key = keyNode(nodeAt(segments.slice(0, length - 1)), segment);
          if (key) {
            const offset = key.range?.[0];
            if (typeof offset === 'number') {
              const linePos = counter.linePos(offset);
              position = { line: linePos.line, column: linePos.col };
              break;
            }
          }
        }
      }
      const node = nodeAt(segments.slice(0, length));
      if (node) {
        const offset = node.range?.[0];
        if (typeof offset === 'number') {
          const linePos = counter.linePos(offset);
          position = { line: linePos.line, column: linePos.col };
          break;
        }
      }
    }
    const result = position ?? lineFor(content, path);
    cache.set(path, result);
    return result;
  };
}

interface Construct { kind: 'alias' | 'tag'; node: Node }

function collectConstructs(node: Node | null, out: Construct[]): void {
  if (!node) return;
  if (isAlias(node)) {
    out.push({ kind: 'alias', node });
    return;
  }
  if (typeof node.tag === 'string' && !node.tag.startsWith('tag:yaml.org,2002:')) out.push({ kind: 'tag', node });
  if (isPair(node)) {
    collectConstructs(node.key as Node | null, out);
    collectConstructs(node.value as Node | null, out);
    return;
  }
  if ('items' in node) {
    for (const item of node.items) {
      if (isPair(item)) {
        collectConstructs(item.key as Node | null, out);
        collectConstructs(item.value as Node | null, out);
      } else if (isNode(item)) {
        collectConstructs(item, out);
      }
    }
  }
}

export interface CatalogResult {
  applications: DesiredApplication[];
  issues: CatalogIssue[];
  canonical: string;
}

export function loadCatalog(files: readonly CatalogFile[], options: CatalogLoadOptions = {}): CatalogResult {
  const applications: DesiredApplication[] = [];
  const issues: CatalogIssue[] = [];
  const sortedFiles = [...files].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const fileContents = new Map(sortedFiles.map((file) => [file.path, file.content]));
  const resolvers = new Map<string, (path: string) => { line: number; column: number }>();

  for (const file of sortedFiles) {
    const counter = new LineCounter();
    const documents = parseAllDocuments(file.content, { uniqueKeys: true, lineCounter: counter });
    if (documents.length > 1) {
      const second = documents[1];
      const offset = second?.range?.[0] ?? second?.contents?.range?.[0] ?? 0;
      const position = counter.linePos(offset);
      issues.push({ code: 'LP-SCHEMA-YAML', file: file.path, line: position.line, column: position.col, path: '$', message: `Manifest contains ${documents.length} YAML documents; exactly one is allowed.`, remediation: 'Split the file or remove the document separator.' });
      continue;
    }
    const document = documents[0];
    if (!document) {
      issues.push({ code: 'LP-SCHEMA-ROOT', file: file.path, line: 1, column: 1, path: '$', message: 'Application manifest must be a YAML object.', remediation: 'Use the Application manifest shape.' });
      continue;
    }
    for (const error of document.errors) {
      issues.push({ code: 'LP-SCHEMA-YAML', file: file.path, line: error.linePos?.[0]?.line ?? 1, column: error.linePos?.[0]?.col ?? 1, path: '$', message: error.message, remediation: 'Fix YAML syntax and duplicate keys.' });
    }
    if (document.errors.length > 0) continue;
    const constructs: Construct[] = [];
    collectConstructs(document.contents, constructs);
    if (constructs.length > 0) {
      for (const construct of constructs) {
        const offset = construct.node.range?.[0] ?? 0;
        const position = counter.linePos(offset);
        if (construct.kind === 'alias') {
          issues.push({ code: 'LP-SCHEMA-ALIAS', file: file.path, line: position.line, column: position.col, path: '$', message: 'YAML aliases and merge keys are not allowed; they create ambiguous canonical output.', remediation: 'Inline the referenced value instead of using an anchor or alias.' });
        } else {
          issues.push({ code: 'LP-SCHEMA-TAG', file: file.path, line: position.line, column: position.col, path: '$', message: `Explicit YAML tag '${construct.node.tag}' is not allowed.`, remediation: 'Use plain YAML scalars and collections.' });
        }
      }
      continue;
    }
    const raw = document.toJS({ mapAsMap: false }) as unknown;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      issues.push({ code: 'LP-SCHEMA-ROOT', file: file.path, line: 1, column: 1, path: '$', message: 'Application manifest must be a YAML object.', remediation: 'Use the Application manifest shape.' });
      continue;
    }
    const value = raw as Record<string, unknown>;
    const apiVersionNode = document.getIn(['apiVersion'], true) as Node | null;
    const versionOffset = apiVersionNode?.range?.[0] ?? document.contents?.range?.[0] ?? 0;
    const versionPosition = counter.linePos(versionOffset);
    let normalizedValue = value;
    if (!isSupportedSchemaVersion(value.apiVersion)) {
      const migration = migrateSchemaVersion(value);
      if (migration) {
        normalizedValue = migration.value;
        issues.push({ code: 'LP-CATALOG-MIGRATED', file: file.path, line: versionPosition.line, column: versionPosition.col, path: 'apiVersion', message: `Manifest migrated from '${migration.migratedFrom}' to '${migration.to}' for validation; the source file was not rewritten.`, remediation: 'Commit the explicit v1 manifest so the migration becomes a permanent no-op.' });
      } else {
        issues.push({ code: 'LP-SCHEMA-VERSION', file: file.path, line: versionPosition.line, column: versionPosition.col, path: 'apiVersion', message: `Unsupported or missing API version '${String(value.apiVersion)}'.`, remediation: 'Use launchpad.dev/v1 or a version with a registered migration.' });
        continue;
      }
    }
    const normalized = defaults(normalizedValue);
    const resolvePosition = positionResolver(file.content, document, counter);
    resolvers.set(file.path, resolvePosition);
    const schemaIssues = validateDocument(normalized, file.path, resolvePosition);
    issues.push(...schemaIssues);
    if (schemaIssues.length > 0) continue;
    applications.push({ ...(normalized as unknown as DesiredApplication), sourcePath: file.path });
  }

  const semanticContext: SemanticValidationContext = {
    files: fileContents,
    resolvePosition: (file, path) => {
      const resolver = resolvers.get(file);
      return resolver ? resolver(path) : { line: 1, column: 1 };
    },
    ...(options.previousLifecycle !== undefined ? { previousLifecycle: options.previousLifecycle } : {}),
    ...(options.previousRepositories !== undefined ? { previousRepositories: options.previousRepositories } : {}),
    ...(options.zones !== undefined ? { zones: options.zones } : {}),
  };
  issues.push(...validateSemantics(applications, semanticContext));
  const canonical = canonicalJson(applications.map(({ sourcePath: _sourcePath, ...application }) => application));
  return { applications, issues, canonical };
}
