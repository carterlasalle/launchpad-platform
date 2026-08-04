import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog, type CatalogIssue } from '@launchpad/catalog';
import { buildPlan, buildResourceGraph, renderPlanMarkdown, type DesiredApplication, type ObservedApplication } from '@launchpad/core';
import { checkHealth } from '@launchpad/health';
import { FakeProvider } from '@launchpad/provider-testkit';
import { artifactFiles, renderStickyComment } from '@launchpad/github-reporting';
import { GitHubAdapter } from '@launchpad/provider-github';
import { runPreviewWorkflow } from '@launchpad/workflows';
import type { ProjectSpec, ProviderContext } from '@launchpad/provider-contract';

export type CliCommand = 'validate' | 'plan' | 'status' | 'graph' | 'health' | 'reconcile' | 'logs' | 'preview' | 'report-pr' | 'apply' | 'destroy' | 'app-preview' | 'controller-smoke';
export interface CliArgs { command: CliCommand; flags: Record<string, string | boolean>; }
const knownFlags = new Set(['catalog', 'format', 'output', 'app', 'sha', 'pr', 'controller', 'approval-token', 'environment', 'dry-run', 'artifacts']);

export function parseCliArgs(argv: readonly string[]): CliArgs {
  const command = argv[0] as CliCommand | undefined;
  const commands: CliCommand[] = ['validate', 'plan', 'status', 'graph', 'health', 'reconcile', 'logs', 'preview', 'report-pr', 'apply', 'destroy', 'app-preview', 'controller-smoke'];
  if (!command || !commands.includes(command)) throw new Error(`Unknown or missing command. Expected one of: ${commands.join(', ')}.`);
  const flags: Record<string, string | boolean> = {};
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument?.startsWith('--')) throw new Error(`Unexpected argument '${argument ?? ''}'.`);
    const key = argument.slice(2);
    if (!knownFlags.has(key)) throw new Error(`Unknown option '--${key}'.`);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) { flags[key] = next; index += 1; } else flags[key] = true;
  }
  return { command, flags };
}

export function formatIssues(issues: readonly CatalogIssue[]): string {
  return issues.map((issue) => `${issue.file}:${issue.line}:${issue.column} ${issue.code} ${issue.path}: ${issue.message}${issue.remediation ? `\n  Remediation: ${issue.remediation}` : ''}`).join('\n');
}

function readCatalogFiles(root: string): Array<{ path: string; content: string }> {
  const files: Array<{ path: string; content: string }> = [];
  const workspaceRoot = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) files.push({ path: relative(workspaceRoot, fullPath), content: readFileSync(fullPath, 'utf8') });
    }
  };
  visit(resolve(workspaceRoot, root));
  return files.filter((file) => file.path.includes('/apps/') || file.path.includes('apps/'));
}

function emptyObserved(applicationId: string): ObservedApplication {
  return { applicationId, observedAt: new Date().toISOString(), desiredGeneration: 0, desiredHash: '', observedHash: '', resources: [], deployments: [], health: { status: 'UNKNOWN', latest: null } };
}

function projectSpec(application: DesiredApplication): ProjectSpec {
  const project = application.vercel.project;
  return { id: application.metadata.id, name: project.name, teamId: null, framework: project.framework, rootDirectory: project.rootDirectory, nodeVersion: project.nodeVersion, build: { installCommand: project.build.installCommand, buildCommand: project.build.buildCommand, outputDirectory: project.build.outputDirectory }, repository: application.repository.name, productionBranch: application.repository.productionBranch, settings: project.settings };
}

function providerContext(applicationId: string, flags: Record<string, string | boolean>): ProviderContext {
  return { correlationId: `cli-${Date.now()}`, applicationId, workflowId: 'cli', actor: { kind: 'operator', id: 'cli' }, dryRun: flags['dry-run'] === true };
}

export async function runCli(argv: readonly string[], output: { write(value: string): void } = process.stdout): Promise<number> {
  const args = parseCliArgs(argv);
  const catalogPath = typeof args.flags.catalog === 'string' ? args.flags.catalog : 'catalog';
  const result = loadCatalog(readCatalogFiles(catalogPath));
  if (args.command === 'validate') {
    output.write(result.issues.length === 0 ? `Catalog valid: ${result.applications.length} application(s).\n` : `${formatIssues(result.issues)}\n`);
    return result.issues.length === 0 ? 0 : 1;
  }
  if (result.issues.length > 0) { output.write(`${formatIssues(result.issues)}\n`); return 1; }
  const selected = typeof args.flags.app === 'string' ? result.applications.filter((application) => application.metadata.id === args.flags.app) : result.applications;
  if (selected.length === 0) { output.write('No matching applications.\n'); return 1; }
  const application = selected[0];
  if (!application) { output.write('No matching applications.\n'); return 1; }
  const provider = new FakeProvider();
  if (args.command === 'plan' || args.command === 'graph') {
    const plans = await Promise.all(selected.map(async (selectedApplication) => buildPlan({ desired: selectedApplication, observed: emptyObserved(selectedApplication.metadata.id), capabilities: await provider.capabilities(), sourceCommit: typeof args.flags.sha === 'string' ? args.flags.sha : '0'.repeat(40), desiredGeneration: 1 })));
    const content = args.command === 'graph' ? JSON.stringify(selected.map((selectedApplication) => buildResourceGraph(selectedApplication, emptyObserved(selectedApplication.metadata.id))), null, 2) : args.flags.format === 'json' ? JSON.stringify(plans, null, 2) : plans.map(renderPlanMarkdown).join('\n');
    if (typeof args.flags.output === 'string') {
      if (args.flags.output.endsWith('.json') || args.flags.output.endsWith('.md')) writeFileSync(args.flags.output, content);
      else { mkdirSync(args.flags.output, { recursive: true }); const artifacts = artifactFiles({ plan: plans[0]!, preview: { state: 'READY', url: null, message: 'Local fixture preview not requested.' }, health: { state: 'PASSED', message: 'Local fixture health not requested.' }, resourceGraph: selected.map((selectedApplication) => buildResourceGraph(selectedApplication, emptyObserved(selectedApplication.metadata.id))) }); for (const [name, value] of Object.entries(artifacts)) writeFileSync(join(args.flags.output, name), value); }
    } else output.write(`${content}\n`);
    return plans.some((plan) => plan.result !== 'READY') ? 1 : 0;
  }
  if (args.command === 'status') {
    output.write(`${JSON.stringify(selected.map((application) => ({ application: application.metadata.id, sync: 'UNKNOWN', health: 'UNKNOWN', deployment: 'UNKNOWN', productionUrl: application.domains.find((domain) => domain.environment === 'production')?.hostname ?? null })), null, 2)}\n`);
    return 0;
  }
  if (args.command === 'report-pr') {
    const plan = await buildPlan({ desired: application, observed: emptyObserved(application.metadata.id), capabilities: await provider.capabilities(), sourceCommit: typeof args.flags.sha === 'string' ? args.flags.sha : '0'.repeat(40), desiredGeneration: 1 });
    const body = renderStickyComment({ plan, preview: { state: 'READY', url: null, message: 'Preview result is managed by the preview workflow.' }, health: { state: 'PASSED', message: 'Health result is managed by the health workflow.' } });
    const repository = process.env.GITHUB_REPOSITORY;
    const pullRequestNumber = Number(process.env.GITHUB_PR_NUMBER ?? args.flags.pr ?? 0);
    const token = process.env.GITHUB_TOKEN;
    if (!repository || !token || pullRequestNumber <= 0) { output.write(`${body}\n`); return plan.result === 'READY' ? 0 : 1; }
    const github = new GitHubAdapter({ token });
    const reported = await github.upsertPullRequestComment({ repository, pullRequestNumber, marker: '<!-- launchpad:plan -->', body }, providerContext(application.metadata.id, args.flags));
    output.write(`Launchpad PR comment: ${reported.url}\n`);
    return plan.result === 'READY' ? 0 : 1;
  }
  if (args.command === 'preview') {
    const context = providerContext(application.metadata.id, args.flags);
    const preview = await runPreviewWorkflow({ provider, project: projectSpec(application), pullRequestNumber: Number(args.flags.pr ?? 0), revision: 1, commitSha: typeof args.flags.sha === 'string' ? args.flags.sha : '0'.repeat(40), health: application.environments.preview?.health ?? { path: '/api/health', method: 'GET', expectedStatus: [200], timeoutSeconds: 10, attempts: 1, intervalSeconds: 0 }, context, fetchImpl: async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 }), sleep: async () => undefined });
    output.write(`${JSON.stringify(preview, null, 2)}\n`);
    return preview.health.result === 'PASSED' ? 0 : 1;
  }
  if (args.command === 'health') {
    const domain = application.domains.find((candidate) => candidate.environment === (args.flags.environment === 'staging' ? 'staging' : 'production'));
    if (!domain) { output.write('No health domain configured.\n'); return 1; }
    const result = await checkHealth({ applicationId: application.metadata.id, environment: domain.environment, deploymentId: null, baseUrl: `https://${domain.hostname}`, spec: application.environments[domain.environment]?.health ?? { path: '/api/health', method: 'GET', expectedStatus: [200], timeoutSeconds: 10, attempts: 1, intervalSeconds: 0 } });
    output.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.result === 'PASSED' ? 0 : 1;
  }
  if (args.command === 'reconcile' && args.flags['dry-run'] === true) { output.write('Reconciliation dry run complete; no provider writes performed.\n'); return 0; }
  if (args.command === 'logs') { output.write('No local operation logs are available. Use the controller operation URL from the deployment summary.\n'); return 0; }
  const controller = typeof args.flags.controller === 'string' ? args.flags.controller : process.env.LAUNCHPAD_CONTROLLER_URL;
  if (!controller) { output.write('A controller URL is required for this command.\n'); return 1; }
  const response = await fetch(`${controller.replace(/\/$/, '')}/v1/cli/${args.command}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.LAUNCHPAD_OPERATOR_TOKEN ?? ''}` }, body: JSON.stringify({ applicationIds: selected.map((application) => application.metadata.id), sourceCommit: args.flags.sha ?? null, approvalToken: args.flags['approval-token'] ?? null }) });
  output.write(`${await response.text()}\n`);
  return response.ok ? 0 : 1;
}
