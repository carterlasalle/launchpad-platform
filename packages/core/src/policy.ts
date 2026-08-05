import type { DesiredApplication, PlanBlock, PlannedOperation, PolicyResult } from './types.js';

export function evaluatePolicies(desired: DesiredApplication, operations: PlannedOperation[], blocks: PlanBlock[] = []): PolicyResult[] {
  const results: PolicyResult[] = [];
  const destructive = operations.filter((operation) => operation.destructive);
  results.push(destructive.length > 0 ? { rule: 'destructiveChanges.allowInNormalApply', result: 'BLOCK', message: 'Normal apply refuses destructive operations.', remediation: 'Use the reviewed decommission and destroy workflow.' } : { rule: 'destructiveChanges.allowInNormalApply', result: 'PASS', message: 'No destructive operations are present.', remediation: null });
  const previewSecrets = desired.secrets.filter((secret) => secret.environments.includes('preview') && secret.sensitive !== false);
  results.push(previewSecrets.length > 0 ? { rule: 'preview.productionSecrets', result: 'BLOCK', message: 'Production-sensitive secret bindings cannot target preview.', remediation: 'Use a preview-safe secret reference or remove preview from the binding.' } : { rule: 'preview.productionSecrets', result: 'PASS', message: 'Preview secret bindings are safe.', remediation: null });
  const proxiedWithoutAck = desired.domains.filter((domain) => domain.cloudflare.mode === 'proxied' && domain.cloudflare.proxy?.acknowledgeDoubleCdn !== true);
  results.push(proxiedWithoutAck.length > 0 ? { rule: 'dns.proxyAcknowledgment', result: 'BLOCK', message: 'Cloudflare proxy mode requires explicit compatibility acknowledgment.', remediation: 'Complete the proxy compatibility checks and set acknowledgeDoubleCdn: true.' } : { rule: 'dns.proxyAcknowledgment', result: 'PASS', message: 'DNS proxy policy is explicit.', remediation: null });
  if (desired.lifecycle.state === 'decommissioning') results.push({ rule: 'lifecycle.decommissioning', result: 'WARN', message: 'Promotion is disabled while the application is decommissioning.', remediation: 'Cancel decommissioning or complete the cooling-off workflow.' });
  for (const block of blocks) {
    results.push({ rule: block.rule, result: 'BLOCK', message: block.message, remediation: block.remediation });
  }
  return results;
}
