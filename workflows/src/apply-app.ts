import { type DeploymentRecord, type DesiredApplication, type HealthCheckRecord, type ObservedApplication, type PlatformPlan } from '@launchpad/core';
import { checkHealth } from '@launchpad/health';
import { canonicalJson, idempotencyKey } from '@launchpad/shared';
import { LaunchpadRepositories } from '@launchpad/database';
import type { DeploymentRequest, DnsProvider, EnvironmentSpec as ProviderEnvironmentSpec, ProjectProvider, ProjectSpec, ProviderContext, RollbackResult } from '@launchpad/provider-contract';
import { DurableOperationRunner, type OperationRunResult } from './operation-runner.js';

export interface ApplyWorkflowInput { repositories: LaunchpadRepositories; provider: ProjectProvider & DnsProvider; desired: DesiredApplication; observed: ObservedApplication; plan: PlatformPlan; sourceCommit: string; context: ProviderContext; fetchImpl?: typeof fetch | undefined; sleep?: ((delayMs: number) => Promise<void>) | undefined; }
export interface ApplyWorkflowResult { status: 'SUCCEEDED' | 'FAILED'; operationId: string | null; candidate: DeploymentRecord | null; candidateHealth: HealthCheckRecord | null; productionHealth: HealthCheckRecord | null; rollback: RollbackResult | null; errorCode: string | null; }

class WorkflowFailure extends Error { readonly code: string; constructor(code: string, message: string) { super(message); this.name = code; this.code = code; } }

function projectSpec(application: DesiredApplication): ProjectSpec {
  const project = application.vercel.project;
  return { id: application.metadata.id, name: project.name, teamId: null, framework: project.framework, rootDirectory: project.rootDirectory, nodeVersion: project.nodeVersion, build: { installCommand: project.build.installCommand, buildCommand: project.build.buildCommand, outputDirectory: project.build.outputDirectory }, repository: application.repository.name, productionBranch: application.repository.productionBranch, settings: { ...project.settings, autoAssignProductionDomains: project.deployment.autoAssignProductionDomains } };
}

function providerEnvironment(application: DesiredApplication, environment: 'preview' | 'staging' | 'production'): ProviderEnvironmentSpec {
  const spec = application.environments[environment];
  return { projectId: application.metadata.id, environment, branch: spec?.branch ?? null, variables: {} };
}

function domainFor(application: DesiredApplication): string {
  return application.domains.find((domain) => domain.environment === 'production')?.hostname ?? `${application.metadata.id}.example.test`;
}

export async function runApplyWorkflow(input: ApplyWorkflowInput): Promise<ApplyWorkflowResult> {
  if (input.plan.sourceCommit !== input.sourceCommit) return { status: 'FAILED', operationId: null, candidate: null, candidateHealth: null, productionHealth: null, rollback: null, errorCode: 'LP-PLAN-STALE' };
  if (input.plan.result !== 'READY') return { status: 'FAILED', operationId: null, candidate: null, candidateHealth: null, productionHealth: null, rollback: null, errorCode: 'LP-PLAN-BLOCKED' };
  const runner = new DurableOperationRunner(input.repositories);
  const project = projectSpec(input.desired);
  const knownGood = input.observed.deployments.find((deployment) => deployment.environment === 'production' && deployment.state === 'CURRENT') ?? null;
  let candidate: DeploymentRecord | null = null;
  let candidateHealth: HealthCheckRecord | null = null;
  let productionHealth: HealthCheckRecord | null = null;
  let rollback: RollbackResult | null = null;
  const lockKey = `application:${input.desired.metadata.id}`;
  const locked = input.repositories.acquireLock(lockKey, input.context.workflowId, 900);
  if (!locked) return { status: 'FAILED', operationId: null, candidate, candidateHealth, productionHealth, rollback, errorCode: 'LP-LOCK-CONFLICT' };
  let run: OperationRunResult;
  try {
    run = await runner.run({ applicationId: input.desired.metadata.id, workflowId: input.context.workflowId, action: 'APPLY', idempotencyKey: idempotencyKey('apply', input.desired.metadata.id, input.sourceCommit, String(input.plan.desiredGeneration)), payloadHash: canonicalJson({ fingerprint: input.plan.fingerprint, sourceCommit: input.sourceCommit }), steps: [
      { id: 'project', preconditionHash: input.plan.fingerprint, run: async () => input.provider.ensureProject(project, input.context) },
      { id: 'git', preconditionHash: canonicalJson(input.desired.repository), run: async () => input.provider.ensureGitConnection({ projectId: project.id, repository: project.repository, productionBranch: project.productionBranch }, input.context) },
      { id: 'environment', preconditionHash: canonicalJson(input.desired.environments), run: async () => input.provider.ensureEnvironment(providerEnvironment(input.desired, 'production'), input.context) },
      { id: 'domains-and-dns', preconditionHash: canonicalJson(input.desired.domains), run: async () => {
        for (const domain of input.desired.domains) {
          await input.provider.ensureDomain({ projectId: project.id, hostname: domain.hostname, environment: domain.environment, mode: domain.cloudflare.mode }, input.context);
          const required = await input.provider.requiredDnsRecords({ projectId: project.id, hostname: domain.hostname, environment: domain.environment, mode: domain.cloudflare.mode }, input.context);
          const zone = await input.provider.observeZone(domain.cloudflare.zoneRef, input.context);
          for (const record of required) {
            await input.provider.ensureRecord(zone.zoneId, record, idempotencyKey('ownership', input.desired.metadata.id, domain.hostname), input.context);
            if (!(await input.provider.verifyAuthoritative(domain.hostname, record, input.context))) throw new WorkflowFailure('LP-DNS-VERIFICATION-TIMEOUT', `Authoritative DNS did not return ${domain.hostname}.`);
          }
        }
        return { domains: input.desired.domains.length };
      } },
      { id: 'candidate', preconditionHash: input.sourceCommit, run: async () => {
        const request: DeploymentRequest = { projectId: project.id, environment: 'production', repository: project.repository, commitSha: input.sourceCommit, desiredGeneration: input.plan.desiredGeneration, staged: true, rootDirectory: project.rootDirectory };
        candidate = await input.provider.createDeployment(request, input.context);
        return candidate;
      } },
      { id: 'candidate-ready', preconditionHash: input.sourceCommit, run: async () => {
        const currentCandidate = candidate;
        if (!currentCandidate) throw new WorkflowFailure('LP-CANDIDATE-MISSING', 'Candidate deployment was not created.');
        const readyCandidate = await input.provider.waitForDeployment({ projectId: project.id, deploymentId: currentCandidate.id, timeoutMs: 300_000, pollMs: 2_000 }, input.context);
        candidate = readyCandidate;
        if (!['READY', 'STAGED'].includes(readyCandidate.state)) throw new WorkflowFailure('LP-VERCEL-BUILD-FAILED', `Candidate deployment ended in ${readyCandidate.state}.`);
        return readyCandidate;
      } },
      { id: 'candidate-health', preconditionHash: input.sourceCommit, run: async () => {
        const currentCandidate = candidate;
        if (!currentCandidate) throw new WorkflowFailure('LP-CANDIDATE-MISSING', 'Candidate deployment is unavailable for health checks.');
        candidateHealth = await checkHealth({ applicationId: input.desired.metadata.id, environment: 'production', deploymentId: currentCandidate.id, baseUrl: currentCandidate.url ?? `https://${domainFor(input.desired)}`, spec: input.desired.environments.production?.health ?? { path: '/api/health', method: 'GET', expectedStatus: [200], timeoutSeconds: 10, attempts: 1, intervalSeconds: 0 }, fetchImpl: input.fetchImpl, sleep: input.sleep });
        if (candidateHealth.result !== 'PASSED') throw new WorkflowFailure('LP-HEALTH-CANDIDATE-FAILED', 'Candidate health gate failed.');
        return candidateHealth;
      } },
      { id: 'promote', preconditionHash: input.sourceCommit, run: async () => {
        const currentCandidate = candidate;
        if (!currentCandidate) throw new WorkflowFailure('LP-CANDIDATE-MISSING', 'Candidate deployment is unavailable for promotion.');
        if (currentCandidate.commitSha !== input.sourceCommit) throw new WorkflowFailure('LP-PROMOTION-COMMIT-MISMATCH', 'Candidate commit does not match the approved source commit.');
        const result = await input.provider.promote({ projectId: project.id, deploymentId: currentCandidate.id, expectedCommitSha: input.sourceCommit }, input.context);
        candidate = result.deployment;
        return result;
      } },
      { id: 'production-health', preconditionHash: input.sourceCommit, run: async () => {
        const currentCandidate = candidate;
        if (!currentCandidate) throw new WorkflowFailure('LP-CANDIDATE-MISSING', 'Promoted deployment is unavailable for health checks.');
        productionHealth = await checkHealth({ applicationId: input.desired.metadata.id, environment: 'production', deploymentId: currentCandidate.id, baseUrl: `https://${domainFor(input.desired)}`, spec: input.desired.environments.production?.health ?? { path: '/api/health', method: 'GET', expectedStatus: [200], timeoutSeconds: 10, attempts: 1, intervalSeconds: 0 }, fetchImpl: input.fetchImpl, sleep: input.sleep });
        return productionHealth;
      } },
      { id: 'record-known-good-or-rollback', preconditionHash: input.sourceCommit, run: async () => {
        const currentCandidate = candidate;
        if (productionHealth?.result === 'PASSED') return { knownGood: currentCandidate?.id ?? null };
        if (input.desired.environments.production?.rollback?.enabled && knownGood && currentCandidate) rollback = await input.provider.rollback({ projectId: project.id, deploymentId: currentCandidate.id, previousKnownGoodId: knownGood.id }, input.context);
        throw new WorkflowFailure('LP-HEALTH-PRODUCTION-FAILED', rollback?.restored ? 'Production health failed; previous known-good deployment restored.' : 'Production health failed and no automatic rollback was available.');
      } },
    ] });
  } finally {
    input.repositories.releaseLock(lockKey, input.context.workflowId);
  }
  return { status: run.status === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED', operationId: run.operationId, candidate, candidateHealth, productionHealth, rollback, errorCode: run.error instanceof WorkflowFailure ? run.error.code : run.error instanceof Error ? run.error.name : null };
}
