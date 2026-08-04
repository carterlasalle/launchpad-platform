import type { ProjectProvider, ProviderContext, RollbackResult } from '@launchpad/provider-contract';

export interface RollbackProductionInput { provider: ProjectProvider; projectId: string; failedDeploymentId: string; knownGoodDeploymentId: string; context: ProviderContext; }

export async function rollbackProduction(input: RollbackProductionInput): Promise<RollbackResult> {
  if (input.failedDeploymentId === input.knownGoodDeploymentId) throw new Error('LP-ROLLBACK-SAME-DEPLOYMENT');
  return input.provider.rollback({ projectId: input.projectId, deploymentId: input.failedDeploymentId, previousKnownGoodId: input.knownGoodDeploymentId }, input.context);
}
