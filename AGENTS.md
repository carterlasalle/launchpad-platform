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

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **launchpad-platform** (4907 symbols, 13679 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? `npx gitnexus analyze` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows. For regression review, compare against the default branch: `detect_changes({scope: "compare", base_ref: "main"})`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method without first running `impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit changes without running `detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/launchpad-platform/context` | Codebase overview, check index freshness |
| `gitnexus://repo/launchpad-platform/clusters` | All functional areas |
| `gitnexus://repo/launchpad-platform/processes` | All execution flows |
| `gitnexus://repo/launchpad-platform/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:970c3bf2 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   bd dolt push
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->

<!-- BEGIN BEADS CODEX SETUP: generated by bd setup codex -->
## Beads Issue Tracker

Use Beads (`bd`) for durable task tracking in repositories that include it. Use the `beads` skill at `.agents/skills/beads/SKILL.md` (project install) or `~/.agents/skills/beads/SKILL.md` (global install) for Beads workflow guidance, then use the `bd` CLI for issue operations.

### Quick Reference

```bash
bd ready                # Find available work
bd show <id>            # View issue details
bd update <id> --claim  # Claim work
bd close <id>           # Complete work
bd prime                # Refresh Beads context
```

### Rules

- Use `bd` for all task tracking; do not create markdown TODO lists.
- Run `bd prime` when Beads context is missing or stale. Codex 0.129.0+ can load Beads context automatically through native hooks; use `/hooks` to inspect or toggle them.
- Keep persistent project memory in Beads via `bd remember`; do not create ad hoc memory files.

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.
<!-- END BEADS CODEX SETUP -->
