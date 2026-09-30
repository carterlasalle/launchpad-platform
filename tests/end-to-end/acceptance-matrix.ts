/**
 * Acceptance matrix (tests/end-to-end).
 *
 * Single source of truth for the offline deterministic acceptance matrix.
 * Every entry maps requirement ids from the master plan sections 11 (Launch
 * acceptance), 33 (Acceptance criteria table), and 47 (Test matrix) — plus
 * the release checklist gates — to one deterministic offline scenario in
 * acceptance.test.ts.
 *
 * The runtime acceptance report (artifacts/acceptance-report.json) embeds
 * this matrix; the report gate (scripts/acceptance-offline.mjs) and the
 * suite itself fail when any required scenario is missing, failed, or
 * skipped. Live-only gates are listed separately (`liveGates`) and are never
 * claimed by offline mode.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { redactResourceIds } from './acceptance-harness.js';

export interface RequiredScenario {
  id: string;
  /** Master plan sections that mandate this scenario. */
  sections: string[];
  /** Release-checklist gate(s) this scenario proves. */
  checklist: string[];
  description: string;
}

export const REQUIRED_SCENARIOS: readonly RequiredScenario[] = [
  // --- Catalog and schema (plan §32/33: duplicate app ID, duplicate subdomain,
  // unsupported setting, invalid root; §47 Schema; release "Safety") ---
  { id: 'CAT-VALID', sections: ['33', '47'], checklist: ['Safety'], description: 'A valid manifest loads with zero issues and a deterministic canonical document.' },
  { id: 'CAT-INVALID-SYNTAX', sections: ['33', '47'], checklist: ['Safety'], description: 'Malformed YAML root syntax fails with file, line, and column context.' },
  { id: 'CAT-UNKNOWN-FIELD', sections: ['33', '47'], checklist: ['Safety'], description: 'An unknown manifest field is rejected (LP-SCHEMA-UNKNOWN-FIELD), never ignored.' },
  { id: 'CAT-DUP-ID', sections: ['33', '47'], checklist: ['Safety'], description: 'Duplicate application ID blocks the PR (LP-CATALOG-DUPLICATE-ID).' },
  { id: 'CAT-DUP-DOMAIN', sections: ['33', '47'], checklist: ['Safety'], description: 'Duplicate subdomain/domain blocks the PR (LP-CATALOG-DUPLICATE-DOMAIN).' },
  { id: 'CAT-PLAINTEXT-SECRET', sections: ['33', '47'], checklist: ['Safety'], description: 'Plaintext sensitive secret values in the catalog are rejected.' },
  { id: 'CAT-LIFECYCLE-TRANSITION', sections: ['33', '47'], checklist: ['Safety'], description: 'Invalid lifecycle transitions fail with manifest context.' },
  { id: 'CAT-DEPENDENCY-CYCLE', sections: ['33', '47'], checklist: ['Safety'], description: 'Dependency cycles between applications are rejected.' },
  { id: 'CAT-UNSUPPORTED-SETTING', sections: ['33', '47'], checklist: ['Safety'], description: 'A setting outside the real adapter capability matrix blocks the plan (LP-UNSUPPORTED-FIELD) instead of being ignored; a from-scratch domain plan is READY with the real matrices.' },

  // --- Repository access (§47 Repository; §33 Missing private-repo access; TR-PROV) ---
  { id: 'GH-PRIVATE-ACCESS', sections: ['33', '47'], checklist: ['Safety'], description: 'Accessible private repository observation returns repository id, privacy, and access through the real GitHub adapter.' },
  { id: 'GH-PRIVATE-DENIED', sections: ['33', '47'], checklist: ['Safety'], description: 'Inaccessible/forbidden repository surfaces a typed AUTHORIZATION provider error that blocks the PR gate.' },
  { id: 'GH-ARCHIVED', sections: ['33', '47'], checklist: ['Safety'], description: 'Archived repositories are observed as archived so the access gate can block them.' },

  // --- Shadow preview (§13.4/§36/§47 Vercel build; §33 invalid root, build
  // failure, PR superseded) ---
  { id: 'PRV-READY', sections: ['11', '33', '47'], checklist: ['Deployment correctness'], description: 'A valid proposed configuration receives a working shadow preview: project created with ownership metadata, deployment READY, health PASSED, cleanup scheduled, resource tracked in D1.' },
  { id: 'PRV-BUILD-ERROR', sections: ['33', '47'], checklist: ['Deployment correctness'], description: 'A failing build fails the preview loudly (LP-VERCEL-BUILD-FAILED) with a bounded, redacted log excerpt.' },
  { id: 'PRV-INVALID-ROOT', sections: ['33', '47'], checklist: ['Deployment correctness'], description: 'A deliberately incorrect root directory fails the preview with the relevant Vercel build error.' },
  { id: 'PRV-SUPERSEDE', sections: ['33', '47'], checklist: ['Reliability'], description: 'A new PR revision supersedes the prior revision: the old shadow project is cleaned up, the prior run is canceled, and exactly one shadow resource stays active.' },
  { id: 'PRV-PRODUCTION-SECRET', sections: ['33', '47'], checklist: ['Safety'], description: 'A production-only secret target is statically rejected from shadow previews before any provider write.' },
  { id: 'PRV-GATE', sections: ['11', '33', '47'], checklist: ['Deployment correctness'], description: 'Application-repo preview gate: READY build + PASSED health yields PASSED; build ERROR yields FAILED with the build log.' },

  // --- DNS (§13.7/§47 DNS; §33 DNS delayed/permanently invalid; TR-DNS) ---
  { id: 'DNS-CREATE-VERIFY', sections: ['33', '47'], checklist: ['Deployment correctness'], description: 'Correct CNAME: an owned record is created with the Launchpad ownership comment and verifies through the authoritative resolver.' },
  { id: 'DNS-UNOWNED-CONFLICT', sections: ['33', '47'], checklist: ['Safety'], description: 'A conflicting unowned record blocks apply (LP-DNS-CONFLICT-UNOWNED); nothing is overwritten.' },
  { id: 'DNS-PROPAGATION-DELAY', sections: ['33', '47'], checklist: ['Deployment correctness'], description: 'DNS propagation delay: authoritative verification retries with bounded backoff until the record converges.' },
  { id: 'DNS-PERMANENT-FAILURE', sections: ['33', '47'], checklist: ['Deployment correctness'], description: 'Permanently invalid DNS fails loudly (LP-DNS-VERIFICATION-TIMEOUT) after the bounded verification window.' },
  { id: 'DNS-AUTH-NS-MISSING', sections: ['33', '47'], checklist: ['Safety'], description: 'Missing authoritative nameservers fail closed (LP-DNS-AUTHORITATIVE-NAMESERVERS-MISSING).' },
  { id: 'DNS-PROXY-WRITE-GATE', sections: ['33', '47'], checklist: ['Deployment correctness'], description: 'Acknowledged proxied mode writes proxied:true and the durable proxy compatibility gate promotes only after compatible origin/public probes.' },
  { id: 'DNS-PROXY-INCOMPATIBLE', sections: ['33', '47'], checklist: ['Safety'], description: 'Incompatible origin/public probes block promotion (LP-DNS-PROXY-COMPATIBILITY-FAILED); promote is never dispatched.' },
  { id: 'DNS-PROXY-UNACKNOWLEDGED', sections: ['33', '47'], checklist: ['Safety'], description: 'Unacknowledged proxied mode blocks (plan BLOCKED, dns.proxyAcknowledgment) before any DNS write.' },

  // --- Health (§13.6/§47 Health; §33 staged build unhealthy; TR-DEP-004) ---
  { id: 'HEALTH-EXPECTED', sections: ['33', '47'], checklist: ['Deployment correctness'], description: 'Expected status and body pass the health check.' },
  { id: 'HEALTH-WRONG', sections: ['33', '47'], checklist: ['Deployment correctness'], description: 'Wrong status or body fails the health check with typed assertion results.' },
  { id: 'HEALTH-CANDIDATE-BLOCKS-PROMOTION', sections: ['33', '47'], checklist: ['Deployment correctness'], description: 'An unhealthy staged candidate blocks promotion; the production domain is never promoted.' },

  // --- Promotion (§13.6/§47 Promotion; §33 provider state changed after
  // approval / exact commit) ---
  { id: 'PROMO-EXACT', sections: ['11', '33', '47'], checklist: ['Deployment correctness', 'Reliability'], description: 'After the Vercel domain-verification (verify POST) and TLS-readiness (certs READY) gates ran, the exact candidate is promoted, becomes CURRENT, is recorded known-good, and locks are released.' },
  { id: 'PROMO-STALE-PLAN', sections: ['33', '47'], checklist: ['Safety'], description: 'Provider state changed after approval: apply stops with LP-PLAN-STALE before any provider write.' },
  { id: 'PROMO-COMMIT-MISMATCH', sections: ['33', '47'], checklist: ['Deployment correctness'], description: 'A candidate whose commit does not match the approved commit is rejected (LP-PROMOTION-COMMIT-MISMATCH).' },

  // --- Rollback (§13.6/§47 Rollback; §33 production unhealthy after
  // promotion; §11 failed production health) ---
  { id: 'RB-KNOWN-GOOD', sections: ['11', '33', '47'], checklist: ['Deployment correctness'], description: 'Post-promotion health failure restores the previous known-good deployment and leaves the release red.' },
  { id: 'RB-NO-KNOWN-GOOD', sections: ['33', '47'], checklist: ['Deployment correctness'], description: 'Without a known-good deployment, rollback is refused and the failure is visible (no silent success).' },

  // --- Drift and reconciliation (§13.8/§47 Drift; §33 manual Vercel change,
  // drift persists; §11 drift detection + reconciliation PR; TR-REC) ---
  { id: 'REC-DRIFT-PR', sections: ['11', '33', '47'], checklist: ['Reconciliation'], description: 'Manual drift is detected, appears OUT_OF_SYNC with a stable fingerprint, and opens exactly one reviewable reconciliation PR per fingerprint.' },
  { id: 'REC-SYNCED-RESTORE', sections: ['33', '47'], checklist: ['Reconciliation'], description: 'When drift is restored, reconciliation returns SYNCED, resolves the drift event, and supersedes open reconciliation requests.' },
  { id: 'REC-UNKNOWN-OUTAGE', sections: ['11', '33', '47'], checklist: ['Reconciliation'], description: 'Provider read failure reports UNKNOWN with typed access errors; the state is never reported SYNCED.' },

  // --- Deletion (§13.10/§47 Deletion; §33 remove app file / decommission;
  // §11 deletion cannot occur through ordinary catalog removal; TR-LIFE) ---
  { id: 'DEL-MISSING-MANIFEST', sections: ['11', '33', '47'], checklist: ['Safety'], description: 'Manifest removal produces BLOCKED_MISSING_MANIFEST and deletes nothing.' },
  { id: 'DEL-NORMAL-APPLY-BLOCKS-DESTROY', sections: ['11', '33', '47'], checklist: ['Safety'], description: 'Normal apply refuses a DESTROY plan before the first provider write.' },
  { id: 'DEL-APPROVAL-TOKEN', sections: ['33', '47'], checklist: ['Safety'], description: 'Deletion approvals are random, single-use, bound to app+domain+commit+actor+expiry; only SHA-256 fingerprints are persisted; reuse is refused.' },
  { id: 'DEL-ORDERED-TEARDOWN', sections: ['33', '47'], checklist: ['Safety'], description: 'The approved decommission runs the ordered teardown (proxy off, Vercel domain unassign via removeDomain, owned DNS delete, deployment delete via deleteDeployment, project delete, inactive statuses) with each delegated delete executed exactly once, persists the final export and tombstone, and blocks reuse.' },
  { id: 'DEL-PARTIAL-RESUME', sections: ['33', '47'], checklist: ['Reliability'], description: 'An interrupted/partially failed destroy resumes from the last durable boundary without repeating completed mutations, including the delegated Vercel domain unassign and deployment delete.' },

  // --- Durability (§14.1/§37 M6/§47 Controller; §33 controller crashes;
  // §11 forced provider timeout + interruption) ---
  { id: 'DUR-INTERRUPT-RESUME', sections: ['11', '33', '47'], checklist: ['Reliability'], description: 'A forced provider timeout exhausts bounded durable retries; the workflow resumes from the last durable step without duplicate writes.' },
  { id: 'DUR-IDEMPOTENT-DELIVERY', sections: ['33', '47'], checklist: ['Reliability'], description: 'Duplicate delivery with one idempotency key does not duplicate operations or provider writes.' },
  { id: 'DUR-LOCK-RECOVERY', sections: ['33', '47'], checklist: ['Reliability'], description: 'Lock conflict blocks apply before writes; releasing the lock lets the same operation succeed; locks are released on completion.' },

  // --- Observability (§49 Gate C; §33 retry limit exhausted → DLQ; §11
  // forced timeout reporting; release checklist DLQ/alerts/metrics) ---
  { id: 'OBS-DLQ', sections: ['33', '47'], checklist: ['Reliability', 'Observability and alerting'], description: 'Retry exhaustion reaches the DLQ and creates a visible DLQ incident before acknowledgment, with audit event and dlq_count metric snapshot.' },
  { id: 'OBS-PROVIDER-ERROR', sections: ['11', '33', '47'], checklist: ['Observability and alerting'], description: 'A forced provider timeout produces a typed provider-error row (code/class/retryable/remediation) and a deduped, reopenable incident.' },
  { id: 'OBS-METRICS-SNAPSHOT', sections: ['33', '47'], checklist: ['Observability and alerting'], description: 'Metric snapshots are persisted per window with bounded labels.' },
  { id: 'OBS-WEBHOOK-DEDUPE', sections: ['33', '47'], checklist: ['Observability and alerting'], description: 'Webhook replay deduplicates against the durable receipt.' },

  // --- Reviewed-plan approval gate (§11 approval gate; §33 provider state
  // changed after approval; squash-merge-neutral plan review) ---
  { id: 'PLAN-REVIEW-SQUASH-PASS', sections: ['11', '33', '47'], checklist: ['Deployment correctness'], description: 'A squash-merged equivalent plan passes the approval gate: the source-commit-neutral review fingerprint is identical across the PR head and the merged commit, while the exact plan fingerprints differ.' },
  { id: 'PLAN-REVIEW-DRIFT-SURVIVES', sections: ['11', '33', '47'], checklist: ['Safety'], description: 'Provider drift after review: the review identity binds the desired state, so the attestation survives drift and the apply proceeds past the approval gate.' },
  { id: 'PLAN-REVIEW-DESIRED-DRIFT-BLOCKS', sections: ['11', '33', '47'], checklist: ['Safety'], description: 'Changed desired state or generation after review yields no attestation for the new review fingerprint and blocks apply before any provider write.' },
  { id: 'PLAN-REVIEW-MISSING-BLOCKS', sections: ['11', '33', '47'], checklist: ['Safety', 'Reliability'], description: 'Apply without a reviewed-plan attestation blocks before provider writes; re-attesting the same reviewed plan is idempotent (one row, replay returns it, conflicting bindings are refused); recording the attestation unblocks the identical apply.' },

  // --- Security gates (§11 branch rules/CODEOWNERS/secret redaction; §33
  // direct push / CODEOWNER approval; §49 Gate B; release checklist) ---
  { id: 'SEC-RULESET-CONFIG', sections: ['11', '33', '47'], checklist: ['Ruleset verification', 'Safety'], description: 'The main ruleset configuration is active, covers main, has no bypass actors, requires review/CODEOWNERS/status checks, and is wired as a deploy gate; CODEOWNERS protects catalog, schema, workflow, and toolchain paths.' },
  { id: 'SEC-SECRET-REDACTION', sections: ['11', '33', '47'], checklist: ['Safety', 'Observability and alerting'], description: 'Secret canary scan is clean across plans, comments, artifacts, build logs, health records, D1 rows, incident rows, and the acceptance report itself.' },
];

/** Live-only gates that offline mode never claims. Each names its exact command. */
export const LIVE_GATES: ReadonlyArray<{ id: string; command: string; description: string }> = [
  { id: 'LIVE-RULESET', command: 'yarn acceptance:live', description: 'verify-ruleset.mjs against the live GitHub API; active ruleset with no bypass actors and matching parameters.' },
  { id: 'LIVE-DIRECT-PUSH', command: 'yarn acceptance:live', description: 'A non-force fast-forward update of the sandbox default-branch ref to an unattached child commit is rejected by the live ruleset (403/422 with a rule/protection/GH006/GH013/pull-request reason); unexpected success restores the ref and fails the gate.' },
  { id: 'LIVE-E2E-RESOURCES', command: 'yarn acceptance:live', description: 'End-to-end create/update/preview/health/drift-restore/cleanup against dedicated GitHub, Vercel, and Cloudflare sandbox resources.' },
];

export const REQUIRED_SCENARIO_IDS: readonly string[] = REQUIRED_SCENARIOS.map((scenario) => scenario.id);

// ---------------------------------------------------------------------------
// Runtime report
// ---------------------------------------------------------------------------

export interface ScenarioReportEntry {
  id: string;
  sections: string[];
  checklist: string[];
  description: string;
  status: 'passed' | 'failed' | 'skipped';
  durationMs: number;
  observed: string;
  /** Sandbox resource ids, redacted for the report. */
  resourceIds: Record<string, string>;
  /** Relative paths to per-scenario evidence artifacts. */
  evidence: string[];
  failure?: string | null;
}

export interface AcceptanceReport {
  schemaVersion: 'launchpad.acceptance/v1';
  mode: 'offline' | 'live' | 'skipped';
  command: string;
  generatedAt: string;
  durationMs: number;
  environment: {
    /** Exact Node version (no leading 'v'), e.g. '24.18.0'. */
    node: string;
    /** Exact Yarn version, e.g. '4.10.3'. */
    yarn: string;
    /** Source commit the evidence was generated from: GITHUB_SHA when set, else current git HEAD; exactly 40 lowercase hex. */
    commit: string;
    repoRoot: string;
    offline: boolean;
  };
  matrix: ScenarioReportEntry[];
  liveGates: typeof LIVE_GATES;
  summary: { total: number; passed: number; failed: number; skipped: number };
}

// Evidence-provenance helpers shared with the offline gate
// (scripts/acceptance-offline.mjs). The suite records the environment
// metadata through these so the recorded and gate-expected values can never
// drift apart.
export { readToolchainPins, resolveSourceCommit, runningToolchain } from '../../scripts/acceptance-evidence.mjs';

const ARTIFACTS_DIR = resolve(process.cwd(), 'artifacts');
const EVIDENCE_DIR = resolve(ARTIFACTS_DIR, 'acceptance-evidence');

export function artifactsDir(): string {
  return ARTIFACTS_DIR;
}

export function evidenceDir(): string {
  return EVIDENCE_DIR;
}

/** Writes a per-scenario evidence artifact and returns its relative path. */
export function writeEvidence(scenarioId: string, evidence: unknown): string {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const file = resolve(EVIDENCE_DIR, `${scenarioId}.json`);
  writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  return `artifacts/acceptance-evidence/${scenarioId}.json`;
}

/** Serializes the report with resource ids redacted; writes artifacts/acceptance-report.json. */
export function writeAcceptanceReport(report: Omit<AcceptanceReport, 'liveGates'>): AcceptanceReport {
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const full: AcceptanceReport = { ...report, liveGates: LIVE_GATES };
  const serialized = `${JSON.stringify(full, (key, value) => (typeof value === 'string' ? redactResourceIds(value) : value), 2)}\n`;
  writeFileSync(resolve(ARTIFACTS_DIR, 'acceptance-report.json'), serialized, 'utf8');
  return full;
}
