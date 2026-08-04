import type { DeploymentRecord } from './types.js';

export type SyncStatus = 'SYNCED' | 'OUT_OF_SYNC' | 'RECONCILING' | 'BLOCKED' | 'UNKNOWN' | 'DECOMMISSIONING';

export function syncStatus(desiredHash: string | null, observedHash: string | null): SyncStatus {
  if (desiredHash === null || observedHash === null) return 'UNKNOWN';
  return desiredHash === observedHash ? 'SYNCED' : 'OUT_OF_SYNC';
}

export function deploymentStatus(state: DeploymentRecord['state'] | string): DeploymentRecord['state'] | string {
  return state;
}

export function healthStatus(passed: boolean | null): 'HEALTHY' | 'UNHEALTHY' | 'UNKNOWN' {
  if (passed === null) return 'UNKNOWN';
  return passed ? 'HEALTHY' : 'UNHEALTHY';
}
