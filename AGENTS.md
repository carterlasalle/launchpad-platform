# AGENTS.md

Repository-specific instructions for coding agents working on Launchpad. These rules apply to the entire repository unless a more specific `AGENTS.md` exists below the file being changed.

## Mission

Launchpad is a Git-driven control plane for Vercel applications and Cloudflare DNS. The implementation must preserve these invariants:

1. Git is the only normal desired-state source.
2. Pull requests are the normal production-change path.
3. Plans are read-only, deterministic, redacted, and bound to exact reviewed inputs.
4. Provider writes are idempotent, owned, durably recorded, and safe to resume.
5. Normal apply never destroys resources.
6. Production is promoted only after candidate health, DNS, domain, and TLS gates pass.
7. Drift becomes visible and reviewable; it is not silently overwritten.
8. Secret values never enter Git, D1, logs, comments, artifacts, or error details.
9. Provider behavior stays behind `packages/provider-contract` interfaces.
10. Failures remain typed, durable, actionable, and visible.

The normative product and engineering contract is [docs/Launchpad_Unified_GitOps_Master_Plan.md](docs/Launchpad_Unified_GitOps_Master_Plan.md). Read the relevant requirements and [ADRs](docs/adr/README.md) before changing behavior.

## Toolchain

Use the pinned toolchain. Do not upgrade it incidentally.

- Node.js: `24.18.0`
- Yarn: `4.10.3`
- Package manager: Yarn workspaces through Corepack
- TypeScript: strict, ESM
- Tests: Vitest
- Worker tooling: Wrangler

```bash
corepack enable
yarn install --immutable
node scripts/check-toolchain.mjs
```

Never use `npm install`, `pnpm install`, or `bun install`. Do not hand-edit `yarn.lock`.

## Repository map

| Path | Responsibility |
|---|---|
| `apps/cli/` | Catalog, plan, preview, apply, status, health, and operator commands |
| `apps/controller/` | Worker API, OIDC/operator auth, webhooks, queue consumers, dashboard routing |
| `apps/dashboard/` | Framework-free authenticated operator UI |
| `packages/catalog/` | YAML/schema loading, normalization, source locations, semantic validation |
| `packages/core/` | Domain types, resource graph, diff, policy, planning, canonical fingerprints |
| `packages/database/` | Persistence interface, D1 implementation, in-memory test implementation |
| `packages/provider-contract/` | Provider-neutral reads, writes, capability matrices, typed errors |
| `packages/provider-*/` | GitHub, Vercel, Cloudflare, and secret-provider adapters |
| `packages/github-reporting/` | Sticky PR reports, bounded artifacts, GitHub deployment reporting |
| `packages/health/` | Independent HTTP health-check engine |
| `workflows/` | Durable apply, preview, app-preview, reconcile, and decommission state machines |
| `migrations/d1/` | Forward-only D1 migrations |
| `catalog/` | Desired applications, defaults, environments, and zone registry |
| `.github/workflows/` | PR gates, apply, reconcile, decommission, dependency review, release deployment |
| `tests/` | Unit, contract, integration, security, end-to-end, and opt-in live acceptance |
| `docs/` | Master plan, guides, ADRs, runbooks, and release readiness |

## Working method

1. Identify the requirement and existing implementation path.
2. Reuse the existing domain type, provider contract, error taxonomy, and persistence pattern. Do not introduce a parallel convention.
3. For behavior changes or bug fixes, write a failing test that demonstrates the observable contract before implementation.
4. Make the smallest complete source fix. Update every caller and remove only code made obsolete by the change.
5. Run the narrow test first, then the relevant package/workflow checks.
6. Run the full release checks before declaring a cross-cutting change complete.
7. Update docs when the operator, contributor, deployment, schema, or security contract changed.

Do not deploy, activate a GitHub ruleset, mutate provider resources, run live acceptance, or send external messages unless the user explicitly authorizes that exact external action and target.

## Change-specific verification

| Change | Minimum checks |
|---|---|
| Catalog/schema | `yarn platform validate --catalog catalog`; relevant `packages/catalog` tests |
| Planner/domain | `yarn typecheck`; relevant `packages/core` tests; deterministic plan assertions |
| Provider adapter | Adapter tests plus shared tests under `packages/provider-testkit`; negative provider responses |
| D1/repository | Migration contract tests; in-memory and D1 repository parity tests |
| Durable workflow | Workflow unit test plus the relevant integration/end-to-end scenario |
| Controller API/auth | Controller tests, OIDC/webhook negative paths, and `yarn typecheck` |
| Dashboard UI | DOM tests, build, then exercise the changed page through the local Worker |
| GitHub workflow | `node scripts/check-workflows.mjs`; `tests/security/workflow-security.test.ts` |
| Wrangler/deploy config | `tests/unit/deploy-bindings.test.ts`; Wrangler dry-run where identifiers are available |
| Documentation | `yarn docs:check` |
| Cross-cutting/release | `yarn typecheck && yarn lint && yarn test && yarn build && yarn acceptance:offline` |

Tests must defend behavior, boundaries, state transitions, precedence, or real failure modes. Do not test incidental source text unless the source file itself is the configuration contract.

## Domain and planner rules

- Canonicalize before hashing or semantic comparison.
- Preserve source file, line, column, and field path for catalog errors.
- Unknown or unsupported settings fail closed; they are never ignored.
- Use stable provider IDs and ownership evidence. Ambiguous ownership yields `BLOCKED`.
- Plans must not write to providers.
- Every operation requires a deterministic operation ID and idempotency key.
- Any input that changes plan semantics must change the fingerprint, except intentionally source-commit-neutral review fingerprints used to validate squash-merged equivalence.
- Do not include timestamps, provider ordering, raw secrets, or volatile response fields in deterministic fingerprints.
- A missing provider field is a malformed provider response, not an invitation to guess.

## Provider and workflow rules

- Keep SDK imports inside provider adapters. Core packages must depend only on provider contracts.
- Read methods must distinguish not-found, inaccessible, forbidden, transient, malformed, and unsupported outcomes.
- Mutation methods return observed postcondition state, not merely an accepted API response.
- Retry only typed retryable failures. Backoff must be bounded.
- Persist step start, attempt, result, and error state before crossing durable boundaries.
- Hold application and domain locks around relevant writes.
- Re-read provider state before declaring a postcondition successful.
- Never catch an error and continue with success, an empty value, or `SYNCED`.
- Webhook payloads are triggers, never final provider state.
- Queue messages must be versioned, bounded, idempotent, and acknowledged only after durable dispatch or durable incident recording.

## Lifecycle rules

- Manifest disappearance is `BLOCKED_MISSING_MANIFEST`, not a deletion request.
- `active -> decommissioning -> approved-for-deletion -> deleted` is the normal state machine.
- Deletion requires the reviewed lifecycle transition, elapsed cooling-off period, dependency checks, exact single-use approval token, and dedicated destroy workflow.
- Ordered teardown and tombstone/audit persistence must remain resumable after partial failure.
- Do not add destroy behavior to ordinary apply or reconciliation.

## Security rules

- Use `SensitiveValue` and structured redaction helpers; never log secret-bearing objects.
- Secrets must be references in manifests and typed Secret Store bindings in the Worker.
- Keep GitHub, Vercel, Cloudflare, ruleset, operator, webhook, and deployment credentials purpose-separated.
- OIDC validation must verify signature, issuer, audience, expiration, repository ID, owner ID, workflow ref, event, PR/commit binding, and allowlists where configured.
- Dashboard mutation routes require authenticated operator identity; never expose provider tokens to browser code.
- Workflow defaults remain `permissions: {}` and grant only job-level permissions.
- Pin third-party GitHub Actions to immutable 40-character commit SHAs.
- Fork pull requests must never receive production provider credentials or controller OIDC access.
- Bound provider error excerpts, sticky comments, artifacts, and audit details before persistence or publication.

## Database and migration rules

- D1 migrations are forward-only and ordered numerically.
- Never edit an already released migration. Add the next migration.
- Every table that stores operational state needs explicit ownership, timestamps, and bounded query paths as appropriate.
- Audit events are append-only after insertion.
- Secret values are prohibited from every column.
- Keep the in-memory repository behavior aligned with D1; contract tests cover both implementations.

## GitHub and release rules

- `main` is protected by the desired ruleset in `.github/rulesets/main.json`.
- Normal changes use pull requests, CODEOWNER approval, current required checks, and squash merge.
- `LAUNCHPAD_CONTROL_PLANE_ENABLED` must remain absent or false until the complete deployment guide and live release gates pass.
- Production workflow changes must preserve the ruleset gate, protected-commit provenance, immutable install, binding assertions, D1 migrations, SBOM/provenance, deploy, and smoke check sequence.
- Live tests must use dedicated sandbox resources matching `LP_LIVE_SANDBOX_PREFIX`; never point them at production resources.
- Do not claim live provider acceptance from mocks, local tests, dry runs, or a skipped live suite.

## Documentation rules

- Keep [README.md](README.md) concise and task-oriented; route detail into [docs/README.md](docs/README.md).
- Update the relevant guide or runbook in the same change as an operator-visible contract.
- Every document under `docs/` must be reachable from a root documentation entrypoint.
- Run `yarn docs:check` to catch missing files and broken local links.
- Do not paste secrets, real account IDs, live deletion tokens, or private incident data into examples.
- Use exact commands that exist in `package.json`, Wrangler, or the CLI. Mark credential-dependent and destructive commands clearly.

## Generated and local files

Do not commit build output, coverage, local Wrangler state, rendered deploy configs, artifacts, or local credentials. In particular:

```text
dist/
coverage/
artifacts/
.wrangler/
wrangler.deploy.json
.env
```

When uncertain, prefer the fail-closed behavior already established by the master plan and ask before changing a security, lifecycle, provider-mutation, or production-release contract.
