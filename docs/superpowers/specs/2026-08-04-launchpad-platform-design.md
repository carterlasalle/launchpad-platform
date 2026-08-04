# Launchpad Platform Design

**Date:** 2026-08-04  
**Status:** Approved implementation baseline  
**Governing specification:** [`docs/Launchpad_Unified_GitOps_Master_Plan.md`](../../Launchpad_Unified_GitOps_Master_Plan.md)

## Problem

The repository has the Launchpad 1.0 product and engineering baseline but no implementation. The platform must turn Git-defined application manifests into reviewable plans, safe provider mutations, verified releases, durable status, drift reconciliation, and protected decommissioning without making D1 an alternative desired-state store.

## Scope

Build the complete production-capable monorepo described by the master plan:

- Strict catalog/schema loading and semantic validation.
- Provider-neutral desired/observed models, resource graph, diff, downstream effects, policy, deterministic plans, and typed errors.
- Real fetch-based GitHub, Vercel, Cloudflare DNS, and secret-provider adapters behind versioned contracts.
- Deterministic fake providers and local persistence for offline unit, integration, and end-to-end tests.
- Shadow previews, health checks, cleanup, durable apply/reconcile/promote/rollback/decommission operations.
- Cloudflare Worker API, D1 repositories/migrations, OIDC/webhook verification, queue/DLQ boundaries, and dashboard endpoints.
- CLI commands, GitHub Actions workflows, reusable application preview workflow, CODEOWNERS/ruleset configuration, runbooks, and release gates.

Live provider mutation is enabled only through explicit runtime credentials and target configuration. Tests never require live credentials.

## Options considered

### Live-provider-first

Implement mutations against provider APIs immediately. This produces an early real demo but makes safety and failure-path verification dependent on external accounts, credentials, quotas, and network behavior.

### Contract-first with local fixtures and live adapters (selected)

Implement all provider-neutral behavior and workflow transitions against deterministic contracts and fake providers, while also implementing real fetch-based adapters with explicit credential/configuration requirements. This gives production code a real path and makes every safety invariant repeatable offline.

### Minimal vertical slice

Implement catalog → plan → one Vercel deployment first. This would provide a demo sooner but would leave lifecycle, drift, rollback, persistence, and security behavior as unproven architectural debt and would not satisfy Launchpad 1.0.

## Architecture

```text
catalog + schema
      ↓
catalog loader → semantic validation → canonical desired state
      ↓
provider-neutral core
  resource graph → diff → downstream effects → policy → deterministic plan
      ↓
provider contracts
  GitHub adapter | Vercel adapter | Cloudflare adapter | secret adapter
      ↓
execution layer
  preview | apply | reconcile | promote | rollback | decommission
      ↓
persistence + control plane
  D1 repositories | durable workflow state | locks | queues | audit events
      ↓
interfaces
  CLI | GitHub Actions | Worker API | dashboard
```

### Packages and applications

- `packages/core`: provider-neutral domain models, canonicalization, redaction, graph, diff, policy, status, and errors. It MUST NOT import provider SDK or runtime types.
- `packages/catalog`: YAML parsing with source locations, strict schema validation, defaults, cross-file checks, dependency cycles, lifecycle transitions, and canonical output.
- `packages/provider-contract`: versioned interfaces, capability matrices, provider errors, and mutation postconditions.
- `packages/provider-github`, `packages/provider-vercel`, `packages/provider-cloudflare`, `packages/provider-secrets`: REST/fetch adapters with typed translation, bounded retries, capability discovery, and postcondition reads.
- `packages/health`: DNS/TLS/HTTP checks, assertions, retry/backoff, and health records.
- `packages/database`: D1-compatible migrations, repositories, locks, idempotency, operation history, and audit events.
- `apps/cli`: local diagnostics and plan/status/graph/health/reconcile/log commands. Local apply is disabled unless sandbox mode is explicitly enabled.
- `apps/controller`: Cloudflare Worker routes, OIDC and webhook verification, durable operation orchestration, queue consumers, and failure reporting.
- `apps/dashboard`: independent status interface served by the control plane; configuration changes create PR proposals, while retry/recheck/rollback are audited operational actions.
- `workflows`: apply, preview, reconcile, promotion, rollback, and decommission implementations shared by the Worker and test harness.
- `.github/workflows`: required catalog PR checks, merged-main apply, reconciliation, destroy, controller deployment, and reusable application preview gate.

## State and data flow

1. Load manifests in lexical path order.
2. Resolve defaults and preserve source locations.
3. Validate schema and cross-file semantics.
4. Canonicalize desired state and hash it.
5. Read provider state through adapters; classify inaccessible, forbidden, missing, rate-limited, malformed, transient, and unsupported results distinctly.
6. Build the resource DAG from desired state, observed state, ownership mappings, capability data, and policy.
7. Generate a deterministic plan with stable operation IDs, idempotency keys, downstream invalidations, and redacted values.
8. For catalog PRs, provision an isolated shadow project, deploy the exact proposed revision, check health, update one sticky PR comment, and enqueue cleanup.
9. For merged main, revalidate the commit and live state, reject stale/destructive plans, start a durable apply, and persist each step boundary.
10. Apply provider mutations in dependency order, verify postconditions, stage a candidate, check it, promote the exact deployment, check the production domain, and record known-good only after successful post-promotion health.
11. Reconcile on a schedule from protected main; update status immediately and open or update one restore/adopt PR per stable drift fingerprint.
12. Decommission only through explicit lifecycle state, cooling-off period, single-use approval token, final export, ordered teardown, and tombstone creation.

## Safety invariants

- Git is the only desired-state source.
- No secret value is serialized to plans, logs, artifacts, comments, or D1.
- Normal apply rejects `DESTROY` before the first write.
- Provider ownership ambiguity and unreadable state fail closed.
- Every mutation is idempotent and verifies the observed postcondition.
- Production remains on the previous deployment until candidate health passes.
- A rollback can restore availability but cannot turn the failed release green.
- Direct dashboard configuration changes generate PRs.
- Provider credentials are runtime-only and separated by provider/purpose.
- Fork PRs run without production credentials.
- OIDC and webhook requests are signature/replay verified and bound to expected repository, workflow, commit, audience, and application.

## Error and recovery model

`PlatformError` carries a stable code, class, remediation, provider, operation ID, retryability, safe details, and cause fingerprint. Durable steps record start, attempts, result, and error. Transient provider failures, rate limits, propagation, certificate delays, and timeouts retry with bounded jitter; permanent validation, build, policy, ownership, and assertion failures stop. Exhausted queue work is visible through a dead-letter path and incident/issue reporting.

The apply state machine is:

```text
QUEUED → VALIDATING → LOCKING → ENSURING_PROJECT → ENSURING_GIT
→ ENSURING_SETTINGS → ENSURING_ENVIRONMENTS → ENSURING_SECRETS
→ ENSURING_DOMAINS → ENSURING_DNS → VERIFYING_DOMAIN
→ BUILDING_CANDIDATE → CHECKING_CANDIDATE → PROMOTING
→ CHECKING_PRODUCTION → RECORDING_KNOWN_GOOD → SUCCEEDED
```

Any eligible state may become `RETRYING`, `BLOCKED`, `FAILED`, or `ROLLING_BACK`. Preview, reconcile, and decommission workflows use the same persisted operation/step primitives.

## Provider strategy

Core interfaces accept domain types only. Adapters use `fetch`, explicit API-version/configuration checks, response-shape validation, and follow-up observation after every mutation. Provider capabilities classify fields as readable, creatable, updatable, deletable, redeploy-sensitive, and destructive. Unsupported or unknown fields block planning rather than being ignored.

The local fake provider implements the same contracts, including eventual-consistency delays, provider failures, build errors, health failures, drift, and rollback scenarios. Test fixtures can therefore prove the full lifecycle without external accounts.

## Dashboard strategy

The dashboard is a control-plane client, not a second source of truth. It presents application list/detail, resource graph, operations, deployments, health, drift/reconciliation, audit, and credential metadata. Status dimensions stay separate: sync, health, deployment, and latest operation. Configuration actions create PR proposals; retry, recheck, cancel, and rollback call audited operational endpoints.

## Verification

- Unit tests cover canonicalization, source locations, schema/semantic failures, graph ordering, diff classification, downstream effects, policy blocks, redaction, error mapping, lifecycle transitions, retry classes, and fingerprint stability.
- Provider contract tests cover not-found, auth, forbidden, rate-limit, malformed response, changed API shape, duplicate ownership, timeout, and idempotent retry.
- Integration tests use fake providers and a D1-compatible repository.
- Fault-injection tests cover stale plans, controller interruption/resume, partial apply, DNS delay/conflict, build failure, health failure, promotion identity mismatch, rollback, drift, cleanup failure, and DLQ routing.
- Secret-canary tests scan generated plans, comments, artifacts, logs, summaries, and persistence payloads.
- One fixture proves add/update/failed-preview/promotion/rollback/drift/reconciliation/safe-delete end to end.

## Delivery sequence

1. Scaffold the Yarn/TypeScript monorepo and protected-path configuration.
2. Implement catalog/schema/domain models and validation.
3. Implement provider contracts, fake providers, and real adapters.
4. Implement graph/diff/policy/plan and deterministic renderers.
5. Add GitHub reporting and required workflows.
6. Add preview, health, cleanup, and reusable app gate.
7. Add D1 persistence, locks, Worker API, OIDC, queues, and durable workflows.
8. Add production apply, DNS/domain verification, staging, promotion, known-good registry, and rollback.
9. Add drift/reconciliation, safe deletion, dashboard, operations, runbooks, and release gates.
10. Run full verification with local fixtures; live verification is an explicit post-credential rollout step.

## Explicit non-goals

Terraform, OpenTofu, a custom GitHub App, Kubernetes/EKS/ECS/ECR, arbitrary container execution, hidden D1 desired state, plaintext secrets, silent destructive apply, and unchecked dashboard mutations remain excluded as required by the master plan.
