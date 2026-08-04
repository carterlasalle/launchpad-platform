import { checkHealth } from '@launchpad/health';
import type { DeploymentRecord, HealthCheckRecord, HealthSpec } from '@launchpad/core';
import type { ProjectProvider, ProjectSpec, ProviderContext } from '@launchpad/provider-contract';

export interface PreviewWorkflowInput { provider: ProjectProvider; project: ProjectSpec; pullRequestNumber: number; revision: number; commitSha: string; health: HealthSpec; context: ProviderContext; fetchImpl?: typeof fetch; sleep?: (delayMs: number) => Promise<void>; }
export interface PreviewWorkflowResult { projectId: string; projectName: string; deployment: DeploymentRecord; health: HealthCheckRecord; cleanupProjectId: string; }
export interface CleanupResult { projectId: string; status: 'CLEANED' | 'FAILED'; errorCode: string | null; message: string; }

export async function runPreviewWorkflow(input: PreviewWorkflowInput): Promise<PreviewWorkflowResult> {
  const projectName = `lp-pr-${input.pullRequestNumber}-${input.project.id}-${input.revision}`.replace(/[^a-z0-9-]/gi, '-').slice(0, 63);
  const shadowProject: ProjectSpec = { ...input.project, id: projectName, name: projectName, settings: { ...input.project.settings, launchpadShadow: true, launchpadPullRequest: input.pullRequestNumber, launchpadRevision: input.revision } };
  await input.provider.ensureProject(shadowProject, input.context);
  await input.provider.ensureGitConnection({ projectId: shadowProject.id, repository: input.project.repository, productionBranch: input.project.productionBranch }, input.context);
  const deployment = await input.provider.createDeployment({ projectId: shadowProject.id, environment: 'preview', repository: input.project.repository, commitSha: input.commitSha, desiredGeneration: input.revision, staged: false, rootDirectory: input.project.rootDirectory }, input.context);
  const ready = await input.provider.waitForDeployment({ projectId: shadowProject.id, deploymentId: deployment.id, timeoutMs: input.health.timeoutSeconds * 1000 * Math.max(input.health.attempts, 1), pollMs: Math.max(100, input.health.intervalSeconds * 1000) }, input.context);
  const health = await checkHealth({ applicationId: input.context.applicationId, environment: 'preview', deploymentId: ready.id, baseUrl: ready.url ?? `https://${projectName}.vercel.app`, spec: input.health, fetchImpl: input.fetchImpl, sleep: input.sleep });
  return { projectId: shadowProject.id, projectName, deployment: ready, health, cleanupProjectId: shadowProject.id };
}

export async function cleanupShadowProject(provider: ProjectProvider, projectId: string, context: ProviderContext): Promise<CleanupResult> {
  try {
    const existing = await provider.observeProject({ projectId }, context);
    if (!existing) return { projectId, status: 'FAILED', errorCode: 'LP-PREVIEW-CLEANUP-FAILED', message: 'Shadow project was not found during cleanup.' };
    await provider.deleteProject(projectId, context);
    return { projectId, status: 'CLEANED', errorCode: null, message: 'Shadow project deleted.' };
  } catch (error) {
    return { projectId, status: 'FAILED', errorCode: 'LP-PREVIEW-CLEANUP-FAILED', message: error instanceof Error ? error.message : 'Shadow project cleanup failed.' };
  }
}
