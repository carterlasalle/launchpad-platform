# Launchpad release checklist

Every release must be executable: each gate below is either a command run
against the protected commit or a live artifact from the release run. A gate
that cannot run fails the release; nothing is claimed from memory.

## Acceptance evidence

- `yarn acceptance:offline` passes: the deterministic offline acceptance
  matrix (real GitHub/Vercel/Cloudflare adapters over the recorded sandbox
  transport, real D1 migrations, workflow/controller boundaries) proves
  every master-plan scenario (sections 11, 33, 47 and this checklist's
  Safety/Reliability/Deployment-correctness/Reconciliation gates) and exits
  non-zero if any required scenario is missing, failed, or skipped. The
  runtime report is generated at
  `artifacts/acceptance-report.json` (never checked in; a stale report
  fails the gate); per-scenario evidence lands in
  `artifacts/acceptance-evidence/<scenario>.json`. Scenario ids are listed
  in `tests/end-to-end/acceptance-matrix.ts`.
- `yarn acceptance:live` passes against dedicated GitHub, Vercel, and
  Cloudflare sandbox resources: requires `LAUNCHPAD_LIVE_ACCEPTANCE=1` plus
  every `LP_LIVE_*` variable naming the sandbox (prefix-guarded; see
  `scripts/acceptance-live.mjs`). It performs seven phases in the named
  sandbox — observe, create/update, preview, health, drift-restore,
  cleanup, and a direct-push-rejected probe (an attempted non-force
  fast-forward update of the sandbox default branch must be explicitly
  rejected by a rule/protection; unexpected success restores the original
  ref and fails the gate) — and emits `artifacts/acceptance-live-report.json`.
  When disabled it prints a clear skip and claims nothing; when enabled with
  missing or ambiguous prerequisites it exits non-zero. A skipped live run
  is not evidence — the live gates below must actually pass.
- Live-only gates that offline mode never claims:
  - `LIVE-RULESET`: ruleset verified against the live GitHub API (see
    "Ruleset verification").
  - `LIVE-DIRECT-PUSH`: an attempted non-force fast-forward direct push to
    the sandbox default branch is rejected by the live ruleset (403/422
    with a rule/protection reason); unexpected success restores the ref and
    fails the gate.
  - `LIVE-E2E-RESOURCES`: end-to-end create/update/preview/health/
    drift-restore/cleanup against the dedicated sandbox resources.

## Code quality

- `yarn install --immutable` succeeds against the locked `yarn.lock`.
- `node scripts/check-toolchain.mjs` passes (Node/Yarn pins match
  `docs/adr/0007-toolchain-node-yarn.md`).
- `node scripts/check-workflows.mjs` passes (all third-party actions pinned
  to immutable SHAs, every workflow starts with `permissions: {}`).
- `yarn dedupe --check` passes.
- `yarn typecheck`, `yarn lint`, `yarn test`, and `yarn build` succeed.

## Supply chain and dependency review

- Dependency automation is active: Renovate (`renovate.json`) opens update
  PRs and the private-repository-compatible `dependency / review` workflow
  (`.github/workflows/dependency-review.yml`) is green on every dependency
  PR and is a required status check on `main`.
- `yarn npm audit --all --recursive --severity high` reports no findings.
- `yarn.lock` is current and immutable installs are enforced
  (`.yarnrc.yml`, `setup-launchpad` action).

## Ruleset verification

- `node scripts/verify-ruleset.mjs` passes against the live GitHub API
  (token: `LAUNCHPAD_RULESET_TOKEN`, fine-grained, Administration: read):
  - Ruleset `launchpad-main` is `active` and covers `refs/heads/main`.
  - No bypass actors; pull-request, review, CODEOWNER, stale-dismissal,
    latest-push-approval, conversation-resolution, status-check, strict
    up-to-date, no-force-push, no-deletion, and no-creation rules match
    `.github/rulesets/main.json`.
  - Required checks `static / toolchain`, `static / quality`,
    `platform / summary`, and `dependency / review` are all required.
    `platform / summary` aggregates schema, catalog, provider preflight,
    plan, preview, and health for relevant platform changes.
  - Squash-merge-only repository settings and `main` default branch verified.
- Unavailability or mismatch fails the release (deploy gate in
  `.github/workflows/deploy-control-plane.yml`).
- Direct pushes to `main` are rejected (attempted with a test push;
  offline config-contract: `SEC-RULESET-CONFIG`, live attempt:
  `LIVE-DIRECT-PUSH` via `yarn acceptance:live`).
- CODEOWNER approval is required for catalog, schema, workflow, controller,
  policy, toolchain, ruleset, and runbook paths (`.github/CODEOWNERS`;
  offline acceptance: `SEC-RULESET-CONFIG`).

## Controller release artifact integrity

- The deploy run's `static / foundation gate` job passed (toolchain, action
  pins, active ruleset).
- The deployed commit is an ancestor of protected `main`
  (`LP-UNPROTECTED-COMMIT` check in the deploy job).
- `artifacts/launchpad-sbom.cdx.json` was generated from the protected
  commit, uploaded, and attested with `actions/attest-build-provenance`.
- Attestation verifies:
  `gh attestation verify artifacts/launchpad-sbom.cdx.json --owner <owner>`
- `yarn wrangler deploy --env production` succeeded and
  `yarn platform controller-smoke --controller <url>` returned 200.

## Safety

- Normal apply blocks `DESTROY` before provider writes
  (offline acceptance: `DEL-NORMAL-APPLY-BLOCKS-DESTROY`,
  `DEL-MISSING-MANIFEST`).
- Stale plan fingerprints block apply (offline acceptance:
  `PROMO-STALE-PLAN`).
- Reviewed-plan attestations gate merged applies: a squash-merged equivalent
  plan passes on the source-commit-neutral review fingerprint, while a
  missing attestation, provider drift after review, or changed desired
  state/generation blocks before any provider write; replays are idempotent
  (offline acceptance: `PLAN-REVIEW-SQUASH-PASS`,
  `PLAN-REVIEW-DRIFT-BLOCKS`, `PLAN-REVIEW-DESIRED-DRIFT-BLOCKS`,
  `PLAN-REVIEW-MISSING-BLOCKS`).
- Secret-canary scan is clean (offline acceptance:
  `SEC-SECRET-REDACTION`).
- Catalog gates: duplicate IDs/domains, unknown fields, plaintext secrets,
  invalid lifecycle transitions, and unsupported settings are blocked with
  file/field context (offline acceptance: `CAT-*`, `GH-*`).
- Deletion approvals are single-use and fingerprint-only (offline
  acceptance: `DEL-APPROVAL-TOKEN`); tombstoned identities stay blocked
  (`DEL-ORDERED-TEARDOWN`).

## Reliability

- Durable workflow interruption/resume test passes (offline acceptance:
  `DUR-INTERRUPT-RESUME`, `DUR-IDEMPOTENT-DELIVERY`, `DUR-LOCK-RECOVERY`,
  `DEL-PARTIAL-RESUME`).
- Retry exhaustion reaches the DLQ and creates visible failure state
  (`incidents` row with `type = 'DLQ'` before the message is acknowledged,
  `DLQ_INCIDENT` audit event, and `dlq_count` metric snapshot) — offline
  acceptance: `OBS-DLQ`.
- Application and domain lock recovery is tested (offline acceptance:
  `DUR-LOCK-RECOVERY`).

## Observability and alerting

- Forced provider timeout/permanent failure produces a typed durable record
  (`provider_errors` with `code`/`class`/`retryable`/`remediation`) and
  reaches every applicable visibility surface: incident row, audit event,
  GitHub Actions summary, sticky PR comment, and commit status — offline
  acceptance: `OBS-PROVIDER-ERROR`, `OBS-METRICS-SNAPSHOT`,
  `OBS-WEBHOOK-DEDUPE`.
- Alerts fire and dedupe: `DLQ`, `RECONCILIATION_FAILURE` (consecutive
  threshold, default 3), `CREDENTIAL_EXPIRY` (metadata-only check, window
  default 14 days), and `CONTROLLER_ERROR_RATE` (threshold default 0.1)
  respect `LAUNCHPAD_ALERT_COOLDOWN_SECONDS` (default 3600); incident rows
  are upserted per (type, fingerprint) and reopened on refire.
- Metric snapshots are persisted per scheduled window
  (`SELECT metric, total, rate, captured_at FROM metric_snapshots ORDER BY captured_at DESC LIMIT 20`)
  with bounded labels (provider, workflow).
- Webhook replay deduplicates against the durable receipt
  (`webhook_events`); the controller acknowledges a webhook only after the
  receipt row is readable and exactly one sanitized provider-event envelope
  was enqueued to `PROVIDER_EVENTS` (receipt marked `dispatched_at`; a replay
  with a missing marker heals the send, a replay with a marker never sends
  twice). Only the event id/type and non-secret resource identifiers survive
  in the receipt, envelope, and audit trail — never the raw body.
- Secret-canary scan covers logs, provider-error rows, incident rows,
  artifacts, and PR comments.

## Deployment correctness

- Invalid-root preview fails with bounded Vercel log output (offline
  acceptance: `PRV-INVALID-ROOT`, `PRV-BUILD-ERROR`).
- Candidate health blocks promotion (offline acceptance:
  `HEALTH-CANDIDATE-BLOCKS-PROMOTION`).
- Exact commit promotion is verified (offline acceptance: `PROMO-EXACT`,
  `PROMO-COMMIT-MISMATCH`).
- Post-promotion failure restores known-good and leaves release red
  (offline acceptance: `RB-KNOWN-GOOD`, `RB-NO-KNOWN-GOOD`).
- Preview lifecycle: READY/ERROR/supersession and the app-repo gate
  (offline acceptance: `PRV-READY`, `PRV-SUPERSEDE`, `PRV-GATE`).
- DNS correct/conflict/delay/invalid (offline acceptance: `DNS-*`).
- The production deploy renders `LAUNCHPAD_AUTHORITATIVE_DNS_RESOLVER_URL`
  from the `launchpad-control-plane` environment `vars` as a concrete,
  credential-free HTTPS URL: the config renderer and the concrete binding
  assertions reject absent, placeholder, or non-HTTPS values before Wrangler
  runs, so authoritative DNS verification is always configured in production
  (`apps/controller/src/dns-resolver.ts`).

## Reconciliation and deletion

- Manual drift produces one reconciliation PR per fingerprint (offline
  acceptance: `REC-DRIFT-PR`).
- Restore and adopt paths are reviewable (offline acceptance:
  `REC-SYNCED-RESTORE`; adopt is exercised by `REC-DRIFT-PR`'s
  restore PR).
- Provider read failure reports `UNKNOWN`/`BLOCKED` (offline acceptance:
  `REC-UNKNOWN-OUTAGE`).
- Manifest removal produces `BLOCKED_MISSING_MANIFEST` and deletes nothing;
  normal apply refuses `DESTROY` before provider writes (offline
  acceptance: `DEL-MISSING-MANIFEST`, `DEL-NORMAL-APPLY-BLOCKS-DESTROY`).
- Lifecycle transitions are explicit (active → decommissioning →
  approved-for-deletion → deleted); reactivation requires the declared
  recovery policy before approval.
- First PR carries the impact/reverse-dependent report, stops promotion, and
  starts the cooling-off period; the service stays up.
- Approval tokens are random, single-use, bound to app+domain+commit+actor+
  expiry; only SHA-256 fingerprints are persisted; the plaintext is never
  stored or logged.
- Destroy validates the exact approved commit (stale on any main movement),
  dependents, blocking operations, locks, and ownership before each mutation;
  runs the ordered teardown (proxy off → domain unassign → owned DNS →
  custom envs → deployments per policy → project → inactive deployments);
  persists a final export, tombstone, and immutable audit; and resumes from
  the last durable boundary after interruption or partial failure.
- Tombstoned app IDs/domains stay blocked until retention elapses or a
  reviewed override releases them.

## Operations

- Dashboard reads from D1 and separates sync, health, deployment, and
  operation state.
- Incidents, credential metadata, and metric snapshots are exposed to the
  operator dashboard (`GET /v1/incidents`, `GET /v1/credentials`,
  `GET /v1/metrics`; `POST /v1/incidents/<id>/resolve`).
- All outage, credential, migration, lock, DLQ, promotion, rollback,
  provider-schema, break-glass, controller, and secret-provider runbooks in
  `docs/runbooks/` are reviewed against the current release.
- Alerts for DLQ, reconciliation failure, credential expiry, and controller
  error rate are tested (see "Observability and alerting").
