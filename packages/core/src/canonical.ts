import { canonicalJson } from '@launchpad/shared';

export function canonicalPlanInput(input: unknown): string {
  return canonicalJson(input);
}
