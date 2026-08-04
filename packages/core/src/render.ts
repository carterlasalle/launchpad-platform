import type { PlatformPlan } from './types.js';

function formatAction(action: string): string {
  return action === 'NO_CHANGE' ? 'No change' : action.replaceAll('_', ' ');
}

export function renderPlanMarkdown(plan: PlatformPlan): string {
  const result = plan.result === 'READY' ? '✅ READY' : plan.result === 'DESTRUCTIVE' ? '🛑 DESTRUCTIVE' : '❌ BLOCKED';
  const rows = plan.operations.map((operation) => `| ${operation.resourceKey} | ${formatAction(operation.action)} | ${operation.provider} | ${operation.destructive ? 'yes' : 'no'} |`).join('\n');
  const effects = plan.downstreamEffects.length === 0 ? '_None_' : plan.downstreamEffects.map((effect) => `- **${effect.resourceKey}** — ${effect.action}: ${effect.reason}`).join('\n');
  const policies = plan.policyResults.map((result) => `- ${result.result === 'PASS' ? '✅' : result.result === 'WARN' ? '⚠️' : '❌'} **${result.rule}** — ${result.message}`).join('\n');
  return `## Launchpad Plan\n\n**Application:** \`${plan.applicationId}\`  \n**Commit:** \`${plan.sourceCommit}\`  \n**Plan fingerprint:** \`sha256:${plan.fingerprint}\`  \n**Result:** ${result}\n\n### Operations\n\n| Resource | Action | Provider | Destructive |\n|---|---|---|---|\n${rows || '| _none_ | No change | — | no |'}\n\n### Downstream effects\n\n${effects}\n\n### Policy\n\n${policies}\n`;
}
