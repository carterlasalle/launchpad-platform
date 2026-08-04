import type { DeploymentRecord } from '@launchpad/core';
import type { ProjectProvider, ProviderContext, PromotionResult } from '@launchpad/provider-contract';

export interface PromoteProductionInput { provider: ProjectProvider; projectId: string; candidate: DeploymentRecord; expectedCommitSha: string; context: ProviderContext; }

export async function promoteProduction(input: PromoteProductionInput): Promise<PromotionResult> {
  if (input.candidate.projectId !== input.projectId) throw new Error('LP-PROMOTION-PROJECT-MISMATCH');
  if (input.candidate.commitSha !== input.expectedCommitSha) throw new Error('LP-PROMOTION-COMMIT-MISMATCH');
  if (!['READY', 'STAGED'].includes(input.candidate.state)) throw new Error('LP-PROMOTION-CANDIDATE-NOT-READY');
  return input.provider.promote({ projectId: input.projectId, deploymentId: input.candidate.id, expectedCommitSha: input.expectedCommitSha }, input.context);
}
