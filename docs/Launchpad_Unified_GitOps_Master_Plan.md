# Launchpad: Unified GitOps Platform

## Product Requirements, Technical Requirements, Engineering Specifications, Implementation Plan, and Verbatim Platform Specification

**Document status:** Implementation-ready design baseline  
**Integrated product release:** Launchpad 1.0  
**Prepared:** August 4, 2026  
**Primary stack:** TypeScript, Node.js, Yarn, GitHub Actions, Cloudflare Workers, Cloudflare Workflows, Cloudflare D1, Vercel, and Cloudflare DNS  
**Explicitly excluded:** Terraform, OpenTofu, and a custom GitHub App

---

# Document Control

## Purpose

This document is the complete product and engineering baseline for Launchpad, a Git-driven internal developer platform that provisions, configures, verifies, deploys, reconciles, and safely decommissions Vercel applications with Cloudflare-managed domains.

It combines the capabilities previously described as Version 1, Version 1.5, Version 2, and later extensions into one integrated product definition. The implementation may be delivered through gated milestones, but the target product is a single coherent platform rather than a collection of disconnected scripts.

## Document organization

1. Product Requirements Document
2. Technical Requirements Specification
3. Detailed Engineering Specifications
4. Implementation and Pull Request Plan
5. Verification, Rollout, and Operational Readiness
6. Requirements Traceability Matrix
7. Source Notes
8. Unified GitOps Platform Specification — reproduced verbatim

## Normative language

The words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**, and **MAY** are used as requirements language.

- **MUST / REQUIRED:** mandatory for Launchpad 1.0 acceptance.
- **SHOULD:** expected unless a documented technical constraint prevents it.
- **MAY:** optional or deferred without violating the core contract.

## Governing principles

- Git is the desired-state source of truth.
- Pull requests are the only normal path to production configuration changes.
- Every proposed change is validated against real provider state before merge.
- Every catalog PR gets a real Vercel preview that exercises the proposed settings.
- Production uses verified staged builds and promotion rather than blind rebuilding.
- Destructive operations are separated from ordinary apply operations.
- Drift is detected continuously and resolved through reviewable reconciliation PRs.
- Failures are visible, typed, durable, and loud.
- Provider-specific details remain behind modular interfaces.
- The platform must be useful on day one and extensible without a rewrite.

---

# Part I — Product Requirements Document

## 1. Product summary

Launchpad is a lightweight GitOps control plane for developers who want the safety and workflow of a mature platform engineering stack without operating Kubernetes, ECR, EKS, Helm, or Argo CD.

A developer declares an application and its deployment configuration in a YAML manifest. Launchpad validates the declaration, compares it with live GitHub, Vercel, and Cloudflare state, creates a reviewable plan, builds a real preview, and then automatically applies the approved state after merge. A persistent controller tracks long-running provider operations, verifies DNS and health, promotes a tested deployment, detects drift, and opens reconciliation pull requests.

The expected user experience is intentionally small:

```text
Create or edit an application manifest
        ↓
Open a pull request
        ↓
Review exact diff, downstream effects, and live preview
        ↓
Receive CODEOWNER approval
        ↓
Merge
        ↓
Launchpad applies, verifies, deploys, promotes, and reports
```

## 2. Problem statement

Simple application hosting becomes fragmented as soon as a developer operates several repositories and domains:

- Vercel projects are created manually and configured inconsistently.
- Root directories, framework presets, build commands, branches, and environment variables drift between dashboard settings and repository assumptions.
- Cloudflare DNS is changed separately from Vercel domain configuration.
- A green local build can fail in Vercel because the cloud build environment differs.
- Provider failures can remain hidden inside dashboards or incomplete scripts.
- Production deployments can be promoted before health is verified.
- Manual changes are difficult to audit and easy to forget.
- Deleting a YAML entry can accidentally become a destructive operation.
- There is no unified view of sync state, health, deployment state, or ownership.

Enterprise platforms solve these problems with infrastructure-as-code, deployment controllers, policy engines, registries, clusters, and GitOps reconciliers. That stack is too heavy for this use case. Launchpad preserves the useful operating model while relying on managed Vercel and Cloudflare services.

## 3. Product vision

Launchpad should feel like a compact internal platform:

- A catalog entry behaves like an Argo CD application declaration.
- A pull-request plan behaves like an infrastructure plan.
- A Vercel preview behaves like an ephemeral environment.
- A staged production deployment behaves like a release candidate.
- Promotion behaves like moving an immutable artifact into production.
- The controller behaves like a reconciliation loop.
- Cloudflare DNS behaves like managed ingress configuration.
- The dashboard behaves like a small Argo CD application view.

The platform must preserve this mental model without pretending Vercel is Kubernetes. There are no pods, schedulers, container registries, or service meshes in the core product.

## 4. Goals

### 4.1 Primary goals

- Provision a Vercel project from a GitHub repository declaration.
- Manage Vercel project settings declaratively, including framework and root directory.
- Manage Vercel environments, environment variables, domains, and deployment policies.
- Create and reconcile Cloudflare DNS records.
- Validate GitHub repository existence, access, branches, roots, and Vercel Git access.
- Generate exact plans and downstream-impact explanations on pull requests.
- Build a real shadow preview for catalog configuration changes.
- Surface Vercel build failures and relevant logs in GitHub.
- Prevent merge unless required checks and CODEOWNER approval succeed.
- Automatically apply merged configuration without manual plan/apply commands.
- Wait for DNS, Vercel domain verification, certificate readiness, and application health.
- Promote a verified production candidate instead of blindly rebuilding.
- Roll back to the previous known-good deployment when configured health gates fail.
- Continuously detect drift and open reviewable reconciliation PRs.
- Track provider resources, operations, retries, deployments, health, and audit events.
- Provide a status dashboard independent of the managed Vercel projects.
- Refuse normal destructive changes and require a deliberate decommissioning workflow.
- Keep provider integrations modular for future targets.

### 4.2 Secondary goals

- Provide a reusable application-repository preview gate.
- Make onboarding a repository possible through an automated PR.
- Support DNS-only and explicitly opted-in Cloudflare proxy modes.
- Permit adoption of intentional manual changes through Git.
- Support direct operational recovery actions such as retry, recheck, and rollback with audit records.
- Produce machine-readable artifacts for debugging and future integrations.

## 5. Non-goals

Launchpad 1.0 will not:

- Run arbitrary containers or replace a container orchestrator.
- Provide a general-purpose cloud resource language.
- Manage Kubernetes, EKS, ECS, or ECR in the core release.
- Replace Vercel’s build infrastructure.
- Replace GitHub’s native pull-request review system.
- Implement a custom GitHub App.
- Store plaintext application secrets in Git, logs, comments, artifacts, or D1.
- Automatically overwrite every detected manual production change without review.
- Treat removal of a manifest as authorization to delete resources.
- Claim a deployment is healthy merely because Vercel reports the build as READY.

## 6. Users and personas

### 6.1 Platform owner

The platform owner maintains Launchpad, approves sensitive catalog changes, owns provider credentials, reviews policy changes, and responds to controller failures.

Needs:

- Strong safeguards against accidental deletion.
- Complete audit history.
- Typed failures and provider response visibility.
- Modular code and testable provider contracts.
- A dashboard for all applications.
- Controlled bypass and recovery mechanisms.

### 6.2 Application owner

An application owner maintains one or more application repositories and their catalog manifests.

Needs:

- A simple manifest rather than repeated dashboard configuration.
- Clear preview links and failure reasons.
- Confidence that production receives the exact validated code and settings.
- Easy environment, domain, root-directory, and framework changes.
- Visible health and deployment status.

### 6.3 Reviewer / CODEOWNER

A reviewer validates changes to infrastructure behavior and production routing.

Needs:

- A human-readable plan.
- Downstream effects, not only raw field differences.
- Proof that the proposed Vercel configuration builds successfully.
- Explicit destructive-change classification.
- Stable plan fingerprints and stale-plan protection.

### 6.4 Operator

An operator handles incidents, failed applies, degraded health, and provider outages.

Needs:

- Durable workflow state.
- Step-level retries.
- Known-good deployment tracking.
- Direct rollback with an audit trail.
- Clear distinction between deployment failure and successful availability restoration.

## 7. Core user journeys

### 7.1 Add a new application

1. Add `catalog/apps/<application>.yaml`.
2. Open a PR.
3. Launchpad validates schema and catalog semantics.
4. Launchpad confirms repository access, branch existence, root path, and Vercel Git access.
5. Launchpad reads current Vercel and Cloudflare state.
6. Launchpad posts the resource plan and downstream effects.
7. Launchpad creates a shadow Vercel project and deploys the proposed configuration.
8. Launchpad posts preview status, URL, health result, and relevant errors.
9. CODEOWNER reviews and approves.
10. Merge triggers automatic apply.
11. The controller provisions resources, attaches domains, creates DNS, verifies readiness, stages production, runs health checks, promotes, and writes a final summary.

### 7.2 Change a Vercel root directory or framework

1. Edit the manifest.
2. PR plan shows the field change and every required redeployment.
3. Shadow preview uses the proposed root and framework.
4. A missing package manifest, incompatible build command, or framework failure blocks merge with logs.
5. Merge applies the setting and stages a fresh production candidate.
6. Existing production remains active until the candidate passes health checks and is promoted.

### 7.3 Application-code pull request

1. Open a PR in the application repository.
2. Vercel creates its native preview deployment.
3. Launchpad’s reusable workflow locates the deployment for the exact commit.
4. It waits for a terminal build state, retrieves relevant errors, and runs health checks.
5. GitHub shows a required workflow result, deployment status, preview URL, and sticky comment.
6. Merge remains blocked when the Vercel build or health check fails.

### 7.4 Detect and reconcile drift

1. A setting or DNS record is changed outside Git.
2. Scheduled reconciliation reads provider state.
3. The dashboard immediately shows `OUT_OF_SYNC`.
4. Launchpad opens or updates one reconciliation PR.
5. The PR offers either restore-desired-state or adopt-observed-state.
6. The normal plan, preview, review, and apply gates remain in force.

### 7.5 Safely delete an application

1. The owner changes lifecycle state to `decommissioning`.
2. Launchpad produces a dependency and impact report.
3. Promotion is disabled while existing service remains available.
4. A cooling-off period elapses.
5. A second PR supplies the exact deletion token and approval state.
6. CODEOWNER review and the destruction workflow perform ordered teardown.
7. D1 retains a tombstone and final audit record.

## 8. Product requirements

### 8.1 Catalog and configuration

- PRD-CAT-001: Each application MUST have a unique stable ID.
- PRD-CAT-002: The catalog MUST support GitHub repository, branches, framework, Vercel root directory, build commands, environments, domains, proxy policy, health checks, secret references, dependencies, drift policy, and lifecycle state.
- PRD-CAT-003: Unknown fields MUST fail validation.
- PRD-CAT-004: Duplicate application IDs, Vercel project names, and subdomains MUST block the PR.
- PRD-CAT-005: Dependency cycles MUST block the PR.
- PRD-CAT-006: Unsupported requested provider settings MUST block the PR rather than be ignored.

### 8.2 Pull-request planning

- PRD-PLAN-001: Every catalog PR MUST receive schema, catalog, preflight, plan, preview, and health checks.
- PRD-PLAN-002: The plan MUST show creates, updates, redeployments, promotions, reconciliations, decommissions, destroys, no-ops, and blocked operations.
- PRD-PLAN-003: The plan MUST explain downstream effects of each relevant setting change.
- PRD-PLAN-004: One sticky PR comment MUST be updated on each revision.
- PRD-PLAN-005: The plan MUST include a deterministic fingerprint.
- PRD-PLAN-006: Plans and artifacts MUST redact sensitive values.

### 8.3 Real previews

- PRD-PRV-001: A catalog PR that changes deployable settings MUST receive a real isolated Vercel preview.
- PRD-PRV-002: The preview MUST use the proposed root directory, framework, commands, runtime, and preview-safe environment values.
- PRD-PRV-003: Preview build failures MUST fail the GitHub workflow and appear in the PR comment.
- PRD-PRV-004: Preview health MUST be checked independently from build state.
- PRD-PRV-005: Superseded or closed PR preview resources MUST be cleaned up and cleanup failure MUST remain visible.

### 8.4 Apply and release

- PRD-APL-001: Merge to `main` MUST trigger automatic apply; users MUST NOT need to run plan or apply manually.
- PRD-APL-002: Apply MUST revalidate the merged SHA and live provider state.
- PRD-APL-003: Apply MUST stop when the approved plan is stale.
- PRD-APL-004: Apply MUST be durable and resumable at step boundaries.
- PRD-APL-005: Normal apply MUST refuse destructive operations.
- PRD-APL-006: Production MUST remain on the prior deployment until the staged candidate passes required checks.
- PRD-APL-007: Promotion MUST target the intended exact deployment and commit.
- PRD-APL-008: Post-promotion health failure MUST trigger configured rollback and still leave the original operation failed.

### 8.5 Domains and proxying

- PRD-DNS-001: Launchpad MUST ask Vercel for required domain records rather than assuming one permanent target.
- PRD-DNS-002: Launchpad MUST create or update owned Cloudflare records and verify authoritative DNS.
- PRD-DNS-003: Launchpad MUST wait for Vercel verification and TLS readiness.
- PRD-DNS-004: DNS-only MUST be the default Cloudflare mode.
- PRD-DNS-005: Proxied mode MUST require explicit acknowledgment and additional compatibility checks.

### 8.6 Drift and reconciliation

- PRD-REC-001: The controller MUST periodically compare desired and observed state.
- PRD-REC-002: Drift MUST update dashboard status immediately.
- PRD-REC-003: The default drift response MUST be a reconciliation PR, not silent mutation.
- PRD-REC-004: The PR MUST support restoring Git-defined state or adopting observed state.
- PRD-REC-005: Identical drift MUST update an existing reconciliation PR instead of opening duplicates.

### 8.7 Status and failure visibility

- PRD-STS-001: Sync, health, and deployment status MUST be represented separately.
- PRD-STS-002: Every failure MUST be recorded with a stable error code, human-readable explanation, operation, provider, and retry classification.
- PRD-STS-003: Permanent failure MUST appear in GitHub Actions, PR comments where applicable, deployment status, dashboard, controller logs, and operation history.
- PRD-STS-004: No workflow may report success after a failed required operation merely because fallback or rollback restored service.

### 8.8 Security and governance

- PRD-SEC-001: Direct pushes to `main` MUST be blocked.
- PRD-SEC-002: Catalog, schema, workflow, policy, and controller changes MUST require CODEOWNER approval.
- PRD-SEC-003: Production credentials MUST not be exposed to untrusted PR code.
- PRD-SEC-004: Workflow permissions MUST default to none and be granted per job.
- PRD-SEC-005: Secret values MUST never be persisted outside their provider and Vercel’s encrypted environment-variable storage.
- PRD-SEC-006: Cross-repository GitHub credentials MUST be fine-grained and restricted to selected repositories until a GitHub App is introduced in a future product.

## 9. Success metrics

Launchpad 1.0 is successful when:

- 100% of managed production configuration changes originate from merged PRs or are represented by reconciliation/adoption PRs.
- 100% of catalog PRs receive a plan and terminal preview result.
- 100% of requested unsupported fields fail before apply.
- 100% of destructive operations are blocked from normal apply.
- 100% of permanent failures produce a durable operation record and visible GitHub result.
- At least one end-to-end fixture proves creation, update, failed preview, successful promotion, rollback, drift PR, and safe deletion.
- No production promotion occurs without the configured health gate.
- A controller restart during an apply does not duplicate resources or lose operation state.
- The dashboard can reconstruct current status solely from D1 and live provider reads.

## 10. Product risks

| Risk | Consequence | Required mitigation |
|---|---|---|
| Vercel API/provider behavior changes | Plans or applies become incorrect | Capability discovery, adapter versioning, contract tests, fail-closed unsupported behavior |
| Fine-grained PAT tied to one user | Automation outage after token expiration or user change | Rotation runbook, separate tokens by purpose, dashboard expiry warning, future GitHub App migration path |
| Controller bug repeatedly reconciles wrong state | Repeated production damage | Open-PR drift default, operation locks, idempotency, dry-run plans, canary fixture, kill switch |
| Cloudflare and Vercel proxy/CDN interaction | Cache, verification, or client-IP problems | DNS-only default, explicit proxy policy, origin/public dual health checks |
| Plan approved against stale state | Unexpected apply | Plan fingerprint, merged-SHA revalidation, live replanning, stale-plan block |
| Preview receives production secrets | Data exposure | Environment allowlists, secret policy validation, separate provider paths |
| Shadow preview leaks resources | Cost and clutter | TTL cleanup workflow, cleanup jobs, visible failure, daily orphan sweep |
| False-green result | Unsafe merge or hidden outage | Terminal-state mapping, required health check, no swallowed errors, negative-path tests |

## 11. Launch acceptance

The product is not accepted until:

- All mandatory requirements in this document are implemented or explicitly waived in a reviewed decision record.
- End-to-end tests pass against dedicated GitHub, Vercel, and Cloudflare test resources.
- Branch rules and CODEOWNERS are active and tested with an attempted direct push.
- Secret redaction is validated through automated leak tests.
- A forced provider timeout demonstrates durable retry and eventual failure reporting.
- A forced controller interruption demonstrates workflow recovery.
- A failed production health check demonstrates exact rollback behavior.
- A manually changed Vercel root directory demonstrates drift detection and reconciliation PR creation.
- Deletion cannot occur through ordinary catalog removal.

---

# Part II — Technical Requirements Specification

## 12. Technical architecture requirements

### 12.1 Components

Launchpad MUST consist of the following independently testable components:

1. Catalog and schema package
2. Desired-state compiler
3. Observed-state readers
4. Provider capability registry
5. Resource graph builder
6. Diff and plan engine
7. Policy engine
8. GitHub reporting package
9. Vercel provider adapter
10. Cloudflare provider adapter
11. GitHub provider adapter
12. Secret-provider abstraction
13. Health-check engine
14. CLI
15. GitHub reusable workflows
16. Cloudflare Worker API/controller
17. Cloudflare Workflows
18. D1 persistence layer
19. Queue consumers and dead-letter handling
20. Dashboard

### 12.2 Source-of-truth boundaries

- Desired configuration MUST come from the merged control-repository commit.
- D1 MUST store observed state and operation history, not independent desired configuration.
- Provider dashboards MUST be treated as observed state.
- Pull-request branches MUST be treated as proposed desired state only.
- Reconciliation PRs MUST modify or reference Git content; they MUST NOT create a hidden desired state in D1.

### 12.3 Technology baseline

- Runtime: Node.js 24 LTS line, pinned to an exact patch in repository configuration.
- Package manager: Yarn Modern, pinned through `packageManager` and used with immutable installs.
- Language: TypeScript with strict type checking.
- Module system: ESM.
- Controller runtime: Cloudflare Workers.
- Durable orchestration: Cloudflare Workflows.
- Persistent relational state: Cloudflare D1.
- Async event fan-out and dead-lettering: Cloudflare Queues.
- CI/CD and review gates: GitHub Actions.
- Managed deployment target: Vercel.
- DNS provider: Cloudflare DNS.

The exact Node.js and Yarn patch versions MUST be captured in a dependency decision record and updated only through reviewed dependency PRs.

## 13. Functional technical requirements

### 13.1 Catalog ingestion

- TR-CAT-001: Load all application manifests deterministically in lexical path order.
- TR-CAT-002: Normalize defaults before semantic validation.
- TR-CAT-003: Preserve source locations for every field so errors can identify file, line, and field path.
- TR-CAT-004: Produce a canonical JSON representation for hashing and plan fingerprints.
- TR-CAT-005: Reject YAML anchors or constructs that create ambiguous canonical output unless explicitly normalized.
- TR-CAT-006: Support schema version migration without silently rewriting manifests.

### 13.2 Provider reads

- TR-PROV-001: Provider reads MUST distinguish not-found, inaccessible, forbidden, rate-limited, transient failure, malformed response, and unsupported capability.
- TR-PROV-002: Read operations MUST be safe to retry.
- TR-PROV-003: Observed resources MUST include provider ID, ownership evidence, configuration hash, and observation timestamp.
- TR-PROV-004: A provider response missing required fields MUST fail closed.
- TR-PROV-005: Every provider adapter MUST expose a capability matrix used during validation.

### 13.3 Planning

- TR-PLAN-001: The planner MUST be pure with respect to desired state, observed state, capability data, and policy input.
- TR-PLAN-002: The planner MUST not perform provider writes.
- TR-PLAN-003: Each operation MUST have a deterministic operation ID and idempotency key.
- TR-PLAN-004: Each operation MUST identify prerequisites and downstream invalidations.
- TR-PLAN-005: Plans MUST be serializable to JSON and renderable to Markdown.
- TR-PLAN-006: Any ambiguity in ownership MUST produce `BLOCKED`, never guessed mutation.

### 13.4 Shadow preview

- TR-PRV-001: Shadow preview project names MUST be collision-resistant and tied to repository ID, PR number, application ID, and revision.
- TR-PRV-002: Shadow resources MUST carry ownership metadata where supported and must be tracked in D1.
- TR-PRV-003: Production-only secret targets MUST be statically prohibited from shadow previews.
- TR-PRV-004: Preview polling MUST stop only at READY, ERROR, CANCELED, or configured timeout.
- TR-PRV-005: Relevant build-log excerpts MUST be bounded, redacted, and linked to full provider logs.
- TR-PRV-006: A new PR revision MUST supersede and cancel or clean up the prior revision’s preview workflow.

### 13.5 Apply execution

- TR-APL-001: Apply MUST execute from a generated DAG.
- TR-APL-002: Each durable step MUST write start, attempt, result, and error state.
- TR-APL-003: Completed idempotent steps MUST not repeat after resume unless their preconditions changed.
- TR-APL-004: Provider writes MUST verify the resulting resource state before declaring success.
- TR-APL-005: Apply MUST hold application and domain locks for relevant mutations.
- TR-APL-006: Normal apply MUST reject any `DESTROY` operation before the first write.
- TR-APL-007: A partial apply MUST remain visible as a resumable or failed workflow rather than an untracked half-state.

### 13.6 Deployment and promotion

- TR-DEP-001: A deployment candidate MUST be bound to project, environment, repository, commit SHA, and desired generation.
- TR-DEP-002: The system MUST verify those identities again immediately before promotion.
- TR-DEP-003: Staged production MUST avoid assigning production domains until promotion.
- TR-DEP-004: Health checks MUST run against the candidate deployment before promotion and the production domain after promotion.
- TR-DEP-005: A previous known-good deployment MUST be recorded only after post-promotion health succeeds.
- TR-DEP-006: Rollback MUST target a deployment previously recorded as known-good for the same project and environment.

### 13.7 DNS and domain verification

- TR-DNS-001: DNS ownership MUST be based on provider record IDs and an ownership fingerprint, not hostname alone.
- TR-DNS-002: Existing conflicting records not owned by Launchpad MUST block apply.
- TR-DNS-003: Authoritative DNS verification MUST query the zone’s authoritative nameservers.
- TR-DNS-004: DNS propagation retries MUST use bounded exponential backoff with jitter.
- TR-DNS-005: Vercel domain verification and TLS readiness MUST be independently represented.
- TR-DNS-006: Proxy-mode checks MUST test both origin and public routes.

### 13.8 Reconciliation

- TR-REC-001: Reconciliation MUST operate from the latest protected `main` commit.
- TR-REC-002: Drift fingerprints MUST be stable for equivalent drift.
- TR-REC-003: One open reconciliation PR per application and drift fingerprint MUST be maintained.
- TR-REC-004: Drift resolution MUST support restore and adopt modes.
- TR-REC-005: Reconciliation MUST not automatically destroy resources.
- TR-REC-006: Loss of provider access MUST be represented as `UNKNOWN` or `BLOCKED`, not `SYNCED`.

### 13.9 GitHub integration

- TR-GH-001: Control-repository workflows MUST use native `GITHUB_TOKEN` where sufficient.
- TR-GH-002: Cross-repository reads and writes MUST use purpose-separated fine-grained tokens.
- TR-GH-003: Application reusable workflows MUST authenticate to the controller using GitHub Actions OIDC.
- TR-GH-004: OIDC validation MUST bind repository ID, owner ID, workflow ref, event, PR number, commit, audience, and expiration.
- TR-GH-005: Sticky comments MUST be updated rather than duplicated.
- TR-GH-006: GitHub Deployment statuses MUST map accurately to Launchpad deployment state.

### 13.10 Lifecycle and deletion

- TR-LIFE-001: Manifest disappearance MUST produce `BLOCKED_MISSING_MANIFEST`, not deletion.
- TR-LIFE-002: Decommissioning MUST use explicit lifecycle transitions.
- TR-LIFE-003: Final deletion MUST require a generated single-use approval token and cooling-off period.
- TR-LIFE-004: Dependency checks MUST run immediately before destruction.
- TR-LIFE-005: The destroy workflow MUST create a final export and tombstone.
- TR-LIFE-006: Reuse of a tombstoned application ID or domain MUST be blocked until the retention policy expires or a reviewed override is supplied.

## 14. Non-functional requirements

### 14.1 Reliability

- NFR-REL-001: Controller operations MUST be at-least-once safe through idempotency.
- NFR-REL-002: A controller restart MUST not lose workflow state.
- NFR-REL-003: Retry exhaustion MUST route the event to a dead-letter path and create a visible issue or incident record.
- NFR-REL-004: Provider timeouts MUST be bounded; no operation may wait indefinitely.
- NFR-REL-005: Scheduled reconciliation MUST be independently restartable from apply workflows.

### 14.2 Security

- NFR-SEC-001: Secrets MUST be redacted through structured value handling, not regular-expression-only log cleanup.
- NFR-SEC-002: Tokens MUST be separated by provider and purpose.
- NFR-SEC-003: Provider tokens MUST use the least available scope.
- NFR-SEC-004: Dashboard mutation endpoints MUST require authenticated operator identity and authorization.
- NFR-SEC-005: OIDC tokens MUST be verified cryptographically and checked against an allowlist.
- NFR-SEC-006: Webhooks MUST be signature-verified and replay-protected.
- NFR-SEC-007: Audit records MUST be append-only at the application layer.
- NFR-SEC-008: PR workflows from forks MUST never receive production provider secrets.

### 14.3 Performance

- NFR-PERF-001: Static validation SHOULD complete within 60 seconds for 100 application manifests.
- NFR-PERF-002: Provider reads SHOULD be parallelized where dependencies permit and rate limits allow.
- NFR-PERF-003: Dashboard list endpoints SHOULD return cached status within two seconds under normal load.
- NFR-PERF-004: Plan rendering MUST remain deterministic regardless of provider response ordering.
- NFR-PERF-005: Reconciliation MUST support sharding by application without changing semantics.

### 14.4 Observability

- NFR-OBS-001: Every external request MUST carry a correlation ID.
- NFR-OBS-002: Every workflow, operation, resource, deployment, and health check MUST be queryable by application ID.
- NFR-OBS-003: Logs MUST be structured JSON in the controller.
- NFR-OBS-004: Metrics MUST include success, failure, retries, duration, drift count, preview cleanup backlog, and rollback count.
- NFR-OBS-005: Alerts MUST exist for dead-letter events, repeated reconciliation failure, credential expiration, and controller error-rate thresholds.

### 14.5 Maintainability

- NFR-MNT-001: Core planning logic MUST not import provider SDK types.
- NFR-MNT-002: Provider adapters MUST pass shared contract tests.
- NFR-MNT-003: Database migrations MUST be forward-only and tested against a copy of production schema.
- NFR-MNT-004: Public interfaces MUST use versioned schemas.
- NFR-MNT-005: Dependency updates MUST be automated through reviewed PRs.
- NFR-MNT-006: No production workflow behavior may exist only in undocumented GitHub Actions shell commands.

### 14.6 Usability

- NFR-UX-001: Every blocked result MUST explain what field or resource caused it and what action resolves it.
- NFR-UX-002: Provider IDs MUST be accompanied by human-readable names and links where safe.
- NFR-UX-003: The dashboard MUST separate desired state, observed state, sync status, health, and latest operation.
- NFR-UX-004: Long errors MUST show a concise summary plus a link to complete logs.

---

# Part III — Detailed Engineering Specifications

## 15. Monorepo specification

```text
launchpad/
├── catalog/
│   ├── defaults.yaml
│   ├── environments.yaml
│   └── apps/
├── schema/
├── packages/
│   ├── core/
│   ├── provider-contract/
│   ├── provider-vercel/
│   ├── provider-cloudflare/
│   ├── provider-github/
│   ├── provider-secrets/
│   ├── catalog/
│   ├── database/
│   ├── github-reporting/
│   ├── health/
│   └── shared/
├── apps/
│   ├── cli/
│   ├── controller/
│   └── dashboard/
├── workflows/
├── migrations/d1/
├── tests/
└── .github/
```

### 15.1 Package dependency rule

```text
provider SDKs
    ↓
provider adapters
    ↓
provider contracts
    ↓
core domain models and planner
```

The core package MUST NOT depend on Vercel, Cloudflare, GitHub, Wrangler, or database SDKs.

### 15.2 Workspace scripts

```json
{
  "scripts": {
    "build": "yarn workspaces foreach -A -t run build",
    "test": "yarn workspaces foreach -A -t run test",
    "lint": "yarn workspaces foreach -A -t run lint",
    "typecheck": "yarn workspaces foreach -A -t run typecheck",
    "platform": "yarn workspace @launchpad/cli launchpad",
    "validate": "yarn platform validate",
    "plan": "yarn platform plan",
    "status": "yarn platform status"
  }
}
```

## 16. Domain model

### 16.1 Desired application

```ts
interface DesiredApplication {
  apiVersion: "launchpad.dev/v1";
  kind: "Application";
  metadata: ApplicationMetadata;
  repository: RepositorySpec;
  vercel: VercelProjectSpec;
  environments: EnvironmentSet;
  domains: DomainSpec[];
  secrets: SecretBinding[];
  dependencies: DependencySpec;
  policies: PolicySpec;
  lifecycle: LifecycleSpec;
}
```

### 16.2 Observed application

```ts
interface ObservedApplication {
  applicationId: string;
  observedAt: string;
  github: ObservedGithubState;
  vercel: ObservedVercelState;
  cloudflare: ObservedCloudflareState;
  trackedResources: ResourceRecord[];
  latestDeployments: DeploymentRecord[];
  health: HealthSummary;
}
```

### 16.3 Plan

```ts
interface PlatformPlan {
  schemaVersion: "launchpad.plan/v1";
  applicationId: string;
  desiredGeneration: number;
  sourceCommit: string;
  createdAt: string;
  capabilitySnapshotHash: string;
  observedStateHash: string;
  operations: PlannedOperation[];
  downstreamEffects: DownstreamEffect[];
  policyResults: PolicyResult[];
  fingerprint: string;
  result: "READY" | "BLOCKED" | "DESTRUCTIVE";
}
```

### 16.4 Planned operation

```ts
interface PlannedOperation {
  id: string;
  resourceKey: string;
  provider: ProviderName;
  resourceType: string;
  action:
    | "CREATE"
    | "UPDATE_IN_PLACE"
    | "REDEPLOY_REQUIRED"
    | "RECREATE_PREVIEW_ONLY"
    | "PROMOTE"
    | "RECONCILE"
    | "DECOMMISSION"
    | "DESTROY"
    | "NO_CHANGE"
    | "BLOCKED";
  before: RedactedValue | null;
  after: RedactedValue | null;
  prerequisites: string[];
  invalidates: string[];
  idempotencyKey: string;
  destructive: boolean;
  retryClass: "NONE" | "TRANSIENT" | "PROVIDER_EVENTUAL_CONSISTENCY";
}
```

## 17. Manifest schema specification

### 17.1 Identity

- `metadata.id` is immutable after first apply.
- `metadata.displayName` is mutable.
- `metadata.owners` contains GitHub users or teams.
- Labels are arbitrary bounded string maps.
- Annotations are arbitrary bounded strings but MUST NOT contain secrets.

### 17.2 Repository

Required:

- Provider
- Owner/repository name
- Production branch
- Deployment reference

Optional:

- Staging branch
- Expected repository ID for rename protection
- Managed workflow onboarding policy
- Verified-commit requirement

### 17.3 Vercel project

The schema MUST support:

- Team reference
- Project name
- Framework preset
- Root directory
- Node.js version
- Install command
- Build command
- Development command
- Output directory
- Ignored build rule
- Git connection and production branch
- Domain auto-assignment policy
- Deployment protection
- Analytics settings
- Regions where supported
- Settings requiring redeployment annotations

### 17.4 Environments

Each environment defines:

- Enabled state
- Provider strategy
- Source branch/ref
- Variables and secret targets
- Domain
- Protection
- Preview retention
- Health policy
- Promotion and rollback policy

### 17.5 Domains

Each hostname defines:

- Environment ownership
- Canonical flag
- Cloudflare zone reference
- DNS-only or proxied mode
- TTL
- Redirects
- Proxy compatibility acknowledgments

### 17.6 Lifecycle

Allowed state machine:

```text
active
  ↓
decommissioning
  ↓
approved-for-deletion
  ↓
deleted
```

Invalid reverse transitions MUST block unless an explicit recovery policy permits returning `decommissioning` to `active` before deletion approval.

## 18. Provider contracts

```ts
interface ProviderContext {
  correlationId: string;
  applicationId: string;
  workflowId: string;
  actor: ActorIdentity;
  dryRun: boolean;
}

interface ProjectProvider {
  capabilities(): Promise<ProjectProviderCapabilities>;
  observeProject(identity: ProjectIdentity, ctx: ProviderContext): Promise<ObservedProject | null>;
  ensureProject(spec: DesiredProject, ctx: ProviderContext): Promise<MutationResult<ObservedProject>>;
  ensureGitConnection(spec: DesiredGitConnection, ctx: ProviderContext): Promise<MutationResult<ObservedGitConnection>>;
  ensureEnvironment(spec: DesiredEnvironment, ctx: ProviderContext): Promise<MutationResult<ObservedEnvironment>>;
  ensureDomain(spec: DesiredProjectDomain, ctx: ProviderContext): Promise<MutationResult<ObservedProjectDomain>>;
  requiredDnsRecords(domain: DesiredProjectDomain, ctx: ProviderContext): Promise<RequiredDnsRecord[]>;
  createDeployment(request: DeploymentRequest, ctx: ProviderContext): Promise<DeploymentRecord>;
  waitForDeployment(request: DeploymentWaitRequest, ctx: ProviderContext): Promise<DeploymentRecord>;
  promote(request: PromotionRequest, ctx: ProviderContext): Promise<PromotionResult>;
  rollback(request: RollbackRequest, ctx: ProviderContext): Promise<RollbackResult>;
}
```

All mutation methods MUST return the observed postcondition, not merely an accepted API response.

## 19. Diff algorithm

1. Canonicalize desired state.
2. Normalize provider-computed fields out of direct equality comparisons.
3. Load resource ownership mappings.
4. Match desired and observed resources by stable provider ID where known.
5. Use provider-specific discovery keys only when importing or recovering mappings.
6. Detect conflicts and ambiguity.
7. Compute field-level differences through provider capability metadata.
8. Classify each difference.
9. Expand downstream invalidations.
10. Build dependency edges.
11. Run policy checks.
12. Produce stable ordering by dependency depth, provider, resource type, and key.
13. Generate Markdown and JSON plans.
14. Hash canonical plan inputs and output.

## 20. Error model

```ts
type ErrorClass =
  | "VALIDATION"
  | "AUTHENTICATION"
  | "AUTHORIZATION"
  | "NOT_FOUND"
  | "CONFLICT"
  | "UNSUPPORTED"
  | "RATE_LIMITED"
  | "TRANSIENT_PROVIDER"
  | "MALFORMED_PROVIDER_RESPONSE"
  | "TIMEOUT"
  | "BUILD_FAILURE"
  | "HEALTH_FAILURE"
  | "POLICY_BLOCK"
  | "STALE_PLAN"
  | "INTERNAL";

interface PlatformError {
  code: string;
  class: ErrorClass;
  message: string;
  remediation: string | null;
  provider: ProviderName | null;
  operationId: string | null;
  retryable: boolean;
  safeDetails: Record<string, unknown>;
  causeFingerprint: string;
}
```

Examples:

```text
LP-VERCEL-BUILD-FAILED
LP-GITHUB-REPO-INACCESSIBLE
LP-PLAN-STALE
LP-DNS-CONFLICT-UNOWNED
LP-SECRET-PREVIEW-TARGET-FORBIDDEN
LP-DESTROY-NORMAL-APPLY-BLOCKED
LP-HEALTH-BODY-ASSERTION-FAILED
```

## 21. Controller API

### 21.1 Workflow-authenticated endpoints

```text
POST /v1/plans/verify
POST /v1/applications/{id}/apply
POST /v1/applications/{id}/preview/verify
POST /v1/applications/{id}/health/run
POST /v1/applications/{id}/rollback
```

Requirements:

- Require GitHub OIDC bearer token.
- Validate audience and repository/workflow claims.
- Bind requests to expected commit and application.
- Require idempotency key on mutating calls.
- Return workflow ID immediately for durable operations.

### 21.2 Dashboard endpoints

```text
GET  /v1/applications
GET  /v1/applications/{id}
GET  /v1/applications/{id}/resources
GET  /v1/applications/{id}/operations
GET  /v1/applications/{id}/deployments
GET  /v1/applications/{id}/health
GET  /v1/applications/{id}/drift
POST /v1/applications/{id}/actions/retry
POST /v1/applications/{id}/actions/recheck
POST /v1/applications/{id}/actions/rollback
POST /v1/applications/{id}/changes/propose
```

Dashboard mutations require operator authentication, CSRF protection where applicable, and audit logging.

### 21.3 Webhooks

```text
POST /webhooks/vercel
```

Webhook handling MUST:

- Verify provider signature.
- Deduplicate event IDs.
- Persist receipt before processing.
- Enqueue processing.
- Return promptly.
- Never trust webhook payload as the final provider state without follow-up read.

## 22. Durable workflow state machines

### 22.1 Apply workflow

```text
QUEUED
  ↓
VALIDATING
  ↓
LOCKING
  ↓
ENSURING_PROJECT
  ↓
ENSURING_GIT
  ↓
ENSURING_SETTINGS
  ↓
ENSURING_ENVIRONMENTS
  ↓
ENSURING_SECRETS
  ↓
ENSURING_DOMAINS
  ↓
ENSURING_DNS
  ↓
VERIFYING_DOMAIN
  ↓
BUILDING_CANDIDATE
  ↓
CHECKING_CANDIDATE
  ↓
PROMOTING
  ↓
CHECKING_PRODUCTION
  ↓
RECORDING_KNOWN_GOOD
  ↓
SUCCEEDED
```

Any state can move to `RETRYING`, `BLOCKED`, `FAILED`, or `ROLLING_BACK` where defined.

### 22.2 Preview workflow

```text
QUEUED
  ↓
CREATING_SHADOW_PROJECT
  ↓
APPLYING_PROPOSED_SETTINGS
  ↓
CREATING_DEPLOYMENT
  ↓
WAITING_FOR_BUILD
  ↓
CHECKING_HEALTH
  ↓
REPORTING
  ↓
READY
  ↓
CLEANUP_PENDING
  ↓
CLEANED
```

### 22.3 Reconciliation workflow

```text
OBSERVING
  ↓
DIFFING
  ↓
SYNCED
```

or:

```text
OBSERVING
  ↓
DIFFING
  ↓
OUT_OF_SYNC
  ↓
OPENING_OR_UPDATING_PR
  ↓
AWAITING_REVIEW
```

## 23. Database requirements

Core tables:

```text
applications
resources
resource_ownership
desired_generations
observations
plans
plan_operations
workflow_runs
workflow_steps
deployments
deployment_promotions
health_checks
drift_events
reconciliation_requests
provider_errors
webhook_events
cleanup_jobs
tombstones
audit_events
credentials_metadata
```

### 23.1 Invariants

- One active resource-ownership record per provider resource ID.
- One active application lock per application.
- One active domain lock per hostname.
- One known-good current production deployment per application/environment.
- One open reconciliation request per application and drift fingerprint.
- Secret values are prohibited from all columns.
- Audit events are immutable after insertion.

## 24. GitHub Actions specification

### 24.1 Control repository: `validate-plan.yml`

Triggers:

- Pull request opened, synchronized, reopened, or marked ready.
- Paths under catalog, schema, provider policy, workflows, or core planner.

Jobs:

1. `schema`
2. `catalog`
3. `provider-preflight`
4. `plan`
5. `preview`
6. `health`
7. `summary`

The summary job MUST use `if: always()` and MUST fail when any required upstream job failed, while still publishing the aggregated report.

### 24.2 Control repository: `apply.yml`

Triggers:

- Push to protected `main` resulting from merge.

Jobs:

1. Verify merge provenance.
2. Revalidate.
3. Replan.
4. Verify fingerprint.
5. Authenticate with OIDC.
6. Start durable apply.
7. Poll operation.
8. Publish summary.

### 24.3 Reusable application preview workflow

Inputs:

- Application ID
- Manifest path or catalog endpoint
- Optional health override prohibited unless policy allows it

Outputs:

- Vercel deployment ID
- Preview URL
- Build state
- Health state
- Dashboard operation URL

### 24.4 Workflow security

- All third-party actions MUST be pinned to immutable commit SHAs for production workflows.
- `permissions: {}` MUST be the workflow default.
- Fork PRs MUST run only unprivileged validation.
- Shell scripts MUST use strict modes.
- Generated Markdown MUST escape untrusted provider and repository text.

## 25. Branch and review protection

The `main` ruleset MUST require:

- Pull request association.
- One or more approving reviews.
- CODEOWNER review.
- Dismissal of stale approvals.
- Approval of the latest reviewable push.
- All conversations resolved.
- Required Launchpad checks.
- Branch up to date.
- No force pushes.
- No branch deletion.
- No normal bypass, including administrators.
- Squash merge as the supported merge method.

A separate emergency break-glass role MAY exist, but every bypass MUST create an audit event and incident issue.

## 26. Health-check specification

Health checks support:

- HTTP and HTTPS.
- Method, path, headers, and body.
- Secret-backed headers.
- Expected status set.
- JSONPath equality.
- String or regular-expression body checks.
- Redirect policy.
- TLS verification.
- Latency threshold.
- Attempts, timeout, interval, and backoff.
- Required and optional dependencies.

A health result records:

```ts
interface HealthCheckRecord {
  id: string;
  applicationId: string;
  environment: string;
  deploymentId: string | null;
  url: string;
  attempt: number;
  dnsResolved: boolean;
  tlsValid: boolean;
  statusCode: number | null;
  latencyMs: number | null;
  assertionResults: AssertionResult[];
  result: "PASSED" | "FAILED" | "ERROR";
  checkedAt: string;
  errorCode: string | null;
}
```

## 27. Dashboard specification

### 27.1 Pages

- Application list
- Application detail
- Resource graph
- Plan detail
- Workflow detail
- Deployment history
- Health history
- Drift and reconciliation
- Audit history
- Platform operations
- Credential metadata and expiration warnings

### 27.2 Application list columns

- Application
- Owner
- Sync
- Health
- Current deployment
- Production URL
- Last successful reconciliation
- Active operation
- Open PR or incident

### 27.3 Direct actions

Allowed direct operational actions:

- Retry failed step
- Re-run health check
- Roll back to known-good deployment
- Cancel queued operation

Configuration-changing actions MUST create a PR:

- Change root directory
- Change framework
- Add domain
- Enable proxy
- Change environment policy
- Adopt drift
- Restore drift
- Begin decommissioning

## 28. Security specification

### 28.1 Credential separation

- Vercel read/write token
- Cloudflare zone DNS token
- GitHub catalog-read token
- GitHub application-report token
- GitHub onboarding token
- Secret-provider credential

No single token SHOULD provide all platform access.

### 28.2 Secret redaction

- Values are wrapped in a `SensitiveValue` type immediately after retrieval.
- Serialization of `SensitiveValue` throws unless an explicit redaction method is used.
- Logger serializers replace values with fingerprints or `[REDACTED]`.
- Tests inject canary secrets and scan all artifacts, comments, logs, D1 rows, and summaries.

### 28.3 Supply chain

- Lockfile required.
- Immutable installs required.
- Dependency review required.
- Third-party Actions pinned.
- Build provenance and SBOM SHOULD be generated for controller releases.
- Controller deployment MUST use reviewed artifacts from the protected commit.

## 29. Fail-loud specification

The following are prohibited:

- Empty catches.
- Logging an error and returning success.
- Treating timeout as success.
- Marking a workflow successful because cleanup succeeded after deployment failure.
- Ignoring unsupported provider fields.
- Swallowing provider response parse failures.
- Continuing after ownership ambiguity.
- Returning `SYNCED` when provider reads failed.

A final aggregator MUST produce the clearest available failure summary even when earlier jobs failed.

---

# Part IV — Implementation and Pull Request Plan

## 30. Delivery strategy

Launchpad is one integrated product target, but implementation is divided into gated milestones. Each milestone lands through reviewable pull requests and leaves the repository in a tested, usable state. No milestone should create an irreversible architecture that blocks the later controller or provider modules.

## 31. Milestone 0 — Architecture and repository foundation

### Deliverables

- Monorepo initialized with Yarn workspaces.
- Exact Node and Yarn versions pinned.
- Strict TypeScript, linting, formatting, test runner, and build pipeline.
- Architecture decision records:
  - No Terraform/OpenTofu
  - No custom GitHub App
  - Cloudflare Worker/Workflows/D1 control plane
  - Git as desired state
  - Open-PR reconciliation default
  - Staged production promotion
- Initial CODEOWNERS.
- Main branch ruleset documented and applied.
- Dependency update automation.

### Pull requests

- PR-001: Bootstrap monorepo and toolchain.
- PR-002: Add CI quality gates and immutable dependency installs.
- PR-003: Add CODEOWNERS, ruleset configuration documentation, and security baseline.
- PR-004: Add architectural decision records.

### Exit criteria

- Direct push test is rejected.
- CODEOWNER approval is required for protected paths.
- Build, lint, typecheck, and unit-test jobs pass.

## 32. Milestone 1 — Catalog, schema, and domain model

### Deliverables

- Strict JSON Schema.
- YAML parser with source locations.
- Defaults and canonicalization.
- Cross-file semantic validation.
- Duplicate and cycle detection.
- Lifecycle-state validation.
- CLI `validate` command.
- Fixture catalog.

### Pull requests

- PR-005: Core domain types and canonical serialization.
- PR-006: Application schema and YAML loader.
- PR-007: Semantic validation and dependency graph checks.
- PR-008: CLI validation output and GitHub annotations.

### Exit criteria

- Invalid root syntax, duplicate IDs, duplicate domains, cycles, unknown fields, plaintext sensitive values, and invalid lifecycle transitions fail with file and field context.

## 33. Milestone 2 — Provider contracts and read-only adapters

### Deliverables

- Provider contract package.
- Capability matrix.
- GitHub repository observation.
- Vercel project, deployment, domain, environment, and setting observation.
- Cloudflare zone and DNS observation.
- Typed provider error translation.
- Shared provider contract tests.

### Pull requests

- PR-009: Provider contracts and capability model.
- PR-010: GitHub read adapter.
- PR-011: Vercel read adapter.
- PR-012: Cloudflare read adapter.
- PR-013: Contract-test harness and recorded fixtures.

### Exit criteria

- The CLI can print a redacted observed-state document for a fixture application.
- Authentication, authorization, rate-limit, missing-resource, and malformed-response cases are distinguished.

## 34. Milestone 3 — Resource graph, diff, policy, and plans

### Deliverables

- Resource graph builder.
- Field-level diff engine.
- Downstream-impact expansion.
- Ownership conflict detection.
- Policy engine.
- Plan JSON schema and Markdown renderer.
- Plan fingerprinting.
- CLI `plan` command.

### Pull requests

- PR-014: Resource graph and deterministic ordering.
- PR-015: Diff classifier and downstream effects.
- PR-016: Policy engine and destructive-change block.
- PR-017: Plan serialization, Markdown rendering, and fingerprint.

### Exit criteria

- Changing framework, root directory, environment variable reference, domain, and proxy mode produces expected downstream operations.
- A normal plan containing destruction is blocked.
- Equivalent inputs produce byte-equivalent canonical plans.

## 35. Milestone 4 — Control-repository PR experience

### Deliverables

- `validate-plan.yml`.
- Sticky PR comment.
- Plan and graph artifacts.
- Required status checks.
- Provider preflight.
- Always-running final summary.
- Secret-safe log handling.

### Pull requests

- PR-018: GitHub reporting and sticky-comment library.
- PR-019: Validation and planning workflow.
- PR-020: Aggregated summary and artifact publication.
- PR-021: Negative-path and fork-PR security tests.

### Exit criteria

- A catalog PR receives all required checks and one updated plan comment.
- Failed validation never appears green.
- Fork PRs cannot access provider credentials.

## 36. Milestone 5 — Shadow Vercel previews

### Deliverables

- Shadow project naming and ownership.
- Vercel write adapter for temporary projects/settings.
- Deployment creation/polling.
- Build-log extraction and redaction.
- Preview health engine.
- Preview cleanup workflow and orphan sweep.

### Pull requests

- PR-022: Vercel temporary-project mutations.
- PR-023: Preview deployment and terminal-state polling.
- PR-024: Health engine and assertions.
- PR-025: PR preview integration and loud failure reporting.
- PR-026: Cleanup jobs and expiration policy.

### Exit criteria

- A deliberately incorrect root directory fails the PR with the relevant Vercel build error.
- A valid proposed configuration receives a working preview URL and health result.
- Closed and superseded PR resources are removed or visibly queued for cleanup.

## 37. Milestone 6 — Persistence and controller foundation

### Deliverables

- Cloudflare Worker API.
- D1 schema and migrations.
- Correlation IDs and structured logs.
- Workflow and operation persistence.
- Application and domain locks.
- GitHub OIDC verification.
- Queue and dead-letter plumbing.

### Pull requests

- PR-027: D1 schema, migration tooling, and repositories.
- PR-028: Worker API skeleton and authentication.
- PR-029: OIDC claim validation and allowlists.
- PR-030: Durable workflow base classes and locks.
- PR-031: Queue consumers and dead-letter reporting.

### Exit criteria

- A test workflow survives intentional interruption and resumes.
- Duplicate mutating requests with one idempotency key do not duplicate operations.
- Invalid OIDC claims are rejected.

## 38. Milestone 7 — Production apply and resource reconciliation

### Deliverables

- Vercel project creation/update.
- Git connection management.
- Project setting reconciliation.
- Environment and secret-reference application.
- Vercel domain attachment.
- Cloudflare DNS mutation.
- DNS and Vercel verification waits.
- Automatic apply workflow from merged `main`.

### Pull requests

- PR-032: Vercel project and Git connection ensure operations.
- PR-033: Vercel settings and environment reconciliation.
- PR-034: Secret-provider abstraction and safe Vercel environment-variable writes.
- PR-035: Cloudflare DNS ensure and ownership tracking.
- PR-036: Domain verification and TLS readiness.
- PR-037: Protected automatic apply workflow.

### Exit criteria

- Adding a fixture app creates the project, Git connection, settings, domain, DNS, and verified HTTPS without dashboard edits.
- A stale plan blocks before writes.
- A partial provider failure resumes from the failed durable step.

## 39. Milestone 8 — Staging, promotion, and rollback

### Deliverables

- Custom environment and separate-project staging strategies.
- Staged production candidate creation.
- Exact commit/deployment verification.
- Pre-promotion health gates.
- Promotion.
- Post-promotion checks.
- Known-good tracking.
- Automatic rollback.
- GitHub Deployment statuses and final summaries.

### Pull requests

- PR-038: Staging environment strategies.
- PR-039: Production candidate and promotion logic.
- PR-040: Known-good deployment registry and rollback.
- PR-041: GitHub deployment reporting.
- PR-042: End-to-end release and rollback tests.

### Exit criteria

- Production domain remains on the prior deployment until candidate health passes.
- A forced post-promotion failure restores the prior known-good deployment.
- The failed release remains red while availability restoration is reported separately.

## 40. Milestone 9 — Application repository preview gate

### Deliverables

- Reusable GitHub workflow.
- Repository onboarding PR generator.
- Controller endpoint for locating Vercel deployment by exact commit.
- Build and health reporting.
- Deployment status and sticky comment.

### Pull requests

- PR-043: Reusable preview workflow.
- PR-044: Cross-repository reporting and token separation.
- PR-045: Onboarding PR generator.
- PR-046: Preview-gate end-to-end fixture.

### Exit criteria

- An application PR with a Vercel build failure is blocked with a useful GitHub explanation.
- A successful application PR shows the exact preview and health state.

## 41. Milestone 10 — Drift detection and reconciliation PRs

### Deliverables

- Scheduled observation workflow.
- Drift classifier and fingerprints.
- Dashboard sync-state updates.
- Reconciliation branch/PR creation and update.
- Restore and adopt modes.
- Credential/access drift detection.

### Pull requests

- PR-047: Scheduled reconciliation.
- PR-048: Drift events and fingerprints.
- PR-049: Reconciliation PR writer.
- PR-050: Adopt-observed-state manifest generator.
- PR-051: Drift end-to-end tests.

### Exit criteria

- Manual Vercel or Cloudflare changes produce `OUT_OF_SYNC` and one reconciliation PR.
- Repeated checks update rather than duplicate the PR.
- Loss of access never reports synced.

## 42. Milestone 11 — Safe deletion

### Deliverables

- Decommission state enforcement.
- Impact and dependent report.
- Cooling-off policy.
- Deletion token generation and verification.
- Dedicated destroy workflow.
- Final export and tombstones.

### Pull requests

- PR-052: Lifecycle transition and impact planning.
- PR-053: Deletion approval-token service.
- PR-054: Ordered destruction workflow.
- PR-055: Tombstones and reuse protection.
- PR-056: Destructive-path security tests.

### Exit criteria

- Removing a manifest cannot delete anything.
- Ordinary apply refuses destroy.
- Only the dedicated reviewed flow can remove resources.

## 43. Milestone 12 — Dashboard and operations

### Deliverables

- Application list and detail pages.
- Resource graph.
- Operation and workflow history.
- Deployments and health history.
- Drift/reconciliation view.
- Audit history.
- Retry, recheck, and rollback actions.
- Configuration-changing action-to-PR flow.
- Credential metadata warnings.

### Pull requests

- PR-057: Dashboard shell and authenticated API client.
- PR-058: Application status and resource views.
- PR-059: Workflow, deployment, and health views.
- PR-060: Drift and audit views.
- PR-061: Operational actions and PR-generating actions.

### Exit criteria

- Operators can determine what failed, where, why, and what recovery occurred without opening raw D1 tables.
- Direct configuration changes from the dashboard create PRs rather than mutating providers.

## 44. Milestone 13 — Hardening and production readiness

### Deliverables

- Full end-to-end fixture.
- Chaos and interruption tests.
- Rate-limit tests.
- Secret canary leak tests.
- Performance tests.
- Provider API compatibility monitoring.
- Backup and restoration runbook.
- Credential rotation runbook.
- Incident and break-glass runbook.
- Operational alerts.

### Pull requests

- PR-062: End-to-end system fixture.
- PR-063: Fault injection and durable recovery tests.
- PR-064: Security and secret-leak test suite.
- PR-065: Metrics, alerts, and operational dashboards.
- PR-066: Runbooks and release checklist.

### Exit criteria

- All acceptance criteria in the PRD and technical specification are demonstrated.
- A production-readiness review signs off security, recovery, and operational ownership.

## 45. Recommended first production rollout

1. Deploy the control plane against dedicated test accounts/zones.
2. Manage one disposable fixture application.
3. Manage one non-critical real application with DNS-only mode.
4. Observe several ordinary application PRs and production promotions.
5. Intentionally create and resolve drift.
6. Exercise rollback.
7. Add additional non-critical applications.
8. Enable proxied mode only for an application that specifically needs Cloudflare edge controls.
9. Keep deletion protection enabled for all applications until the destroy workflow has been independently reviewed.

## 46. Pull request quality requirements

Every implementation PR MUST contain:

- Problem and requirement IDs addressed.
- Architecture impact.
- Security impact.
- Migration impact.
- Test evidence.
- Failure-path evidence.
- Screenshots or artifacts for user-visible workflow changes.
- Rollback instructions for controller or schema changes.
- Documentation updates.

Large provider or workflow changes SHOULD be split by contract, implementation, tests, and integration rather than landing as one unreviewable PR.

---

# Part V — Verification and Operational Readiness

## 47. Test matrix

| Area | Positive test | Negative test | Recovery test |
|---|---|---|---|
| Schema | Valid manifest | Unknown field | Not applicable |
| Repository | Accessible private repo | Inaccessible or archived repo | Token restored and plan rerun |
| Root directory | Valid monorepo root | Missing package.json | Fix PR revision succeeds |
| Vercel build | READY deployment | Build ERROR | New commit supersedes failure |
| DNS | Correct CNAME | Conflicting unowned record | Conflict removed and apply resumes |
| Verification | Domain verified | Verification timeout | Retry after DNS correction |
| Health | Expected status/body | Wrong status/body | Candidate fixed before promotion |
| Promotion | Exact candidate promoted | Commit mismatch | New candidate generated |
| Rollback | Prior known-good restored | No known-good available | Block and incident escalation |
| Drift | Manual setting detected | Provider unreadable | Access restored and state re-observed |
| Deletion | Approved ordered teardown | Manifest removed directly | Normal apply remains blocked |
| Controller | Workflow completes | Worker interrupted | Workflow resumes without duplication |

## 48. Operational runbooks required

- Vercel API outage
- Cloudflare API outage
- GitHub API outage
- Fine-grained token expiration or revocation
- D1 migration failure
- Stuck application lock
- Stuck domain lock
- Repeated preview cleanup failure
- Dead-letter queue processing
- Failed production promotion
- Failed rollback
- Provider schema incompatibility
- Break-glass branch-rule bypass
- Controller rollback
- Secret-provider outage

## 49. Release gates

### Gate A — Code quality

- Typecheck, lint, unit, contract, and integration tests pass.
- Dependency and security review pass.

### Gate B — Safety

- Direct push protection verified.
- Destructive normal apply verified blocked.
- Secret canary scan clean.
- Stale-plan protection demonstrated.

### Gate C — Reliability

- Controller interruption recovery demonstrated.
- Provider retry and timeout behavior demonstrated.
- Dead-letter path demonstrated.

### Gate D — Deployment correctness

- Failed Vercel preview blocks PR loudly.
- Candidate health blocks promotion.
- Exact deployment promotion verified.
- Rollback restores known-good deployment.

### Gate E — Reconciliation

- Manual drift opens a PR.
- Restore and adopt flows both work.
- Provider read failure reports unknown/blocked.

### Gate F — Operations

- Dashboard reflects all state dimensions.
- Runbooks reviewed.
- Alerts tested.

---

# Part VI — Requirements Traceability Matrix

| Product requirement | Technical requirement | Primary milestone | Verification |
|---|---|---|---|
| PRD-CAT-001–006 | TR-CAT-001–006 | 1 | Schema and semantic fixture suite |
| PRD-PLAN-001–006 | TR-PLAN-001–006 | 3–4 | Deterministic plan snapshots and PR workflow tests |
| PRD-PRV-001–005 | TR-PRV-001–006 | 5 | Invalid-root and successful-preview E2E tests |
| PRD-APL-001–008 | TR-APL-001–007, TR-DEP-001–006 | 6–8 | Apply interruption, promotion, and rollback tests |
| PRD-DNS-001–005 | TR-DNS-001–006 | 7 | Authoritative DNS and proxy compatibility tests |
| PRD-REC-001–005 | TR-REC-001–006 | 10 | Manual drift and reconciliation PR tests |
| PRD-STS-001–004 | NFR-OBS-001–005 | 6, 12, 13 | Failure fan-out and dashboard assertions |
| PRD-SEC-001–006 | TR-GH-001–006, NFR-SEC-001–008 | 0, 4, 6, 13 | Ruleset, OIDC, token-scope, and leak tests |
| Safe deletion | TR-LIFE-001–006 | 11 | Direct-removal block and approved destroy E2E |
| Modular extensibility | NFR-MNT-001–006 | All | Provider contract tests and dependency-boundary linting |

---

# Part VII — Source Notes

The implementation must verify API details against current official documentation during coding. The following official sources support the architecture baseline:

1. Vercel Git deployments and preview/production behavior: `https://vercel.com/docs/git`
2. Vercel environments and custom environments: `https://vercel.com/docs/deployments/environments`
3. Vercel deployment promotion and staged production: `https://vercel.com/docs/deployments/promoting-a-deployment`
4. Vercel CLI promotion behavior: `https://vercel.com/docs/cli/promote`
5. Vercel REST API: `https://vercel.com/docs/rest-api`
6. GitHub repository rulesets: `https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets`
7. GitHub CODEOWNERS: `https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners`
8. GitHub Actions OIDC: `https://docs.github.com/en/actions/reference/security/oidc`
9. Cloudflare Workflows durable execution: `https://developers.cloudflare.com/workflows/`
10. Cloudflare D1: `https://developers.cloudflare.com/d1/`
11. Cloudflare Queues and dead-letter queues: `https://developers.cloudflare.com/queues/configuration/dead-letter-queues/`
12. Cloudflare Cron Triggers: `https://developers.cloudflare.com/workers/configuration/cron-triggers/`
13. Yarn Corepack and package-manager pinning: `https://yarnpkg.com/corepack`
14. Node.js release information: `https://nodejs.org/`

---

# Part VIII — Unified GitOps Platform Specification — Verbatim Reproduction

The following section reproduces the previously delivered **Unified GitOps Platform Specification** word for word. Its wording, ordering, examples, and links are intentionally not edited to match the newer PRD and engineering material above.

# Unified GitOps Platform Specification

**Working name:** Launchpad  
**Release model:** One integrated production release  
**Primary stack:** TypeScript, Node.js, Yarn, GitHub Actions, Cloudflare Workers, Cloudflare Workflows, Cloudflare D1, Vercel, and Cloudflare DNS  
**Explicit exclusions:** Terraform, OpenTofu, and a custom GitHub App

---

## 1. Product objective

Launchpad is a small internal developer platform that turns a Git repository into the source of truth for deploying and operating applications.

Adding this:

```yaml id="gyjr19"
apps:
  - id: tokentest
    repository: CarterLaSalle/tokentest
    domains:
      production: tokentest.example.com
```

must result in:

1. Repository validation.
2. A proposed infrastructure diff.
3. A real Vercel preview build.
4. Build failures and logs shown in GitHub.
5. CODEOWNER approval.
6. Automated creation or updating of the Vercel project.
7. Automated Vercel Git integration.
8. Automated environment configuration.
9. Automated Cloudflare DNS configuration.
10. DNS and TLS verification.
11. A staged production build.
12. Health checks against the staged deployment.
13. Promotion of that exact production build without rebuilding.
14. Post-promotion production health checks.
15. Automatic rollback when configured.
16. Persistent resource and deployment status.
17. Continuous drift detection.
18. Reconciliation PRs when reality no longer matches Git.
19. A dashboard showing every application’s current state.

Normal application code deployments remain simple:

```text id="wdyiid"
Application pull request
        ↓
Vercel preview deployment
        ↓
Preview verification and health checks
        ↓
Merge to main
        ↓
Staged production build
        ↓
Automated verification
        ↓
Promote exact build
```

Vercel’s Git integration already creates preview deployments for pull requests and production deployments from the configured production branch. Launchpad wraps that native behavior with additional verification, promotion gates, reporting, health checks, recovery, and infrastructure reconciliation. ([vercel.com](https://vercel.com/docs/git))

---

## 2. Core design decisions

### 2.1 Git is the desired-state source of truth

The control repository contains what should exist:

- Applications
- Repository bindings
- Vercel settings
- Framework presets
- Root directories
- Build configuration
- Domains
- Cloudflare proxy settings
- Environments
- Health checks
- Secret references
- Lifecycle policies
- Dependencies
- Promotion and rollback behavior

Manual changes in Vercel or Cloudflare are considered drift unless explicitly adopted through a pull request.

### 2.2 D1 stores observed state, not desired state

Cloudflare D1 stores:

- Provider resource IDs
- Deployment IDs
- Last observed configuration
- Plan fingerprints
- Operation history
- Health results
- Drift events
- Retry state
- Previous known-good deployments
- GitHub pull-request and deployment references

The database does not become a second configuration source. Git remains authoritative.

Cloudflare D1 provides managed SQLite semantics and can be accessed directly from Workers. Cloudflare Workflows provides durable multi-step execution, persisted step results, automatic retries, and recovery from interrupted operations. ([developers.cloudflare.com](https://developers.cloudflare.com/workflows/))

### 2.3 GitHub Actions handles review-time work

GitHub Actions performs:

- Schema validation
- Static validation
- Live provider validation
- Plan generation
- Temporary preview provisioning
- PR comments
- Required status checks
- Merged-commit revalidation
- Privileged apply authorization

### 2.4 The persistent controller handles long-running work

A Cloudflare Worker and Cloudflare Workflow handle:

- Durable apply operations
- DNS propagation waiting
- Vercel verification waiting
- Deployment polling
- Health checks
- Retries
- Rollbacks
- Scheduled reconciliation
- Drift detection
- Reconciliation PR creation
- Dashboard APIs
- Vercel webhook processing

### 2.5 No custom GitHub App

Launchpad uses:

- The workflow’s native `GITHUB_TOKEN` inside the control repository.
- Fine-grained personal access tokens for cross-repository operations.
- GitHub Actions OIDC for workflows authenticating to the controller.
- Vercel’s existing GitHub integration for connecting repositories to Vercel.

A consequence of excluding a custom GitHub App is that Launchpad cannot independently create custom GitHub Check Runs through the Checks API. GitHub restricts creating check runs to GitHub Apps. Therefore, Launchpad uses GitHub Actions jobs as required checks, standard commit statuses for controller-originated results, GitHub Deployments, and persistent PR comments. ([docs.github.com](https://docs.github.com/en/rest/checks/runs))

---

## 3. System architecture

```text id="n4mb54"
┌─────────────────────────────────────────────────────────────┐
│                    GitHub control repository                │
│                                                             │
│  catalog/apps/*.yaml                                        │
│  schema/                                                    │
│  packages/core/                                             │
│  packages/providers/                                        │
│  apps/controller/                                           │
│  apps/dashboard/                                            │
│  .github/workflows/                                         │
└──────────────────┬───────────────────────────┬──────────────┘
                   │                           │
            Pull request                  Merge to main
                   │                           │
                   ▼                           ▼
┌───────────────────────────┐      ┌──────────────────────────┐
│ GitHub Actions plan       │      │ GitHub Actions apply    │
│                           │      │ authorization           │
│ Validate                  │      │                          │
│ Read provider state       │      │ Revalidate merged SHA   │
│ Generate resource graph   │      │ Verify plan fingerprint │
│ Create shadow preview     │      │ Start durable workflow  │
│ Wait for Vercel build     │      └────────────┬─────────────┘
│ Run preview health check  │                   │
│ Update PR comment         │                   ▼
└───────────────────────────┘      ┌──────────────────────────┐
                                   │ Cloudflare controller    │
                                   │                          │
                                   │ Workers + Workflows      │
                                   │ D1 resource state        │
                                   │ Scheduled reconciliation │
                                   │ Vercel webhooks          │
                                   │ GitHub API reporting     │
                                   └──────┬───────────┬───────┘
                                          │           │
                                          ▼           ▼
                                    ┌──────────┐ ┌────────────┐
                                    │ Vercel  │ │ Cloudflare │
                                    │ projects│ │ DNS        │
                                    │ deploys │ │ proxy      │
                                    │ domains │ │ zones      │
                                    └──────────┘ └────────────┘
```

---

## 4. Repository structure

```text id="vorj55"
launchpad/
├── catalog/
│   ├── defaults.yaml
│   ├── environments.yaml
│   └── apps/
│       ├── tokentest.yaml
│       └── portfolio.yaml
│
├── schema/
│   ├── app.schema.json
│   ├── defaults.schema.json
│   └── schema-version.ts
│
├── packages/
│   ├── core/
│   │   ├── desired-state/
│   │   ├── observed-state/
│   │   ├── diff/
│   │   ├── graph/
│   │   ├── plan/
│   │   ├── policy/
│   │   ├── status/
│   │   └── errors/
│   │
│   ├── provider-contract/
│   │   ├── project-provider.ts
│   │   ├── dns-provider.ts
│   │   ├── source-provider.ts
│   │   ├── secret-provider.ts
│   │   └── health-provider.ts
│   │
│   ├── provider-vercel/
│   ├── provider-cloudflare/
│   ├── provider-github/
│   ├── provider-secrets/
│   ├── catalog/
│   ├── database/
│   ├── github-reporting/
│   ├── health/
│   └── shared/
│
├── apps/
│   ├── cli/
│   ├── controller/
│   └── dashboard/
│
├── workflows/
│   ├── apply-app.ts
│   ├── provision-preview.ts
│   ├── reconcile-app.ts
│   ├── promote-production.ts
│   ├── rollback-production.ts
│   └── decommission-app.ts
│
├── migrations/
│   └── d1/
│
├── tests/
│   ├── fixtures/
│   ├── contract/
│   ├── integration/
│   └── end-to-end/
│
├── .github/
│   ├── CODEOWNERS
│   ├── pull_request_template.md
│   ├── actions/
│   └── workflows/
│       ├── validate-plan.yml
│       ├── apply.yml
│       ├── reconcile.yml
│       ├── destroy.yml
│       ├── deploy-control-plane.yml
│       └── reusable-app-preview.yml
│
├── package.json
├── yarn.lock
├── .yarnrc.yml
├── tsconfig.json
└── wrangler.jsonc
```

The engine, provider implementations, controller, dashboard, and CLI must live in separate packages. This prevents the GitHub Actions implementation from becoming the business logic.

---

## 5. Runtime and package-management baseline

The repository uses:

```text id="fvsdw6"
Node.js: 24.18.0 LTS baseline
Package manager: Yarn Modern, exact version pinned through Corepack
Language: TypeScript
Module system: ESM
Yarn linker: node-modules
Python: not used in the core platform
```

Node.js 24.18.0 is the current Node 24 LTS release as of August 4, 2026. Yarn recommends pinning the package-manager version per project through Corepack rather than depending on a globally installed Yarn binary. ([nodejs.org](https://nodejs.org/en/download))

Example:

```json id="0t478i"
{
  "engines": {
    "node": "24.18.x"
  },
  "packageManager": "yarn@<exact-stable-version>"
}
```

```yaml id="cxwj0w"
# .yarnrc.yml
nodeLinker: node-modules
enableImmutableInstalls: true
```

All dependencies are pinned through `yarn.lock`. Renovate opens version-update PRs. Production workflows use:

```bash id="69jmoa"
corepack enable
yarn install --immutable
```

No workflow uses `npm install`, `pnpm`, or Bun.

---

## 6. Application manifest

Each application has one file:

```yaml id="b6uczs"
apiVersion: launchpad.dev/v1
kind: Application

metadata:
  id: tokentest
  displayName: Token Test
  description: Interactive token-streaming demonstration
  owners:
    - "@CarterLaSalle"
  labels:
    team: personal
    criticality: medium
  annotations:
    documentation: https://example.com/docs/tokentest

repository:
  provider: github
  name: CarterLaSalle/tokentest
  productionBranch: main
  stagingBranch: staging
  deploymentRef: main

  access:
    requirePrivateAccessVerification: true
    requireVercelGitAccess: true

  onboarding:
    managedWorkflow: true
    workflowVersion: v1
    openOnboardingPr: true

vercel:
  scope:
    teamIdRef: config://vercel/default-team

  project:
    name: tokentest
    framework: nextjs
    rootDirectory: .
    nodeVersion: "24.x"

    build:
      installCommand: yarn install --immutable
      buildCommand: yarn build
      outputDirectory: null
      developmentCommand: yarn dev
      ignoredBuildStep: null

    git:
      connected: true
      productionBranch: main

    deployment:
      autoAssignProductionDomains: false
      prioritizeProductionBuilds: true
      rollingRelease: null
      skewProtection: false

    regions:
      functions:
        - iad1

    protection:
      preview: vercel-authentication
      staging: vercel-authentication
      production: public

    settings:
      webAnalytics: true
      speedInsights: true
      toolbar: preview-only

environments:
  preview:
    enabled: true

    strategy: shadow-project

    source:
      ref: repository.deploymentRef

    cleanup:
      onPrClose: true
      retentionHours: 24

    health:
      path: /api/health
      method: GET
      expectedStatus:
        - 200
      timeoutSeconds: 10
      attempts: 10
      intervalSeconds: 10
      body:
        jsonPath: $.status
        equals: ok

  staging:
    enabled: true

    strategy: custom-environment
    fallbackStrategy: separate-project

    branch: staging
    domain: tokentest-staging.example.com

    promotion:
      source: staging
      automatic: false

    health:
      path: /api/health
      expectedStatus:
        - 200
      attempts: 12
      intervalSeconds: 10

  production:
    enabled: true
    branch: main
    domain: tokentest.example.com

    release:
      strategy: staged-production
      promoteExactBuild: true
      autoPromoteAfterChecks: true

    rollback:
      enabled: true
      onFailedHealthCheck: true
      previousKnownGood: true

    health:
      path: /api/health
      expectedStatus:
        - 200
      timeoutSeconds: 10
      attempts: 18
      intervalSeconds: 10
      postPromotionAttempts: 12
      body:
        jsonPath: $.status
        equals: ok

domains:
  - hostname: tokentest.example.com
    environment: production
    canonical: true

    cloudflare:
      zoneRef: config://cloudflare/example.com
      mode: dns-only
      ttl: auto

    redirects: []

  - hostname: tokentest-staging.example.com
    environment: staging

    cloudflare:
      zoneRef: config://cloudflare/example.com
      mode: dns-only
      ttl: auto

secrets:
  - name: DATABASE_URL
    source: infisical://tokentest/production/DATABASE_URL
    environments:
      - production

  - name: DATABASE_URL
    source: infisical://tokentest/staging/DATABASE_URL
    environments:
      - staging

  - name: NEXT_PUBLIC_API_BASE
    value: https://api.example.com
    sensitive: false
    environments:
      - preview
      - staging
      - production

dependencies:
  applications: []
  external:
    - id: database
      type: health-endpoint
      url: https://database-status.example.com/ready
      requiredBefore:
        - staging
        - production

policies:
  drift:
    mode: open-pr
    checkIntervalMinutes: 30

  destructiveChanges:
    allowInNormalApply: false

  preview:
    requiredForMerge: true

  staging:
    requiredForProduction: true

  health:
    requiredForPromotion: true

  failures:
    createIssueAfterFinalRetry: true
    notifyOwners: true

lifecycle:
  state: active
  deletionProtection: true
  orphanPolicy: retain
  decommission:
    requestedAt: null
    deleteAfter: null
    approvalToken: null
    preserveDeployments: true
```

---

## 7. Schema and validation

Validation occurs in five layers.

### 7.1 YAML and JSON Schema validation

The schema rejects:

- Unknown fields
- Missing required fields
- Invalid enum values
- Invalid hostnames
- Invalid repository names
- Unsupported API versions
- Invalid lifecycle transitions
- Invalid health-check definitions
- Plaintext sensitive values
- Invalid secret-reference schemes

The schema uses strict object definitions with `additionalProperties: false`.

### 7.2 Cross-file validation

The catalog loader verifies:

- Application IDs are globally unique.
- Vercel project names are globally unique.
- Production subdomains are globally unique.
- Staging subdomains are globally unique.
- A hostname is not assigned to multiple environments.
- Dependency references exist.
- Dependency graphs are acyclic.
- Every zone reference exists.
- Every owner is recognized.
- There are no conflicting redirects.
- There is one canonical production domain at most.
- Deletion requests contain all required lifecycle fields.

### 7.3 GitHub validation

For every application, Launchpad confirms:

- The repository exists.
- The authentication token can access it.
- The production branch exists.
- The staging branch exists when required.
- The configured root directory exists.
- The root directory is actually a directory.
- The package manifest exists when required by the framework.
- The repository is not archived.
- The repository has not been renamed without a corresponding manifest update.
- Vercel’s Git integration has access to the repository.
- The requested commit or branch can be resolved.

Fine-grained GitHub tokens can be restricted to selected repositories and minimum permissions, which is the required approach while a custom GitHub App remains excluded. ([docs.github.com](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens?source=post_page-----3c02664f078----------------------))

### 7.4 Provider capability validation

Each provider declares its supported fields.

A setting can produce one of four results:

```text id="xww6xc"
SUPPORTED
SUPPORTED_WITH_REDEPLOY
UNSUPPORTED
UNKNOWN_PROVIDER_RESPONSE
```

Unsupported settings block the PR. Launchpad never silently ignores a requested setting.

Example:

```text id="k1b62i"
✗ Vercel setting is not currently manageable through the configured API adapter

Field:
  vercel.project.settings.exampleSetting

Result:
  BLOCKED_UNSUPPORTED

No changes were applied.
```

### 7.5 Live preflight validation

Before generating the final plan, Launchpad verifies:

- Vercel credentials work.
- Cloudflare credentials work.
- GitHub credentials work.
- The Cloudflare zone exists.
- The requested domain belongs to the configured zone.
- Existing DNS records do not conflict.
- Existing Vercel projects are not owned by another manifest.
- Existing domains are not assigned to another Vercel project.
- Required secret references exist.
- Required provider quotas or plan features are available.
- Custom Vercel environments are supported by the current Vercel plan.

Vercel custom environments are available for Pro and Enterprise teams. The fallback is a separate staging Vercel project linked to the same repository. ([vercel.com](https://vercel.com/docs/deployments/environments))

---

## 8. Resource graph and dependency ordering

Every manifest is compiled into a directed acyclic resource graph.

Example:

```text id="lru6r3"
GitHubRepository
      │
      ├── RepositoryAccess
      │
      ▼
VercelProject
      │
      ├── VercelGitConnection
      ├── VercelProjectSettings
      ├── VercelEnvironmentVariables
      ├── VercelCustomEnvironment
      │
      ▼
VercelProjectDomain
      │
      ▼
CloudflareDNSRecord
      │
      ▼
VercelDomainVerification
      │
      ▼
StagedProductionDeployment
      │
      ▼
StagedHealthCheck
      │
      ▼
ProductionPromotion
      │
      ▼
ProductionHealthCheck
```

The graph executor guarantees:

- Parent resources exist before children.
- Independent nodes may execute concurrently.
- Mutating operations on one app are serialized.
- Cross-app dependencies are respected.
- Failed nodes prevent downstream nodes from running.
- Already-successful idempotent nodes are not repeated unnecessarily.
- Retryable provider failures retry only the failed step.
- Permanent validation failures stop immediately.

A per-application lock prevents two reconciliations from modifying the same app simultaneously.

---

## 9. Diff and plan engine

The plan engine compares:

```text id="v87n9f"
Desired state from Git
        versus
Live Vercel state
        versus
Live Cloudflare state
        versus
Tracked resource ownership in D1
```

Each difference is classified as:

| Classification | Meaning |
|---|---|
| `CREATE` | A new resource will be created |
| `UPDATE_IN_PLACE` | Existing resource can be safely modified |
| `REDEPLOY_REQUIRED` | Setting change requires a new deployment |
| `RECREATE_PREVIEW_ONLY` | Temporary preview resource must be rebuilt |
| `PROMOTE` | A verified deployment will become current |
| `RECONCILE` | External drift will be returned to Git-defined state |
| `DECOMMISSION` | Resource enters safe-deletion workflow |
| `DESTROY` | Permanent destructive operation |
| `NO_CHANGE` | Desired and observed state match |
| `BLOCKED` | Plan cannot proceed safely |

### 9.1 Downstream-impact calculation

Changing a root directory must show downstream consequences:

```text id="fc2p8a"
~ Update Vercel root directory
    . → apps/web

Downstream effects:
  ↻ New preview build required
  ↻ New staging build required
  ↻ New staged production build required
  ✓ Existing production deployment remains active until promotion
  ✓ Existing DNS remains unchanged
```

Changing an environment variable must show:

```text id="ke60r7"
~ Update secret reference: DATABASE_URL

Downstream effects:
  ↻ Preview redeployment required
  ↻ Staging redeployment required
  ↻ Production staged deployment required
  ! Previous deployments retain the old value
```

Vercel environment-variable changes apply to future deployments rather than modifying existing deployments. ([vercel.com](https://vercel.com/docs/environment-variables))

### 9.2 Plan fingerprint

Each plan receives a SHA-256 fingerprint calculated from:

- Merged manifest content
- Schema version
- Provider adapter versions
- Relevant observed-state versions
- Target repository commit
- Resource graph
- Planned operations

On apply, the merged commit is revalidated and a new live plan is generated.

Apply continues only when:

```text id="5mudl8"
approvedPlanFingerprint == applyPlanFingerprint
```

When live state changed after approval:

```text id="lbnjgs"
BLOCKED: STATE_CHANGED_AFTER_REVIEW

The approved plan is stale.
A replacement planning PR has been opened.
```

This prevents an approved plan from being applied against materially different infrastructure.

---

## 10. Control-repository pull-request workflow

Opening or updating a pull request that modifies the catalog triggers:

```text id="nku461"
platform / schema
platform / catalog
platform / provider-preflight
platform / plan
platform / preview
platform / health
```

GitHub Actions jobs themselves become required checks.

### 10.1 Workflow sequence

```text id="d9xb6u"
Checkout exact PR SHA
        ↓
Install with Yarn --immutable
        ↓
Validate JSON Schema
        ↓
Run semantic catalog validation
        ↓
Confirm repositories and roots
        ↓
Read Vercel and Cloudflare state
        ↓
Build resource graph
        ↓
Generate diff and downstream effects
        ↓
Classify destructive operations
        ↓
Provision shadow preview resources
        ↓
Wait for Vercel build
        ↓
Collect build result and logs
        ↓
Run preview health checks
        ↓
Update sticky PR comment
        ↓
Upload machine-readable artifacts
```

### 10.2 Shadow preview projects

A catalog PR must not mutate the existing production project merely to test a setting.

Instead, Launchpad creates an isolated Vercel shadow project:

```text id="3jslfn"
lp-pr-142-tokentest
```

The shadow project receives:

- Proposed framework
- Proposed root directory
- Proposed install command
- Proposed build command
- Proposed Node version
- Proposed preview-safe environment values
- Target repository and commit
- Temporary preview domain
- Deployment-protection settings

This catches common failures such as:

- Wrong root directory
- Missing package manifest
- Yarn lockfile problems
- Framework detection mismatch
- Build-command failure
- Missing preview environment variables
- Vercel-specific filesystem behavior
- Case-sensitive import errors
- Runtime incompatibilities
- Invalid output directory

The shadow project is deleted when:

- The pull request closes.
- The pull request merges.
- The configured retention period expires.
- A newer commit supersedes the preview and cleanup succeeds.

Cleanup failure creates a visible warning and a tracked cleanup operation. It is never swallowed.

### 10.3 PR comment

Launchpad maintains one sticky comment and edits it on every run.

```markdown id="nz4fmc"
## Launchpad Plan — revision 7

**Commit:** `a81f4c2`
**Plan fingerprint:** `sha256:18b7...`
**Result:** ❌ Preview build failed

### Proposed changes

| App | Action | Resource | Change |
|---|---|---|---|
| tokentest | Update | Vercel project | Root: `.` → `apps/web` |
| tokentest | Update | Vercel project | Node: `22.x` → `24.x` |
| tokentest | No change | Cloudflare DNS | — |
| tokentest | Redeploy | Preview | Required |
| tokentest | Redeploy | Production | Required after merge |

### Preview deployment

- Project: `lp-pr-142-tokentest`
- Deployment: `dpl_abc123`
- URL: `https://lp-pr-142-tokentest.vercel.app`
- State: `ERROR`
- Duration: 1m 42s

### Failure

```text
Error: No Next.js version detected.
Configured root directory: apps/web
package.json was not found.
```

### Blocking result

This pull request cannot merge until `platform / preview` succeeds.
``` id="1ouop6"

GitHub’s pull-request comment API works with pull-request write permission. The comment is updated rather than creating a new comment on every run. ([docs.github.com](https://docs.github.com/en/rest/issues/comments))

### 10.4 Artifacts

Every plan run uploads:

```text
plan.json
plan.md
resource-graph.json
resource-graph.dot
provider-state-redacted.json
preview-summary.json
health-results.json
build-log-tail.txt
```

Sensitive values are redacted before artifact creation.

---

## 11. Application-repository pull-request workflow

Application repositories remain connected directly to Vercel.

A pull request in an application repository triggers Vercel’s native preview deployment. Vercel creates a unique deployment URL for the branch or pull request and reports the result to GitHub. ([vercel.com](https://vercel.com/docs/git))

Launchpad adds a managed reusable workflow through an onboarding PR:

```yaml id="3b61n9"
name: Launchpad Preview Gate

on:
  pull_request:
    types:
      - opened
      - synchronize
      - reopened
      - ready_for_review

permissions:
  contents: read
  id-token: write
  pull-requests: write
  deployments: write

jobs:
  preview:
    uses: CarterLaSalle/launchpad/.github/workflows/reusable-app-preview.yml@v1
```

### 11.1 Authentication

The reusable workflow obtains a GitHub OIDC token with a Launchpad-specific audience.

The controller verifies:

- Token signature
- Issuer
- Audience
- Expiration
- Repository ID
- Repository owner ID
- Pull-request number
- Workflow reference
- Commit SHA
- Repository allowlist

This avoids installing a static Launchpad controller token in each application repository. GitHub Actions requires `id-token: write` to request an OIDC token and includes repository, workflow, ref, and run identity claims. ([docs.github.com](https://docs.github.com/en/actions/reference/security/oidc))

### 11.2 Preview-gate sequence

```text id="ytxoh0"
Application PR opened
        ↓
Vercel begins preview build
        ↓
Reusable Launchpad workflow authenticates with OIDC
        ↓
Controller locates Vercel deployment for PR commit
        ↓
Wait for READY, ERROR, or CANCELED
        ↓
Retrieve build status and relevant logs
        ↓
Run health check against preview URL
        ↓
Create or update GitHub Deployment status
        ↓
Post or update PR summary
        ↓
Required workflow check passes or fails
```

GitHub Deployment statuses support queued, in-progress, success, failure, error, and inactive states, along with environment and log URLs. ([docs.github.com](https://docs.github.com/en/rest/deployments/statuses))

### 11.3 Loud build failure

When Vercel fails:

```text id="sbhwg5"
platform-preview / verify
Conclusion: failure

Vercel preview deployment failed.

Deployment: dpl_abc123
Commit: 7c4a02e
Build step: yarn build
Failure stage: build
Dashboard logs: [available through attached log URL]

Last relevant output:
  Error: Module not found: Can't resolve './Header'
  Import path differs in capitalization from the file on disk.
```

The failure appears in:

- Required GitHub Actions check
- PR comment
- GitHub Deployment status
- Launchpad dashboard
- D1 operation history
- Final workflow summary

No failed preview can be reported as successful merely because the polling workflow completed.

---

## 12. Merge and apply workflow

Merging the catalog PR triggers `apply.yml`.

The user does not manually run plan or apply.

### 12.1 Apply authorization

The workflow:

1. Checks out the exact merged commit.
2. Repeats schema validation.
3. Repeats semantic validation.
4. Repeats provider preflight.
5. Recomputes live state.
6. Recomputes the plan.
7. Verifies the approved plan fingerprint.
8. Confirms the merge came through a pull request.
9. Rejects destructive operations.
10. Requests a GitHub OIDC token.
11. Calls the controller’s apply endpoint.
12. Waits for the durable workflow result.
13. Writes a GitHub Actions deployment summary.

The controller does not trust the workflow’s submitted plan blindly. It loads the merged manifest independently and verifies the commit and fingerprint.

### 12.2 Durable apply steps

```text id="e7n556"
Acquire application lock
        ↓
Create/update Vercel project
        ↓
Connect Git repository
        ↓
Apply framework and project settings
        ↓
Create/update custom environments
        ↓
Resolve and apply environment variables
        ↓
Attach Vercel project domains
        ↓
Inspect Vercel-required DNS records
        ↓
Create/update Cloudflare DNS
        ↓
Wait for authoritative DNS
        ↓
Request Vercel domain verification
        ↓
Wait for Vercel domain verification
        ↓
Wait for TLS readiness
        ↓
Create staged production deployment
        ↓
Run staged health checks
        ↓
Promote exact staged build
        ↓
Run production-domain health checks
        ↓
Record known-good deployment
        ↓
Publish deployment summary
        ↓
Release lock
```

Vercel’s API supports project management, project domains, environment variables, custom environments, domain verification, and pointing production domains to a selected deployment. ([vercel.com](https://vercel.com/docs/rest-api))

---

## 13. Vercel project-settings management

The Vercel provider adapter supports declarative management of:

| Area | Examples |
|---|---|
| Identity | Project name and team scope |
| Repository | Git provider, repository, production branch |
| Framework | Framework preset |
| Paths | Root directory and output directory |
| Commands | Install, build, and development commands |
| Runtime | Node.js version |
| Builds | Ignored-build behavior and production prioritization |
| Environments | Preview, production, custom staging environments |
| Domains | Production, branch, staging, and redirect domains |
| Variables | Environment-scoped variables and secret references |
| Protection | Preview and staging deployment protection |
| Observability | Web Analytics and Speed Insights where supported |
| Release policy | Auto-domain assignment and staged production |
| Regions | Supported function-region preferences |
| Git behavior | Production branch and connection |
| Lifecycle | Pause, unpause, and project deletion through the separate lifecycle flow |

Vercel exposes project settings such as framework, root/code directory, Node.js version, build settings, domains, environment variables, deployment protection, and observability through project configuration and APIs. ([vercel.com](https://vercel.com/docs/project-configuration/project-settings))

Every provider field has:

```ts id="24d7bn"
interface ManagedFieldCapability {
  read: boolean;
  create: boolean;
  update: boolean;
  delete: boolean;
  requiresRedeploy: boolean;
  destructiveWhenChanged: boolean;
}
```

When Vercel adds or changes an API field, only the Vercel provider package changes. The catalog, plan engine, controller, and dashboard remain provider-neutral.

---

## 14. Preview, staging, and production environments

### 14.1 Preview

Preview is created for:

- Application pull requests
- Catalog pull requests
- Manual diagnostic redeployments

Preview uses preview-only secrets and must never receive production-only secrets.

### 14.2 Staging

Preferred mode:

```yaml id="3cnr4z"
strategy: custom-environment
```

This uses a Vercel custom environment with:

- Branch tracking
- Staging-specific variables
- Persistent staging domain
- Separate deployment history
- Separate protection settings

Fallback mode:

```yaml id="cysb2o"
fallbackStrategy: separate-project
```

This creates:

```text id="3rf911"
tokentest-staging
```

as a separate Vercel project linked to the same repository and staging branch.

### 14.3 Production

Production uses:

```yaml id="r8keth"
release:
  strategy: staged-production
  promoteExactBuild: true
```

The Vercel production branch builds with production environment variables, but custom production domains are not automatically assigned.

Launchpad verifies the staged production deployment and then promotes that exact deployment. Vercel’s staged-production flow can promote a production build without rebuilding when automatic domain assignment is disabled. Promoting a preview deployment directly would rebuild it with production variables, so that is not used as the default no-rebuild production path. ([vercel.com](https://vercel.com/docs/deployments/promoting-a-deployment))

---

## 15. Domain and Cloudflare behavior

### 15.1 DNS-only mode

Default:

```yaml id="zoxzlr"
cloudflare:
  mode: dns-only
```

Sequence:

1. Add domain to the Vercel project.
2. Ask Vercel what DNS records are required.
3. Create the exact returned Cloudflare record.
4. Wait for authoritative Cloudflare nameservers to return it.
5. Ask Vercel to verify.
6. Wait for certificate readiness.
7. Test HTTPS.
8. Test the health path.

The platform must not permanently hardcode a generic Vercel CNAME when Vercel returns a project-specific target. Vercel may provide a unique CNAME for a project subdomain. ([vercel.com](https://vercel.com/docs/domains/working-with-domains/add-a-domain))

### 15.2 Cloudflare proxy mode

Optional:

```yaml id="i00j0w"
cloudflare:
  mode: proxied
```

Proxy mode requires an explicit policy acknowledgment:

```yaml id="mpw0co"
proxy:
  acknowledgeDoubleCdn: true
  bypassWellKnownPaths: true
  verifyConnectingIpHeader: true
  cachePolicy: vercel-compatible
```

Launchpad checks:

- `CF-Connecting-IP` reaches the application.
- `/.well-known/vercel/*` is never cached.
- ACME challenge paths are not broken.
- Cloudflare SSL mode is compatible.
- The origin hostname and SNI are correct.
- Health checks work through both the origin and public domain.
- Vercel domain verification remains valid.

Cloudflare is supported by Vercel’s Verified Proxy Lite through its built-in `CF-Connecting-IP` header. Vercel nevertheless recommends DNS-only operation in most cases because adding a second proxy reduces Vercel’s traffic visibility, adds another CDN layer, and complicates caching and security behavior. ([vercel.com](https://vercel.com/docs/security/reverse-proxy))

Therefore:

```text id="zwwei1"
DNS-only: default and recommended
Cloudflare proxied: explicit opt-in
```

---

## 16. Health checks

Health checks support:

```yaml id="xcra4a"
health:
  path: /api/health
  method: GET

  headers:
    X-Health-Key:
      secretRef: infisical://tokentest/health/KEY

  expectedStatus:
    - 200

  body:
    jsonPath: $.status
    equals: ok

  timeoutSeconds: 10
  attempts: 12
  intervalSeconds: 10

  tls:
    required: true
    minimumDaysRemaining: 7

  redirects:
    allowed: false

  rollbackOnFailure: true
```

The health engine validates:

- DNS resolution
- TLS handshake
- HTTP response
- Redirect behavior
- Expected status
- Response-body assertion
- Optional headers
- Optional latency threshold
- Optional dependency checks
- Preview URL
- Staging domain
- Staged production deployment URL
- Final production domain

A build being `READY` does not imply the application is healthy.

---

## 17. Promotion and rollback

### 17.1 Promotion requirements

Production promotion requires:

```text id="s3l9sq"
Vercel build READY
AND staged deployment health PASSED
AND required dependencies HEALTHY
AND domain configuration VERIFIED
AND no active blocking drift
AND no newer production candidate superseded it
```

### 17.2 Promotion race protection

Before promotion, Launchpad confirms:

- Deployment commit matches the expected main-branch SHA.
- Deployment environment is production.
- Deployment belongs to the expected project.
- No newer approved candidate exists.
- The candidate has not already failed health checks.
- The project lock is still held.

### 17.3 Post-promotion verification

After promotion:

```text id="phacm1"
Wait for alias update
        ↓
Request production domain
        ↓
Validate deployment identity header or release marker
        ↓
Run full health suite
        ↓
Observe runtime error logs for configured window
```

### 17.4 Automatic rollback

When post-promotion health fails and rollback is enabled:

1. Mark the new deployment unhealthy.
2. Locate the previous known-good production deployment.
3. Reassign production domains to it.
4. Verify rollback health.
5. Mark the failed deployment as rejected.
6. Update GitHub Deployment status.
7. Fail the workflow.
8. Open an incident issue.
9. Keep all logs and operation history.

A successful rollback does not turn the original deployment operation green.

Result:

```text id="8ym8qd"
Deployment result: FAILED
Rollback result: SUCCEEDED
Production availability: RESTORED
```

Vercel supports promotion and rollback by reassigning production domains to existing deployments. ([vercel.com](https://vercel.com/docs/deployments/promoting-a-deployment))

---

## 18. Drift detection and reconciliation PRs

A scheduled Cloudflare Workflow runs every 30 minutes by default.

Cloudflare supports scheduled Workers and scheduled Workflows, while Workflows retains durable retries and step state. ([developers.cloudflare.com](https://developers.cloudflare.com/workers/configuration/cron-triggers/))

### 18.1 Reconciliation sequence

```text id="76wxfc"
Read catalog at main
        ↓
Read tracked provider resources
        ↓
Read current Vercel state
        ↓
Read current Cloudflare state
        ↓
Compute drift
        ↓
Classify drift
        ↓
Update dashboard immediately
        ↓
Open or update reconciliation PR
```

### 18.2 Drift categories

| Category | Example |
|---|---|
| Missing resource | DNS record deleted manually |
| Changed setting | Vercel root directory changed manually |
| Untracked resource | Unknown domain added to managed project |
| Ownership conflict | Same domain attached elsewhere |
| Provider-computed change | Vercel generated a new required DNS target |
| Deployment drift | Production alias points to untracked deployment |
| Secret drift | Secret reference fingerprint changed |
| Access drift | Repository or Vercel Git access lost |
| Health drift | Production endpoint no longer healthy |

### 18.3 Reconciliation policy

Default:

```yaml id="p57vmq"
policies:
  drift:
    mode: open-pr
```

The controller does not silently overwrite production changes.

It opens:

```text id="xqlwll"
reconcile/tokentest/2026-08-04T08-30-00Z
```

The PR includes a generated reconciliation request:

```yaml id="x2zkzj"
apiVersion: launchpad.dev/v1
kind: ReconciliationRequest

metadata:
  app: tokentest
  observedAt: 2026-08-04T08:30:00Z

spec:
  desiredGeneration: 14
  reason: external-drift
  operation: restore-desired-state
  driftFingerprint: sha256:ab31...
```

The PR plan explains:

```text id="xepelb"
Drift detected:

Vercel root directory
  Desired: apps/web
  Actual:  .

Proposed reconciliation:
  Restore root directory to apps/web
  Create a new staging deployment
  Create a staged production deployment
  Require health checks before promotion
```

Merging the reconciliation PR triggers the normal apply process.

### 18.4 Adopt-current-state mode

A maintainer can change the reconciliation request to:

```yaml id="du8q8h"
operation: adopt-observed-state
```

The controller then generates manifest edits that adopt the manual provider change into Git.

Both restore and adopt paths require review.

---

## 19. Safe deletion

Removing an application file is not considered valid deletion.

The normal apply workflow refuses all `DESTROY` operations:

```text id="akeo6r"
BLOCKED_DESTRUCTIVE_CHANGE

The normal apply workflow never deletes:
  - Vercel projects
  - Production domains
  - Cloudflare DNS records
  - Custom environments
  - Secret references
```

### 19.1 First deletion PR

```yaml id="mhbgkh"
lifecycle:
  state: decommissioning
  deletionProtection: true

  decommission:
    requestedAt: 2026-08-04T09:00:00Z
    deleteAfter: 2026-08-06T09:00:00Z
    preserveDeployments: true
    approvalToken: null
```

This causes:

- New production promotion to stop.
- A decommission warning to appear.
- The project and domain to remain active.
- A deletion impact report to be generated.
- Owners and dependents to be identified.
- A cooling-off period to begin.

### 19.2 Final deletion PR

After the waiting period:

```yaml id="bvxiqj"
lifecycle:
  state: approved-for-deletion
  deletionProtection: false

  decommission:
    requestedAt: 2026-08-04T09:00:00Z
    deleteAfter: 2026-08-06T09:00:00Z
    approvalToken: delete-tokentest-7c1f9a
    preserveDeployments: true
```

The PR must have:

- CODEOWNER approval.
- All required checks.
- No unresolved review conversations.
- Exact deletion token.
- No blocking dependents.
- Successful final state export.
- A deletion-specific required check.

### 19.3 Destruction workflow

Deletion occurs only through `destroy.yml`, not normal apply.

The workflow:

1. Revalidates the deletion token.
2. Revalidates the waiting period.
3. Confirms no dependents.
4. Exports final resource metadata.
5. Removes Cloudflare proxying first when applicable.
6. Removes production domain assignment.
7. Removes DNS records owned by Launchpad.
8. Removes custom environments.
9. Deletes or retains Vercel project according to policy.
10. Marks GitHub deployments inactive.
11. Records tombstones in D1.
12. Produces a permanent deletion summary.

An app ID and domain remain tombstoned for a configurable period to prevent accidental immediate reuse.

---

## 20. Secret references

No sensitive value is committed to the catalog.

Supported reference formats are provider-based:

```text id="spf9w6"
infisical://project/environment/path#key
onepassword://vault/item/field
encrypted-file://catalog/secrets.enc.yaml#tokentest.production.DATABASE_URL
```

Platform credentials are stored separately:

| Credential | Location |
|---|---|
| Vercel token | GitHub environment secret and controller Worker secret |
| Cloudflare API token | GitHub environment secret and controller Worker secret |
| GitHub fine-grained PAT | Controller Worker secret |
| Secret-provider credential | GitHub environment secret and controller Worker secret |
| OIDC trust configuration | Controller configuration |

Cloudflare Workers secrets or Secrets Store bindings are suitable for the controller’s fixed platform credentials. Cloudflare Secrets Store encrypts account-level secrets and exposes them to Workers through controlled bindings. ([developers.cloudflare.com](https://developers.cloudflare.com/secrets-store/integrations/workers/))

### 20.1 Secret behavior

Launchpad validates that:

- Reference syntax is valid.
- The referenced secret exists.
- The workflow has permission to retrieve it.
- The target environment is permitted.
- Production-only values never enter preview.
- Secret values never enter plans, logs, comments, artifacts, or D1.
- Vercel receives the resolved value through its environment-variable API.
- Only a keyed fingerprint is retained for drift detection.

Secret changes cause a new deployment because existing Vercel deployments retain their existing environment values.

---

## 21. Persistent state model

D1 contains these primary tables:

```sql id="ydu8ox"
applications
resources
resource_ownership
desired_generations
observations
plans
plan_operations
workflow_runs
workflow_steps
deployments
deployment_promotions
health_checks
drift_events
reconciliation_requests
provider_errors
webhook_events
cleanup_jobs
tombstones
audit_events
```

### 21.1 Resource record

```ts id="isxy12"
interface ResourceRecord {
  id: string;
  applicationId: string;
  provider: "github" | "vercel" | "cloudflare";
  resourceType: string;
  providerResourceId: string;
  desiredGeneration: number;
  lastObservedHash: string;
  ownershipFingerprint: string;
  status: ResourceStatus;
  firstSeenAt: string;
  lastSeenAt: string;
}
```

### 21.2 Operation record

```ts id="r5yqan"
interface OperationRecord {
  id: string;
  workflowId: string;
  applicationId: string;
  action:
    | "CREATE"
    | "UPDATE"
    | "REDEPLOY"
    | "VERIFY"
    | "PROMOTE"
    | "ROLLBACK"
    | "DELETE";

  status:
    | "QUEUED"
    | "RUNNING"
    | "RETRYING"
    | "SUCCEEDED"
    | "FAILED"
    | "BLOCKED"
    | "ROLLED_BACK";

  attempt: number;
  idempotencyKey: string;
  startedAt: string | null;
  completedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}
```

---

## 22. Status model

Application synchronization status:

```text id="mvf9j1"
SYNCED
OUT_OF_SYNC
RECONCILING
BLOCKED
UNKNOWN
DECOMMISSIONING
```

Application health status:

```text id="ta7drs"
HEALTHY
DEGRADED
UNHEALTHY
CHECKING
UNKNOWN
```

Deployment status:

```text id="qenqo0"
QUEUED
BUILDING
READY
ERROR
CANCELED
VERIFYING
STAGED
PROMOTING
CURRENT
REJECTED
ROLLED_BACK
```

Overall application state is displayed as two separate values:

```text id="qbnlqn"
Sync: OutOfSync
Health: Healthy
```

A manually changed but still-working application must not be described as synced. Likewise, a synced application with a failing health check must not be described as healthy.

---

## 23. Status dashboard

The dashboard is served through the Cloudflare control-plane Worker so it remains independent of the Vercel applications it manages.

Example:

```text id="hrhjog"
┌─────────────────────────────────────────────────────────────────────┐
│ Launchpad                                                           │
├────────────────┬────────────┬──────────┬────────────┬───────────────┤
│ Application    │ Sync       │ Health   │ Production │ Last change   │
├────────────────┼────────────┼──────────┼────────────┼───────────────┤
│ tokentest      │ Synced     │ Healthy  │ Current    │ 4 minutes ago │
│ portfolio      │ OutOfSync  │ Healthy  │ Current    │ 18 minutes    │
│ internal-docs  │ Synced     │ Degraded │ Current    │ 2 hours       │
└────────────────┴────────────┴──────────┴────────────┴───────────────┘
```

Application details include:

- Repository and current branch
- Vercel project
- Production URL
- Staging URL
- Latest preview deployments
- Current production deployment
- Previous known-good deployment
- Desired generation
- Observed generation
- Resource graph
- Current drift
- Last plan
- Last apply
- Workflow steps
- Health-check history
- DNS status
- Vercel verification status
- Proxy status
- Build logs
- Runtime errors
- Secret-reference status without secret values
- Open reconciliation PRs
- Decommission status
- Audit history

Dashboard actions do not directly mutate production by default.

Actions such as:

```text id="5isa1d"
Adopt drift
Restore desired state
Change root directory
Enable proxy
Decommission app
```

create a branch and pull request containing the required manifest changes.

Operational recovery actions may be direct when explicitly permitted:

```text id="5jlcue"
Retry failed step
Re-run health check
Roll back to known-good deployment
```

Every direct recovery action is audited.

---

## 24. Fail-loud requirements

The platform follows these rules:

### 24.1 No swallowed exceptions

Every provider call either:

- Returns a typed success result.
- Returns a typed retryable error.
- Returns a typed permanent error.
- Throws and terminates the current step.

No empty `catch` blocks are allowed.

### 24.2 No false-green workflows

A workflow fails when:

- Validation fails.
- Preview build fails.
- Preview health fails.
- Required DNS verification times out.
- Vercel verification fails.
- Production staging fails.
- Promotion fails.
- Production health fails.
- Rollback is required.
- Cleanup permanently fails.
- Provider state cannot be read reliably.
- An unsupported requested setting is found.

### 24.3 Error visibility

Final failure appears in:

- GitHub Actions result
- Workflow job summary
- PR comment
- GitHub Deployment status
- Launchpad dashboard
- D1 operation history
- Controller logs
- GitHub issue after retry exhaustion

### 24.4 Retry behavior

Retryable examples:

- HTTP 429
- Provider 5xx
- Temporary DNS propagation
- Temporary certificate issuance delay
- Vercel deployment still building
- Network timeout

Permanent examples:

- Repository inaccessible
- Invalid root directory
- Unsupported setting
- Duplicate domain
- Authentication failure
- Invalid secret reference
- Deletion policy violation
- Build failure
- Health assertion mismatch after all attempts

Cloudflare Workflows retries individual durable steps and resumes from completed steps. Failed queue messages can also be sent to a dead-letter queue rather than disappearing after retry exhaustion. ([developers.cloudflare.com](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/))

---

## 25. GitHub repository protection

The control repository’s `main` branch uses a GitHub ruleset.

Required settings:

```text id="463qay"
Require pull request before merging
Required approving reviews: 1
Require review from CODEOWNERS
Dismiss stale approvals after new commits
Require approval of latest reviewable push
Require all conversations resolved
Require status checks
Require branch to be up to date
Block force pushes
Restrict branch deletion
No direct pushes
No administrator bypass during normal operation
Squash merge only
```

Required checks:

```text id="8tdcx7"
platform / schema
platform / catalog
platform / provider-preflight
platform / plan
platform / preview
platform / health
```

GitHub rulesets can require pull requests, approvals, CODEOWNER review, successful status checks, and successful deployments before changes reach a protected branch. ([docs.github.com](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets))

### 25.1 CODEOWNERS

```text id="i8995h"
# All platform code
* @CarterLaSalle

# Catalog changes
/catalog/ @CarterLaSalle

# Schema and policy changes
/schema/ @CarterLaSalle
/packages/core/policy/ @CarterLaSalle

# Workflows and credentials surface
/.github/ @CarterLaSalle
/apps/controller/ @CarterLaSalle

# Protect CODEOWNERS itself
/.github/CODEOWNERS @CarterLaSalle
```

The CODEOWNERS file itself must be owned so a pull request cannot quietly remove the approval requirement. GitHub recommends protecting the CODEOWNERS file or its containing directory. ([docs.github.com](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners?ref=sector-geek))

### 25.2 Workflow permissions

Every workflow starts with:

```yaml id="8bk4fr"
permissions: {}
```

Each job receives only the permissions it requires.

Example plan job:

```yaml id="hj7qmy"
permissions:
  contents: read
  pull-requests: write
```

Example controller-authentication job:

```yaml id="g0y6ja"
permissions:
  contents: read
  id-token: write
```

Production-mutating credentials are not available to untrusted fork pull requests.

---

## 26. GitHub authentication without a custom GitHub App

### Within the control-repository workflow

Use `GITHUB_TOKEN` for:

- Reading repository content
- Updating its own PR comment
- Uploading artifacts
- Writing workflow summaries
- Creating deployments in the control repository when needed

### Cross-repository controller access

Use separate fine-grained PATs:

```text id="khdbce"
GH_CATALOG_READ_TOKEN
  Selected app repositories
  Metadata: read
  Contents: read

GH_APP_REPORT_TOKEN
  Selected app repositories
  Metadata: read
  Pull requests: write
  Issues: write
  Deployments: write

GH_ONBOARDING_TOKEN
  Selected app repositories
  Metadata: read
  Contents: write
  Pull requests: write
```

The onboarding token is optional after all repositories contain the reusable workflow.

No token receives repository administration or deletion permissions unless a concrete feature requires them.

### Limitation

Fine-grained PATs are tied to a user identity and require rotation. This is the main architectural compromise created by excluding a custom GitHub App.

---

## 27. Concurrency and locking

### GitHub Actions

Planning runs use:

```yaml id="yqrvc4"
concurrency:
  group: plan-${{ github.event.pull_request.number }}
  cancel-in-progress: true
```

New commits cancel obsolete PR plans.

Apply uses a serialized group:

```yaml id="cfg5pe"
concurrency:
  group: launchpad-production-apply
  queue: max
```

Production changes queue rather than canceling an in-progress apply. GitHub concurrency groups can serialize jobs and optionally queue pending deployments. ([docs.github.com](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency?apiVersion=2022-11-28))

### Controller locking

The controller acquires:

```text id="sg2lvj"
global apply lock
application lock
domain lock
```

The domain lock prevents two applications from racing to claim the same hostname.

All provider writes include idempotency keys when supported. Otherwise Launchpad checks current state before retrying.

---

## 28. Provider modularity

All providers implement contracts rather than leaking API-specific structures into the core engine.

```ts id="smjlg8"
interface ProjectProvider {
  getProject(input: ProjectIdentity): Promise<ObservedProject | null>;
  planProject(input: DesiredProject): Promise<ResourcePlan[]>;
  applyProject(input: DesiredProject): Promise<AppliedResource>;
  createDeployment(input: DeploymentRequest): Promise<Deployment>;
  getDeployment(input: DeploymentIdentity): Promise<Deployment>;
  promoteDeployment(input: PromotionRequest): Promise<PromotionResult>;
  rollbackDeployment(input: RollbackRequest): Promise<RollbackResult>;
}

interface DnsProvider {
  getRecord(input: DnsIdentity): Promise<ObservedDnsRecord | null>;
  planRecord(input: DesiredDnsRecord): Promise<ResourcePlan>;
  applyRecord(input: DesiredDnsRecord): Promise<AppliedResource>;
  verifyAuthoritativeDns(input: DnsVerification): Promise<VerificationResult>;
}
```

Future providers can be added without replacing the engine:

```text id="3x800u"
provider-cloudflare-pages
provider-vercel
provider-netlify
provider-docker-compose
provider-kubernetes
provider-aws-ecs
provider-fly
```

A future application might use:

```yaml id="nimaub"
deployment:
  provider: docker-compose
  target: phoenix-orin
```

while retaining the same catalog, plan, status, health, lifecycle, and reconciliation concepts.

---

## 29. CLI

The CLI exists for diagnostics and local development.

```bash id="kj68lq"
yarn platform validate
yarn platform plan
yarn platform plan --app tokentest
yarn platform status
yarn platform status --app tokentest
yarn platform graph tokentest
yarn platform health tokentest --environment preview
yarn platform reconcile tokentest --dry-run
yarn platform logs tokentest --latest
```

Normal users do not manually run:

```bash id="qi3nj4"
yarn platform apply
```

Production apply requires the protected GitHub workflow and controller-issued authorization context. Local `apply` is disabled unless an explicit development sandbox configuration is active.

---

## 30. Control-plane deployment

The controller and dashboard deploy to Cloudflare.

```text id="vf3f8w"
Cloudflare Worker
├── HTTP API
├── Dashboard assets
├── Vercel webhook endpoint
├── GitHub OIDC exchange endpoint
└── Operational endpoints

Cloudflare Workflows
├── ApplyApplicationWorkflow
├── PreviewApplicationWorkflow
├── ReconcileApplicationWorkflow
├── PromoteProductionWorkflow
├── RollbackProductionWorkflow
└── DecommissionApplicationWorkflow

Cloudflare D1
└── Persistent resource and operation state

Cloudflare Queues
├── provider-events
├── health-checks
└── dead-letter
```

The controller deployment itself follows a separate protected workflow:

```text id="nk7mxc"
Controller PR
        ↓
Tests and Wrangler dry run
        ↓
CODEOWNER approval
        ↓
Merge
        ↓
Deploy Worker version
        ↓
Run controller smoke test
        ↓
Promote Worker deployment
```

---

## 31. Testing requirements

### Unit tests

- Schema parsing
- Duplicate detection
- Dependency-cycle detection
- Diff classification
- Destructive-change classification
- Secret redaction
- Status calculation
- Lifecycle transitions
- Plan fingerprints
- Retry classification

### Provider contract tests

Each provider runs against recorded and sandbox responses for:

- Resource not found
- Authentication failure
- Rate limiting
- Partial provider response
- Changed API shape
- Duplicate resources
- Provider timeout
- Idempotent retry

### Integration tests

- Create preview project
- Connect test repository
- Deploy valid project
- Detect invalid root
- Detect failed Vercel build
- Attach temporary domain
- Create Cloudflare DNS
- Wait for verification
- Run health checks
- Promote deployment
- Roll back deployment
- Detect and report drift

### End-to-end test

A dedicated fixture repository proves:

```text id="pzul8g"
Catalog PR
→ plan comment
→ shadow Vercel preview
→ merge
→ real project
→ DNS
→ staging
→ staged production
→ promotion
→ health
→ drift
→ reconciliation PR
→ safe deletion
```

The release is not considered complete until this succeeds without manually editing Vercel or Cloudflare dashboards.

---

## 32. Deployment summary

Every apply ends with a GitHub Actions summary:

```markdown id="ar4dis"
# Launchpad Deployment Summary

## Result

✅ Application reconciled and deployed

## Application

- ID: `tokentest`
- Repository: `CarterLaSalle/tokentest`
- Commit: `a81f4c2`
- Desired generation: `14`
- Observed generation: `14`

## Vercel

- Project: `tokentest`
- Framework: `nextjs`
- Root directory: `apps/web`
- Staged deployment: `dpl_abc123`
- Promotion: succeeded
- Current deployment: `dpl_abc123`

## Domain

- Hostname: `tokentest.example.com`
- Cloudflare: DNS-only
- DNS: verified
- Vercel domain: verified
- TLS: ready

## Health

- Staged: passed
- Production: passed
- Response: `200`
- Latency: `184 ms`

## Recovery

- Rollback required: no

## Reconciliation

- Sync: `SYNCED`
- Health: `HEALTHY`
- Drift: none
```

---

## 33. Acceptance criteria

The integrated release is complete only when all of the following are true:

| Requirement | Expected result |
|---|---|
| Add a manifest | New application is provisioned |
| Change Vercel root | Preview build tests the new root |
| Invalid root | PR fails with clear error |
| Vercel build failure | GitHub check and comment fail loudly |
| Duplicate app ID | PR is blocked |
| Duplicate subdomain | PR is blocked |
| Missing private-repo access | PR is blocked |
| Unsupported setting | PR is blocked rather than ignored |
| Merge valid PR | Apply starts automatically |
| Provider state changed after approval | Apply stops and requests replan |
| DNS delayed | Workflow waits and retries |
| DNS permanently invalid | Workflow fails loudly |
| Staged build unhealthy | Production is not promoted |
| Production unhealthy after promotion | Previous known-good deployment is restored |
| Manual Vercel change | Drift appears in dashboard |
| Drift persists | Reconciliation PR is opened |
| Remove app file | Normal apply refuses deletion |
| Proper decommission flow | Resources are safely deleted |
| Controller crashes during apply | Workflow resumes from last durable step |
| Retry limit exhausted | Error goes to DLQ and creates an issue |
| PR superseded | Old shadow preview is cleaned up |
| Direct push to main | GitHub ruleset rejects it |
| Missing CODEOWNER approval | Merge is blocked |

---

## 34. Final operating experience

### Adding an application

```text id="58tvrk"
Create catalog/apps/tokentest.yaml
        ↓
Open pull request
        ↓
Automatic validation, plan, and real Vercel preview
        ↓
Review the diff and preview
        ↓
CODEOWNER approves
        ↓
Merge
        ↓
Automatic apply, DNS, verification, health, and promotion
```

### Changing application configuration

```text id="xpp3nv"
Edit framework, root, commands, domain, proxy, or environment settings
        ↓
Open pull request
        ↓
See exact provider diff and downstream redeployments
        ↓
Test proposed configuration through shadow preview
        ↓
Merge
        ↓
Automatic safe rollout
```

### Deploying application code

```text id="y8smcp"
Open PR in application repository
        ↓
Vercel preview build
        ↓
Launchpad preview gate and health check
        ↓
Merge to main
        ↓
Staged production deployment
        ↓
Health verification
        ↓
Exact-build promotion
```

### Handling manual drift

```text id="2wn0be"
Someone changes Vercel or Cloudflare manually
        ↓
Scheduled reconciliation detects it
        ↓
Dashboard becomes OutOfSync
        ↓
Launchpad opens reconciliation PR
        ↓
Review restore-versus-adopt decision
        ↓
Merge
        ↓
Desired and observed state converge
```

This gives the system the useful parts of ArgoCD and Kubernetes controllers—desired state, plans, reconciliation, health, promotion, rollback, resource tracking, and visible status—without requiring ECR, EKS, Kubernetes, Helm, or ArgoCD.
