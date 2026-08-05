import { canonicalJson } from '@launchpad/shared';

export function canonicalPlanInput(input: unknown): string {
  return canonicalJson(input);
}

/**
 * Canonical deep equality: key order in objects is irrelevant, array order
 * and primitive identity are significant. Used for all desired-vs-observed
 * comparisons so provider field ordering never produces phantom diffs.
 *
 * Unlike canonical JSON serialization — which must keep rejecting undefined
 * so persisted and fingerprinted payloads stay strict — equality handles
 * undefined leaves deterministically: `undefined` compares equal only to
 * itself, never to null or any other value, and never throws. Absent
 * optional fields therefore compare safely against observed payloads that
 * omit them.
 */
export function canonicalEqual(left: unknown, right: unknown): boolean {
  return equalValues(left, right);
}

function equalValues(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== typeof right || left === null || right === null || typeof left !== 'object') return false;
  if (left instanceof Date || right instanceof Date) {
    return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
  }
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left)) {
    const leftItems = left as unknown[];
    const rightItems = right as unknown[];
    if (leftItems.length !== rightItems.length) return false;
    for (let index = 0; index < leftItems.length; index++) {
      if (!equalValues(leftItems[index], rightItems[index])) return false;
    }
    return true;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  for (let index = 0; index < leftKeys.length; index++) {
    const leftKey = leftKeys[index];
    const rightKey = rightKeys[index];
    if (leftKey === undefined || rightKey === undefined || leftKey !== rightKey) return false;
    if (!equalValues(leftRecord[leftKey], rightRecord[rightKey])) return false;
  }
  return true;
}
