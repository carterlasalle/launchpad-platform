# Launchpad Unified GitOps Platform Implementation Plan

> **For agentic workers:** Implement this plan task-by-task in the current repository. Each task must leave the workspace type-safe and testable. Use test-driven development for every observable contract. Do not add provider credentials to files, tests, fixtures, logs, or commits.

**Goal:** Build the complete Launchpad 1.0 GitOps control plane described in `docs/Launchpad_Unified_GitOps_Master_Plan.md`, including catalog validation, deterministic planning, real provider adapters, durable operations, GitHub workflows, health verification, promotion/rollback, drift reconciliation, safe deletion, dashboard, and release tests.

**Architecture:** Keep the core provider-neutral and pure. Load Git manifests into canonical desired state, observe GitHub/Vercel/Cloudflare through versioned contracts, generate a deterministic resource DAG and redacted plan, then execute idempotent durable workflows through a Worker/D1 control plane. Use deterministic fake providers and a local SQLite/D1-compatible repository for tests; real fetch-based adapters use runtime credentials only.

**Tech Stack:** Node.js 24.18.0 baseline, Yarn 4.10.3, TypeScript strict ESM, `yaml`, `ajv`, `vitest`, `hono`, `jose`, Cloudflare Workers/Workflows/D1/Queues, GitHub Actions, Vercel REST APIs, Cloudflare DNS API.

---

## File map

### Root and configuration

- Create `package.json`: private Yarn workspace, package manager pin, root scripts.
- Create `.yarnrc.yml`: `node-modules` linker and immutable installs.
- Create `.node-version` and `.nvmrc`: `24.18.0`.
- Create `tsconfig.json`: strict composite TypeScript project references.
- Create `vitest.config.ts`: workspace test discovery and deterministic test environment.
- Create `.gitignore`, `.gitattributes`, `.editorconfig`: generated files, secrets, and consistent text handling.
- Create `wrangler.jsonc`: Worker, D1, queues, workflow, and static asset bindings.
- Create `catalog/defaults.yaml`, `catalog/environments.yaml`, and `catalog/apps/fixture.yaml`: valid local fixture catalog.
- Create `schema/app.schema.json`, `schema/defaults.schema.json`, and `schema/schema-version.ts`: strict schemas.

### Shared and domain packages

- Create `packages/shared/src/result.ts`, `hash.ts`, `ids.ts`, `retry.ts`, `sensitive.ts`, `time.ts`, and `index.ts`.
- Create `packages/core/src/types.ts`, `canonical.ts`, `errors.ts`, `graph.ts`, `diff.ts`, `policy.ts`, `plan.ts`, `render.ts`, `status.ts`, and `index.ts`.
- Create `packages/catalog/src/source.ts`, `loader.ts`, `schema.ts`, `semantic.ts`, `index.ts`, and tests.
- Create `packages/provider-contract/src/types.ts`, `capabilities.ts`, `provider.ts`, `errors.ts`, and `index.ts`.

### Providers and health

- Create `packages/provider-testkit/src/fake-provider.ts`, `fake-clock.ts`, and tests.
- Create `packages/provider-github/src/client.ts`, `adapter.ts`, `index.ts`, and tests.
- Create `packages/provider-vercel/src/client.ts`, `adapter.ts`, `log-parser.ts`, `index.ts`, and tests.
- Create `packages/provider-cloudflare/src/client.ts`, `adapter.ts`, `dns.ts`, `index.ts`, and tests.
- Create `packages/provider-secrets/src/provider.ts`, `env-provider.ts`, `index.ts`, and tests.
- Create `packages/health/src/types.ts`, `assertions.ts`, `checker.ts`, `retry.ts`, and `index.ts`.

### Persistence, workflows, and applications

- Create `migrations/d1/0001_initial.sql`, `0002_constraints.sql`, and `migrations/d1/README.md`.
- Create `packages/database/src/types.ts`, `db.ts`, `repositories.ts`, `locks.ts`, `migrations.ts`, and `index.ts`.
- Create `workflows/src/types.ts`, `operation-runner.ts`, `apply-app.ts`, `preview-app.ts`, `reconcile-app.ts`, `promote-production.ts`, `rollback-production.ts`, `decommission-app.ts`, and `index.ts`.
- Create `apps/cli/src/main.ts`, `commands/validate.ts`, `plan.ts`, `status.ts`, `graph.ts`, `health.ts`, `reconcile.ts`, `logs.ts`, and `index.ts`.
- Create `apps/controller/src/env.ts`, `auth/oidc.ts`, `auth/webhooks.ts`, `api.ts`, `worker.ts`, `queues.ts`, `dashboard.ts`, and `index.ts`.
- Create `apps/dashboard/src/index.html`, `app.ts`, `styles.css`, and `dashboard.ts`.

### GitHub, operations, and tests

- Create `.github/CODEOWNERS`, `.github/pull_request_template.md`, `.github/actions/setup-launchpad/action.yml`.
- Create `.github/workflows/validate-plan.yml`, `apply.yml`, `reconcile.yml`, `destroy.yml`, `deploy-control-plane.yml`, and `reusable-app-preview.yml`.
- Create `tests/fixtures/catalog`, `tests/fixtures/provider`, `tests/unit`, `tests/integration`, `tests/end-to-end`, and `tests/security`.
- Create `docs/runbooks/*.md` for every required operational scenario and `docs/release-checklist.md`.

---

## Task 1: Scaffold the workspace and toolchain

**Files:** root configuration listed above, every package `package.json`, and package `tsconfig.json` files.

- [ ] Create the root workspace with Yarn 4.10.3, Node 24.18.0, ESM, strict TypeScript, and scripts:

```json
{
  "name": "launchpad",
  "private": true,
  "packageManager": "yarn@4.10.3",
  "engines": { "node": ">=24.18.0 <25" },
  "scripts": {
    "build": "yarn workspaces foreach -A -t run build",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint .",
    "typecheck": "tsc -b",
    "validate": "yarn platform validate",
    "plan": "yarn platform plan",
    "status": "yarn platform status",
    "platform": "yarn workspace @launchpad/cli launchpad"
  },
  "devDependencies": {
    "@types/node": "^22.15.0",
    "eslint": "^9.24.0",
    "typescript": "^5.8.3",
    "vitest": "^3.1.1"
  }
}
```

- [ ] Configure `.yarnrc.yml` with `nodeLinker: node-modules`, `enableImmutableInstalls: true`, and the Yarn release pin.
- [ ] Add package manifests for each workspace with explicit `name`, `type: module`, `exports`, `main`, `types`, and `build`, `test`, `typecheck`, and `lint` scripts.
- [ ] Add strict compiler options: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `verbatimModuleSyntax`, `isolatedModules`, `moduleResolution: Bundler`, and declaration output.
- [ ] Add ESLint flat config enforcing no floating promises, explicit return types for exported functions, no empty catches, and no unsafe `any` in production packages.
- [ ] Add `.gitignore` entries for `.env*` except `.env.example`, `.wrangler`, `dist`, `coverage`, `.yarn/install-state.gz`, and local databases; preserve `yarn.lock`.
- [ ] Add `wrangler.jsonc` with Worker entrypoint, D1 binding `DB`, queues `PROVIDER_EVENTS` and `HEALTH_CHECKS`, queue `DEAD_LETTER`, workflow bindings, and `ASSETS` binding. Keep resource IDs in environment-specific deployment configuration, not source files.
- [ ] Run `corepack enable && yarn install --immutable`, then `yarn typecheck`, `yarn test`, and `yarn build`; all succeed before domain code is added.
- [ ] Commit as `build: scaffold Launchpad workspace`.

## Task 2: Implement shared primitives and provider-neutral domain types

**Files:** `packages/shared/src/*`, `packages/core/src/*`, and tests under `tests/unit/shared` and `tests/unit/core`.

- [ ] Write tests for stable SHA-256 hashing of canonical JSON, deterministic IDs from namespace/input, bounded retry classification, `SensitiveValue` serialization failure, redaction fingerprints, status separation, and typed error serialization.
- [ ] Implement `canonicalJson(value)` with sorted object keys, preserved array order, normalized dates, and rejection of `undefined`, functions, symbols, NaN, and infinities.
- [ ] Implement `sha256Hex`, `stableId(namespace, ...parts)`, `idempotencyKey(operation, sourceCommit, desiredGeneration)`, and a seeded `Clock` interface.
- [ ] Implement `SensitiveValue<T>` with private storage, `fingerprint()`, `redacted()`, `reveal()` restricted to provider-boundary code, and a throwing `toJSON()`; add `redactValue` for nested structures.
- [ ] Define domain models matching the master plan: `DesiredApplication`, `ObservedApplication`, `PlatformPlan`, `PlannedOperation`, `DownstreamEffect`, `PolicyResult`, `ResourceRecord`, `DeploymentRecord`, `HealthSummary`, `LifecycleSpec`, and provider-neutral environment/domain/secret types.
- [ ] Define status enums separately for sync (`SYNCED`, `OUT_OF_SYNC`, `RECONCILING`, `BLOCKED`, `UNKNOWN`, `DECOMMISSIONING`), health, deployment, workflow, and operation.
- [ ] Define `PlatformError` with error class, stable code, provider, operation ID, retryable flag, remediation, safe details, and cause fingerprint; implement constructors for validation, provider, conflict, stale-plan, build, health, policy, and internal errors.
- [ ] Ensure `packages/core` imports only shared primitives and platform types, never provider SDK/runtime modules.
- [ ] Run focused tests and `yarn typecheck`; commit as `feat: add Launchpad domain primitives`.

## Task 3: Implement strict catalog loading, schemas, and semantic validation

**Files:** `schema/*`, `catalog/*`, fixture manifests, and catalog tests.

- [ ] Write failing tests for unknown fields, missing identity, invalid hostname, invalid secret value, invalid lifecycle transition, duplicate application ID, duplicate Vercel project, duplicate domain, missing dependency, dependency cycle, missing zone reference, source-location errors, and canonical output stability.
- [ ] Define `app.schema.json` with `additionalProperties: false` at every object boundary, `apiVersion: launchpad.dev/v1`, `kind: Application`, repository, Vercel project/build/git/deployment/protection/settings, environment, domain, secret-reference, dependency, policy, and lifecycle shapes.
- [ ] Define `defaults.schema.json` and a `SchemaVersion` registry with migration functions that explicitly reject unsupported versions; no silent rewriting.
- [ ] Implement YAML loading with `yaml` document CST/source positions. Load application files in lexical path order, reject aliases/anchors unless the canonical loader resolves them unambiguously, and attach file/line/column/path to every validation issue.
- [ ] Implement defaults for preview/staging/production, DNS-only mode, protected destructive changes, open-PR drift, required preview/health gates, bounded retry values, and lifecycle deletion protection.
- [ ] Implement semantic validation across files: global ID/project/domain uniqueness, environment ownership, canonical production domain count, dependency existence/acyclicity, zone references, owner format, redirect conflicts, immutable IDs, and lifecycle transition legality.
- [ ] Implement `loadCatalog(root, source)` returning `{ applications, canonical, sourceMap, issues }`; `validateCatalog` must return nonzero CLI status for any error and must never log secret values.
- [ ] Add a valid fixture matching the manifest in the master plan and invalid fixtures for every negative case.
- [ ] Run `yarn test tests/unit/catalog` and `yarn platform validate --catalog tests/fixtures/catalog`; commit as `feat: implement catalog validation`.

## Task 4: Implement provider contracts, fake providers, and real adapters

**Files:** `packages/provider-contract/*`, `packages/provider-testkit/*`, all provider packages, and contract tests.

- [ ] Write contract tests that every provider must pass for capabilities, not-found, auth, forbidden, rate limit, transient 5xx, malformed response, ownership conflict, timeout, retry, and postcondition observation.
- [ ] Define `ProviderContext`, `ProjectProvider`, `SourceProvider`, `DnsProvider`, `SecretProvider`, `MutationResult`, `ProviderCapabilities`, `ObservedResource`, `DeploymentRequest`, `PromotionRequest`, `RollbackRequest`, and `RequiredDnsRecord` exactly in provider-neutral types.
- [ ] Implement a shared `ProviderHttpClient` with request timeout via `AbortController`, correlation/idempotency headers, bounded retry on 408/425/429/5xx, `Retry-After` handling, JSON content-type validation, response-size cap, and typed error translation.
- [ ] Implement the fake provider with in-memory project/domain/DNS/deployment state, configurable failures, delayed consistency, build errors, health failures, manual drift, and call recording. Ensure idempotent repeated writes return the same provider resource.
- [ ] Implement GitHub adapter methods for repository metadata, branch/ref resolution, path existence/type, access checks, PR comments, deployments/statuses, branches, and PR creation/update using the REST API and fine-grained token scopes.
- [ ] Implement Vercel adapter methods for team/project observation, project settings, Git connection, environment variables, custom environment, project domains, required DNS records, deployment creation/status/logs, domain verification/TLS, promotion, and rollback. Every write must follow with an observed postcondition read.
- [ ] Implement Cloudflare adapter methods for zone lookup, authoritative nameserver discovery, DNS record observation/ensure/delete with ownership fingerprints, and authoritative DNS verification. Refuse conflicting unowned records.
- [ ] Implement secret adapters for environment-bound secrets and provider references. Resolved values stay `SensitiveValue`; only fingerprints and redacted metadata cross persistence/reporting boundaries.
- [ ] Add response fixtures for successful, missing, forbidden, rate-limited, malformed, and changed-shape responses; test no raw response body or token appears in thrown errors.
- [ ] Run provider contract tests with fake adapters and compile real adapters; commit as `feat: add provider contracts and adapters`.

## Task 5: Implement resource graph, diff, downstream effects, policy, and deterministic plans

**Files:** `packages/core/src/graph.ts`, `diff.ts`, `policy.ts`, `plan.ts`, `render.ts`, and core tests.

- [ ] Write failing tests for create/no-op/update/redeploy/recreate-preview/promote/reconcile/decommission/destroy/blocked classifications, ownership ambiguity, provider-computed fields, field capability behavior, stable operation IDs, and deterministic ordering independent of provider response order.
- [ ] Implement graph nodes for GitHub repository/access, Vercel project/Git/settings/environments/secrets/domains, Cloudflare DNS, domain verification, candidate deployment, candidate health, promotion, production health, and known-good tracking.
- [ ] Implement matching by tracked provider ID first; use discovery keys only for import/recovery and emit `BLOCKED` for ambiguity or unowned conflicts.
- [ ] Implement field-level diff with capability metadata. Root/framework/commands/Node/env changes create downstream redeployment effects; DNS changes do not trigger unnecessary redeployment; unsupported requested fields block.
- [ ] Implement policy rules: normal apply rejects any `DESTROY`; missing manifest maps to `BLOCKED_MISSING_MANIFEST`; production-only secrets cannot enter preview; proxy mode requires acknowledgment; staging/health/preview requirements are enforced; lifecycle transitions are explicit.
- [ ] Implement topological operation ordering by dependency depth, provider, resource type, resource key. Generate stable operation IDs and idempotency keys from canonical inputs.
- [ ] Implement `PlatformPlan` fingerprint from canonical desired state, source commit, schema version, adapter/capability hashes, observed-state hash, graph, operations, and policy results. Exclude timestamps from fingerprint.
- [ ] Implement redacted JSON and Markdown renderers including summary, change table, downstream effects, policy blocks, fingerprint, source commit, and provider links without secrets or unescaped untrusted text.
- [ ] Add tests proving equivalent inputs produce byte-equivalent plan JSON and a stale observed-state hash blocks apply.
- [ ] Run `yarn test tests/unit/core` and CLI snapshot tests; commit as `feat: add deterministic Launchpad planner`.

## Task 6: Implement health checks and preview cleanup

**Files:** `packages/health/*`, `workflows/src/preview-app.ts`, provider Vercel log parser, cleanup persistence, and health tests.

- [ ] Write tests for DNS resolution failure, TLS failure/minimum certificate days, status mismatch, redirect policy, JSONPath equality, body regex/string, latency threshold, header/body handling, timeout, retry exhaustion, and secret-header redaction.
- [ ] Implement `HealthCheckSpec`, `HealthCheckRecord`, assertion results, and a checker using `fetch` with bounded timeout, redirect policy, TLS validation where runtime supports it, status/body/header assertions, and dependency checks.
- [ ] Implement jittered exponential backoff and distinguish `FAILED` assertions from `ERROR` transport/runtime failures.
- [ ] Implement shadow project naming tied to repository ID, PR number, application ID, and revision; attach ownership metadata; store cleanup jobs with TTL and attempt state.
- [ ] Implement preview workflow: create shadow project, apply proposed settings/env allowlist, create exact-commit deployment, poll only until READY/ERROR/CANCELED/timeout, parse bounded redacted log excerpts, run preview health, and report terminal result.
- [ ] Implement supersession/close cleanup and an orphan sweep that lists owned shadow projects, deletes expired resources, records failure, and never hides cleanup errors.
- [ ] Run preview and health tests using fake Vercel provider and a local HTTP fixture; commit as `feat: add preview and health verification`.

## Task 7: Implement D1 schema, repositories, locks, and durable operation storage

**Files:** `migrations/d1/*`, `packages/database/*`, database tests.

- [ ] Write SQL migration tests that create a clean database, apply migrations forward-only, enforce foreign keys/uniqueness/check constraints, and reject secret-value columns by repository API.
- [ ] Create tables for applications, resources, ownership, desired generations, observations, plans, plan operations, workflow runs/steps, deployments/promotions, health checks, drift/reconciliation, provider errors, webhooks, cleanup jobs, tombstones, audit events, credentials metadata, and idempotency keys.
- [ ] Add indexes for application/status, provider resource ID, active locks, open reconciliation fingerprint, workflow status, and deployment environment/current state.
- [ ] Implement typed repositories for application snapshots, observations, plans, operations, workflow steps, deployments, health checks, drift, cleanup, tombstones, audit, webhook receipts, and credential metadata.
- [ ] Implement application/domain locks with owner, lease expiration, renewal, conflict, and safe release. Enforce one known-good current production deployment and one open reconciliation per fingerprint.
- [ ] Implement idempotency repository returning the original operation for duplicate keys and rejecting same key with incompatible payload hash.
- [ ] Implement append-only audit insertion and prohibit update/delete methods for audit records.
- [ ] Provide `D1DatabaseLike` interface plus SQLite test implementation so repository tests do not require Cloudflare.
- [ ] Run migrations and persistence tests; commit as `feat: add durable D1 persistence`.

## Task 8: Implement durable workflows and controller authentication/API

**Files:** `workflows/src/*`, `apps/controller/src/*`, `packages/database`, controller tests, `wrangler.jsonc`.

- [ ] Write tests for step resume after interruption, completed-step skip, retryable failure, permanent failure, lock release, idempotency, stale plan, and failed-release/rollback-success state.
- [ ] Implement `OperationRunner` with persisted step records, deterministic step IDs, attempt counts, retry class, timeout, lock ownership, and terminal aggregation. A resumed run must skip completed steps only when the precondition hash matches.
- [ ] Implement apply workflow steps in the master-plan order: validation, locking, project/Git/settings/environments/secrets/domains/DNS, verification, candidate, candidate health, exact promotion, production health, known-good, final summary, release lock.
- [ ] Implement promote/rollback workflows with candidate identity checks for project/environment/repository/commit/generation, lock checks, no-newer-candidate checks, production domain health, and explicit `FAILED` plus `ROLLBACK_SUCCEEDED` reporting.
- [ ] Implement decommission workflow with token, cooling-off, dependency, final export, DNS/proxy/domain/environment/project teardown order, inactive deployments, tombstone, and audit record.
- [ ] Implement GitHub OIDC verification with `jose`/Web Crypto: issuer, audience, expiration, repository/owner IDs, workflow ref, event, PR/commit binding, application allowlist, and replay protection.
- [ ] Implement Vercel webhook signature verification, event deduplication persistence before enqueue, queue dispatch, and follow-up provider read.
- [ ] Implement Hono Worker routes for workflow-authenticated plan/apply/preview/health/rollback endpoints and authenticated dashboard reads/actions. Mutations require idempotency keys and return workflow IDs.
- [ ] Implement queue consumers for provider events and health work, with bounded retries and dead-letter persistence/reporting.
- [ ] Run controller tests using signed test tokens, replay attempts, fake provider, and SQLite D1 implementation; commit as `feat: add durable controller workflows`.

## Task 9: Implement CLI, GitHub reporting, and required workflows

**Files:** `apps/cli/*`, GitHub reporting package if needed, `.github/*`, workflow tests.

- [ ] Write CLI tests for command parsing, validation exit codes, redacted plan output, app filtering, JSON/Markdown output, local apply denial, and status formatting.
- [ ] Implement `launchpad validate`, `plan`, `status`, `graph`, `health`, `reconcile --dry-run`, and `logs --latest`; default to fixture/local providers when no runtime provider credentials are present.
- [ ] Implement sticky PR comment rendering/upsert with a hidden marker, revision/fingerprint, plan table, downstream effects, preview URL/state, health result, failure details, and escaped provider text.
- [ ] Implement artifact writers for `plan.json`, `plan.md`, `resource-graph.json`, `resource-graph.dot`, `provider-state-redacted.json`, `preview-summary.json`, `health-results.json`, and bounded `build-log-tail.txt`.
- [ ] Add `.github/CODEOWNERS` protecting all platform code, catalog, schema, workflows, controller, and CODEOWNERS itself; add pull-request template with requirement IDs, security/migration/test/failure evidence.
- [ ] Add `validate-plan.yml` with `permissions: {}`, fork-safe validation, schema/catalog/preflight/plan/preview/health/summary jobs, per-PR concurrency cancellation, `if: always()` summary, artifacts, and required failure propagation.
- [ ] Add `apply.yml` triggered only by protected main merge; verify merge provenance, revalidate/replan, compare fingerprint, authenticate OIDC, start/poll durable apply, and publish summary.
- [ ] Add `reconcile.yml`, `destroy.yml`, `deploy-control-plane.yml`, and `reusable-app-preview.yml` with immutable action SHAs, least permissions, strict shell settings, and no production secrets in fork jobs.
- [ ] Run workflow YAML/schema tests and CLI tests; commit as `feat: add CLI and GitHub automation`.

## Task 10: Implement production apply, DNS/domain verification, promotion, and rollback integration

**Files:** provider adapters, apply/promote/rollback workflows, deployment repositories, integration tests, operational summary renderers.

- [ ] Write integration tests with fake providers for create project, Git connection, settings/env reconciliation, Vercel domain, Cloudflare DNS, authoritative verification, TLS readiness, staged candidate, candidate health, exact promotion, post-promotion health, known-good, and rollback.
- [ ] Implement environment strategy selection: custom environment when capability/plan supports it, separate staging project fallback, and explicit failure when neither is available.
- [ ] Implement required-DNS lookup from Vercel response rather than a hardcoded target; create/update only owned Cloudflare records and block unowned conflicts.
- [ ] Implement authoritative DNS polling with nameserver discovery, bounded exponential backoff/jitter, and separate DNS/Vercel verification/TLS statuses.
- [ ] Implement candidate creation bound to project, environment, repository, exact commit SHA, desired generation, and plan fingerprint. Reject identity mismatch immediately before promotion.
- [ ] Implement production domain assignment/promotion without rebuilding when the configured staged-production capability exists; otherwise fail closed rather than silently use a rebuild path.
- [ ] Implement post-promotion health and configured runtime observation window. On failure, reassign the previous known-good deployment, verify restoration, mark the release failed, and preserve rollback outcome separately.
- [ ] Implement GitHub Deployment status mapping (`queued`, `in_progress`, `success`, `failure`, `error`, `inactive`) and final Actions summary including sync, health, deployment, domains, and recovery.
- [ ] Run the full release/rollback integration fixture and assert production remains on the prior deployment before promotion; commit as `feat: add safe release promotion and rollback`.

## Task 11: Implement drift detection, reconciliation PRs, safe deletion, and dashboard

**Files:** `workflows/src/reconcile-app.ts`, `decommission-app.ts`, `apps/dashboard/*`, Worker dashboard routes, GitHub PR writer, tests.

- [ ] Write tests for manual Vercel root drift, Cloudflare record drift, untracked resource, ownership conflict, secret fingerprint change, access loss, provider unreadable state, stable fingerprints, PR deduplication, restore mode, adopt mode, and missing-manifest block.
- [ ] Implement scheduled reconciliation from protected main: read catalog, tracked resources, provider state; compute stable drift fingerprint; update dashboard status immediately; enqueue/update exactly one PR per application/fingerprint.
- [ ] Implement reconciliation PR branch/request generation with desired generation, observed timestamp, reason, operation, drift fingerprint, plan artifacts, and restore/adopt instructions. Provider read failure maps to `UNKNOWN`/`BLOCKED`, never `SYNCED`.
- [ ] Implement adopt mode to generate reviewed manifest edits from observed state, excluding provider-computed fields, secrets, and unowned resources; restore mode keeps Git as-is and uses normal apply.
- [ ] Implement lifecycle transitions and deletion token service: decommissioning warning/impact report, cooling-off check, single-use token hash, dependent check, final export, ordered destroy, tombstone retention/reuse protection. Manifest disappearance remains `BLOCKED_MISSING_MANIFEST`.
- [ ] Implement dashboard API views for applications, resources, operations, deployments, health, drift, audit, credentials metadata, and workflow details. Add direct retry/recheck/cancel/rollback actions with operator auth/CSRF/audit; configuration actions create PR proposals.
- [ ] Implement dashboard SPA with application list/detail, sync/health/deployment badges, resource/operation/drift views, deployment/health history, failure remediation, and links to GitHub/provider artifacts. Do not display secret values.
- [ ] Run drift, deletion, dashboard API, and UI smoke tests; commit as `feat: add reconciliation deletion and dashboard`.

## Task 12: Add hardening, runbooks, security tests, and release gates

**Files:** `tests/*`, `docs/runbooks/*`, `docs/release-checklist.md`, `.github/workflows/*`, package configs.

- [ ] Add full fixture E2E test proving catalog PR → plan comment → shadow preview → merge → project/DNS → staging → candidate → promotion → health → drift → reconciliation PR → safe deletion.
- [ ] Add fault-injection tests for provider timeout/retry/DLQ, controller interruption/resume, stale-plan state change, lock conflict/expiry, malformed provider response, DNS conflict/propagation, failed build, failed candidate health, promotion identity mismatch, missing known-good rollback, and cleanup failure.
- [ ] Add secret-canary tests that inject unique sensitive values and assert they are absent from plan JSON/Markdown, PR comments, artifacts, log tails, summaries, errors, D1 rows, and dashboard responses.
- [ ] Add performance tests for 100-manifest validation within 60 seconds, parallel provider reads, deterministic rendering under reordered responses, and dashboard list cache behavior.
- [ ] Add runbooks for Vercel/Cloudflare/GitHub outages, credential rotation/revocation, D1 migration, stuck locks, cleanup backlog, DLQ, failed promotion/rollback, provider schema incompatibility, break-glass bypass, controller rollback, and secret-provider outage.
- [ ] Add `docs/release-checklist.md` covering code quality, safety, reliability, deployment correctness, reconciliation, operations, dedicated test resources, branch rules, CODEOWNERS, secret scanning, and rollback.
- [ ] Add dependency audit, action-SHA checks, workflow permission checks, no-secret fixture scan, and core dependency-boundary lint.
- [ ] Run `yarn lint`, `yarn typecheck`, `yarn test`, `yarn build`, local Worker smoke test, and all E2E/fault/security suites; commit as `test: harden Launchpad release gates`.

## Task 13: Final verification and repository review

**Files:** all implementation outputs; no functional code changes unless verification finds a real defect.

- [ ] Run `corepack enable && yarn install --immutable` from a clean workspace.
- [ ] Run `yarn typecheck`; fix every diagnostic without suppressions.
- [ ] Run `yarn lint`; fix every violation without disabling rules globally.
- [ ] Run `yarn test`; confirm all positive, negative, recovery, security, and E2E suites pass.
- [ ] Run `yarn build`; confirm all packages, CLI, Worker, and dashboard assets build.
- [ ] Run `yarn platform validate --catalog catalog`; confirm fixture catalog succeeds and invalid fixtures fail with source locations.
- [ ] Run `yarn platform plan --catalog catalog --format markdown`; confirm stable fingerprint, redaction, downstream effects, and no hidden writes.
- [ ] Run local Worker smoke tests for dashboard reads, OIDC rejection, webhook signature/replay rejection, idempotent apply, stale-plan block, and health/rollback action authorization.
- [ ] Inspect generated repository tree and verify each master-plan milestone has code, tests, workflow/configuration, and documentation coverage.
- [ ] Remove only generated build output and temporary local state. Do not remove user-created `.DS_Store` or unrelated files.
- [ ] Commit any verification fixes with narrow messages. Final review must report exact commands and observed results.

---

## Requirement coverage

- Catalog/configuration: Tasks 2–3.
- Plans/policies/downstream effects: Tasks 2 and 5.
- Real previews/health/cleanup: Task 6.
- Durable apply/release/promotion/rollback: Tasks 7–10.
- DNS/domain verification/proxy safety: Tasks 4, 6, and 10.
- Drift/reconciliation/adoption: Task 11.
- Status/failure visibility/dashboard: Tasks 8–11.
- Security/governance/secrets/OIDC/webhooks: Tasks 2, 4, 8–9, and 12.
- Safe deletion/tombstones: Task 11.
- Tests/runbooks/release readiness: Tasks 4, 6–13.
