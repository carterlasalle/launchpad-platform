import { type DeploymentRecord, type DesiredApplication, type HealthCheckRecord, type HealthSpec } from '@launchpad/core';
import { checkHealth } from '@launchpad/health';
import { canonicalJson, idempotencyKey, redactText as redactCredentialShapedText } from '@launchpad/shared';
import type { LaunchpadStore } from '@launchpad/database';
import type { DeploymentLogExcerpt, ProjectProvider, ProviderContext } from '@launchpad/provider-contract';
import { DurableOperationRunner, type OperationRunResult } from './operation-runner.js';

export interface AppPreviewStatusInput {
  store: LaunchpadStore;
  /** ProjectProvider with the `findDeploymentByCommit` and `fetchDeploymentLogs` capabilities (VercelAdapter). */
  provider: ProjectProvider;
  desired: DesiredApplication;
  /** Exact PR head commit SHA; the only commit the gate may report on. */
  sourceCommit: string;
  context: ProviderContext;
  correlationId?: string | undefined;
  waitTimeoutMs?: number;
  waitPollMs?: number;
  maxLogLines?: number;
  maxLogBytes?: number;
  fetchImpl?: typeof fetch;
  sleep?: (delayMs: number) => Promise<void>;
}

export type AppBuildState = 'READY' | 'ERROR' | 'CANCELED' | 'TIMEOUT' | null;

export interface AppPreviewFailure { code: string; message: string; }

export interface AppPreviewStatusResult {
  status: 'SUCCEEDED' | 'FAILED';
  /** Preview gate verdict: PASSED only when build READY and health PASSED and all evidence collected. */
  gateState: 'PASSED' | 'FAILED';
  operationId: string | null;
  applicationId: string;
  sourceCommit: string;
  deployment: DeploymentRecord | null;
  buildState: AppBuildState;
  health: HealthCheckRecord | null;
  healthState: HealthCheckRecord['result'] | null;
  logs: DeploymentLogExcerpt | null;
  failure: AppPreviewFailure | null;
  commentBody: string;
  deploymentStatus: { state: 'success' | 'failure' | 'error'; description: string; targetUrl: string | null; logUrl: string | null };
  correlationId: string;
}

class WorkflowFailure extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = code;
    this.code = code;
  }
}

const STICKY_COMMENT_MARKER = '<!-- launchpad:app-preview -->';

function escapeMarkdown(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('|', '\\|').replaceAll('`', '&#96;');
}

function redactText(value: string): string {
  return redactCredentialShapedText(value).replace(/(gh[ps]_[A-Za-z0-9_]+|vercel_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+)/g, '[REDACTED]');
}

function redactLogText(value: string): string {
  return redactText(value).replaceAll('```', '``\u200b`');
}

function shortSha(commitSha: string): string {
  return commitSha.length > 12 ? commitSha.slice(0, 12) : commitSha;
}

const stateIcons: Record<string, string> = { READY: '✅', PASSED: '✅', CANCELED: '⚠️' };

export interface AppPreviewCommentInput {
  applicationId: string;
  sourceCommit: string;
  buildState: AppBuildState;
  previewUrl: string | null;
  healthState: HealthCheckRecord['result'] | null;
  healthDetails: string | null;
  failure: AppPreviewFailure | null;
  logs: string | null;
  operationId: string | null;
  correlationId: string;
}

/**
 * Renders the one sticky PR comment for an application preview run. The marker
 * is stable so publishing code can update instead of duplicate (TR-GH-005).
 * Every provider-derived value is markdown-escaped and secret-redacted.
 */
export function renderAppPreviewComment(input: AppPreviewCommentInput): string {
  const marker = STICKY_COMMENT_MARKER;
  const title = input.failure === null
    ? `${stateIcons[input.buildState ?? ''] ?? '✅'} Launchpad preview passed for \`${shortSha(input.sourceCommit)}\``
    : `⚠️ Launchpad preview failed for \`${shortSha(input.sourceCommit)}\``;
  const lines: string[] = [
    marker,
    `### ${title}`,
    '',
    `| Check | Result |`,
    `| --- | --- |`,
    `| Build | ${input.buildState === 'READY' ? '✅ Ready' : `❌ ${escapeMarkdown(input.buildState ?? 'UNKNOWN')}`} |`,
    `| Health | ${input.healthState === 'PASSED' ? '✅ Passed' : input.healthState === null ? '— not run —' : `❌ ${escapeMarkdown(input.healthState)}`} |`,
  ];
  if (input.previewUrl) lines.push(`| Preview | ${escapeMarkdown(input.previewUrl)} |`);
  if (input.healthDetails) lines.push(`- Details: ${escapeMarkdown(redactText(input.healthDetails))}`);
  if (input.failure) lines.push('', `**${escapeMarkdown(redactText(input.failure.code))}**: ${escapeMarkdown(redactText(input.failure.message))}`);
  if (input.logs) lines.push('', '<details><summary>Build logs (redacted)</summary>', '', '```', redactLogText(input.logs), '```', '', '</details>');
  lines.push('', `_[${escapeMarkdown(input.applicationId)} · ${shortSha(input.sourceCommit)} · operation \`${input.operationId ?? '—'}\` · ${input.correlationId}]_`);
  return lines.join('\n');
}

function healthDetails(health: HealthCheckRecord | null): string | null {
  if (!health) return null;
  if (health.result !== 'PASSED') return health.errorCode ?? `HTTP ${health.statusCode ?? '—'}`;
  return null;
}

function buildStateOf(deployment: DeploymentRecord | null): AppBuildState {
  if (deployment === null) return null;
  if (deployment.state === 'READY') return 'READY';
  if (deployment.state === 'ERROR' || deployment.state === 'CANCELED') return deployment.state;
  if (deployment.state === 'QUEUED' || deployment.state === 'BUILDING') return 'TIMEOUT';
  return null;
}

function failureOf(run: OperationRunResult): AppPreviewFailure | null {
  if (run.status === 'SUCCEEDED') return null;
  if (run.error instanceof Error) return { code: run.error.name, message: run.error.message };
  return { code: 'LP-WORKFLOW-STEP-FAILED', message: 'The preview verification workflow failed.' };
}

function defaultHealthSpec(): HealthSpec {
  return { path: '/api/health', method: 'GET', expectedStatus: [200], timeoutSeconds: 10, attempts: 1, intervalSeconds: 0 };
}

/**
 * Exact-commit preview verification pipeline:
 * locate (exact commit) -> wait for terminal build -> bounded logs -> build
 * gate -> health (exact preview URL) -> report. Every step persists through
 * the durable operation runner; failures are terminal, visible, and never
 * silently downgraded (PRD-STS-003/004).
 */
export async function runAppPreviewStatusWorkflow(input: AppPreviewStatusInput): Promise<AppPreviewStatusResult> {
  const { store, provider, desired, sourceCommit, context } = input;
  const applicationId = desired.metadata.id;
  const correlationId = input.correlationId ?? context.correlationId;
  const waitTimeoutMs = input.waitTimeoutMs ?? 1_200_000;
  const waitPollMs = input.waitPollMs ?? 5_000;
  const maxLogLines = input.maxLogLines ?? 200;
  const maxLogBytes = input.maxLogBytes ?? 16_000;
  const healthSpec = desired.environments.preview?.health ?? defaultHealthSpec();
  const expectedRepository = desired.repository.name;

  const previewIdempotencyKey = idempotencyKey('app-preview-status', applicationId, sourceCommit);
  const payloadHash = canonicalJson({ applicationId, sourceCommit, repository: expectedRepository, correlationId });
  const operation = await store.startWorkflowRun({ applicationId, workflowType: 'PREVIEW_STATUS', idempotencyKey: previewIdempotencyKey, payloadHash });
  const operationId = operation.id;

  // Closure-assigned step state. The initializer carries the full type because
  // TypeScript otherwise narrows these to the null literal at top-level reads.
  let deployment: DeploymentRecord | null = null as DeploymentRecord | null;
  let health: HealthCheckRecord | null = null as HealthCheckRecord | null;
  let logs: DeploymentLogExcerpt | null = null as DeploymentLogExcerpt | null;
  let commentBody = '';
  let deploymentStatus: AppPreviewStatusResult['deploymentStatus'] = { state: 'error', description: 'Launchpad preview verification did not complete.', targetUrl: null, logUrl: null };
  const assembleReport = (passed: boolean, failure: AppPreviewFailure | null): void => {
    const buildState = buildStateOf(deployment);
    commentBody = renderAppPreviewComment({
      applicationId,
      sourceCommit,
      buildState,
      previewUrl: deployment?.url ?? null,
      healthState: health?.result ?? null,
      healthDetails: healthDetails(health),
      failure,
      logs: logs?.excerpt ?? null,
      operationId,
      correlationId,
    });
    deploymentStatus = passed
      ? { state: 'success', description: `Launchpad preview gate passed for ${shortSha(sourceCommit)}.`, targetUrl: deployment?.url ?? null, logUrl: null }
      : failure?.code === 'LP-HEALTH-PREVIEW-FAILED'
        ? { state: 'failure', description: `Launchpad preview health check failed (${shortSha(sourceCommit)}).`, targetUrl: deployment?.url ?? null, logUrl: null }
        : { state: 'error', description: `Launchpad preview gate failed: ${failure?.code ?? 'unknown'} (${shortSha(sourceCommit)}).`, targetUrl: deployment?.url ?? null, logUrl: null };
  };

  const runner = new DurableOperationRunner(store);
  const run = await runner.run({
    applicationId,
    workflowId: context.workflowId,
    action: 'PREVIEW_STATUS',
    idempotencyKey: previewIdempotencyKey,
    payloadHash,
    steps: [
      {
        id: 'locate-deployment',
        preconditionHash: sourceCommit,
        retry: { maxAttempts: 2, baseDelayMs: 1_000 },
        run: async () => {
          if (typeof provider.findDeploymentByCommit !== 'function') throw new WorkflowFailure('LP-PROVIDER-CAPABILITY-MISSING', 'The provider cannot locate deployments by exact commit.');
          const found = await provider.findDeploymentByCommit(applicationId, sourceCommit, context, { expectedRepository });
          if (!found) throw new WorkflowFailure('LP-VERCEL-PREVIEW-NOT_FOUND', `No Vercel preview deployment exists for commit ${shortSha(sourceCommit)}.`);
          if (found.commitSha !== sourceCommit) throw new WorkflowFailure('LP-VERCEL-PREVIEW-COMMIT-MISMATCH', `Located deployment ${found.id} is for commit ${shortSha(found.commitSha)}, not ${shortSha(sourceCommit)}.`);
          if (found.environment !== 'preview') throw new WorkflowFailure('LP-VERCEL-PREVIEW-ENVIRONMENT-MISMATCH', `Located deployment ${found.id} is a ${found.environment} deployment.`);
          if (found.projectId !== applicationId) throw new WorkflowFailure('LP-VERCEL-PREVIEW-PROJECT-MISMATCH', `Located deployment ${found.id} belongs to a different project.`);
          if (found.repository && found.repository !== expectedRepository) throw new WorkflowFailure('LP-VERCEL-PREVIEW-REPOSITORY-MISMATCH', `Located deployment ${found.id} belongs to repository ${found.repository}.`);
          deployment = found;
          return found;
        },
      },
      {
        id: 'wait-for-build',
        preconditionHash: sourceCommit,
        retry: { maxAttempts: 1, baseDelayMs: 1_000 },
        run: async () => {
          const current = deployment;
          if (!current) throw new WorkflowFailure('LP-VERCEL-PREVIEW-NOT_FOUND', 'No deployment was located before waiting.');
          const terminal = await provider.waitForDeployment({ projectId: current.projectId, deploymentId: current.id, timeoutMs: waitTimeoutMs, pollMs: waitPollMs }, context);
          if (terminal.commitSha && terminal.commitSha !== sourceCommit) throw new WorkflowFailure('LP-VERCEL-PREVIEW-COMMIT-MISMATCH', `Deployment ${terminal.id} resolved to commit ${shortSha(terminal.commitSha)} while waiting.`);
          deployment = terminal;
          return terminal;
        },
      },
      {
        id: 'collect-build-logs',
        preconditionHash: sourceCommit,
        retry: { maxAttempts: 1, baseDelayMs: 1_000 },
        run: async () => {
          const current = deployment;
          if (!current) throw new WorkflowFailure('LP-VERCEL-PREVIEW-NOT_FOUND', 'No deployment was located before collecting logs.');
          if (typeof provider.fetchDeploymentLogs !== 'function') throw new WorkflowFailure('LP-PROVIDER-CAPABILITY-MISSING', 'The provider cannot fetch deployment logs.');
          const excerpt = await provider.fetchDeploymentLogs({ deploymentId: current.id, maxLines: maxLogLines, maxBytes: maxLogBytes }, context);
          logs = { ...excerpt, excerpt: redactLogText(excerpt.excerpt) };
          return logs;
        },
      },
      {
        id: 'build-gate',
        preconditionHash: sourceCommit,
        retry: { maxAttempts: 1, baseDelayMs: 1_000 },
        run: async () => {
          const current = deployment;
          if (!current) throw new WorkflowFailure('LP-VERCEL-PREVIEW-NOT_FOUND', 'No deployment was located before the build gate.');
          if (current.state !== 'READY') throw new WorkflowFailure('LP-VERCEL-BUILD-FAILED', `Vercel preview deployment ended in ${current.state}.`);
          return current.state;
        },
      },
      {
        id: 'health-check',
        preconditionHash: sourceCommit,
        retry: { maxAttempts: 1, baseDelayMs: 1_000 },
        run: async () => {
          const current = deployment;
          if (!current) throw new WorkflowFailure('LP-VERCEL-PREVIEW-NOT_FOUND', 'No deployment was located before the health check.');
          if (!current.url) throw new WorkflowFailure('LP-PREVIEW-URL-MISSING', 'The Vercel deployment has no preview URL to health-check.');
          const record = await checkHealth({ applicationId, environment: 'preview', deploymentId: current.id, baseUrl: current.url, spec: healthSpec, fetchImpl: input.fetchImpl, sleep: input.sleep });
          health = record;
          if (record.result !== 'PASSED') throw new WorkflowFailure('LP-HEALTH-PREVIEW-FAILED', `Preview health check against ${current.url} did not pass (${record.errorCode ?? 'ASSERTION_FAILED'}).`);
          return record;
        },
      },
      {
        id: 'report',
        preconditionHash: canonicalJson({ deployment: deployment?.id ?? null, health: health?.id ?? null, logs: logs?.excerpt.length ?? 0 }),
        retry: { maxAttempts: 2, baseDelayMs: 1_000 },
        run: async () => {
          assembleReport(true, null);
          return { commentBody, deploymentStatus };
        },
      },
    ],
  });

  const failure = failureOf(run);
  if (run.status !== 'SUCCEEDED') assembleReport(false, failure);
  return {
    status: run.status === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED',
    gateState: run.status === 'SUCCEEDED' ? 'PASSED' : 'FAILED',
    operationId,
    applicationId,
    sourceCommit,
    deployment,
    buildState: buildStateOf(deployment),
    health,
    healthState: health?.result ?? null,
    logs,
    failure,
    commentBody,
    deploymentStatus,
    correlationId,
  };
}
