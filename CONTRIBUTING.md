# Contributing to Launchpad

Launchpad is a production control plane. Small changes can affect repository protection, provider resources, DNS, deployment promotion, or deletion safety. Contributions are welcome when they preserve the platform invariants and include evidence for the behavior they change.

Read [AGENTS.md](AGENTS.md) for repository-specific engineering rules and the [Unified GitOps Master Plan](docs/Launchpad_Unified_GitOps_Master_Plan.md) for normative requirements.

## Development setup

### Prerequisites

- Git
- Node.js `24.18.0`
- Corepack

The repository pins Yarn `4.10.3` in `package.json`.

```bash
git clone https://github.com/carterlasalle/launchpad-platform.git
cd launchpad-platform
corepack enable
yarn install --immutable
node scripts/check-toolchain.mjs
```

Confirm the baseline before editing:

```bash
yarn typecheck
yarn lint
yarn test
yarn build
yarn docs:check
```

See the [getting-started guide](docs/guides/getting-started.md) for local D1 and Worker instructions.

## Branch and commit workflow

1. Start from current `main`.
2. Create a focused branch such as `feat/catalog-policy` or `fix/preview-timeout`.
3. Keep each commit coherent and independently reviewable.
4. Use an imperative subject with a conventional prefix used by this repository: `feat:`, `fix:`, `test:`, `docs:`, `chore:`, or `refactor:`.
5. Push the branch and open a pull request. Do not push directly to `main`.

The repository is squash-merge-only. Pull requests require current status checks, resolved review threads, an approval of the latest reviewable push, and CODEOWNER review for protected paths.

Required contexts are published for every pull request so GitHub never leaves
a path-filtered check pending. Their work is scoped: documentation-only
changes run link validation, non-documentation changes run static/build/test
checks, catalog-impacting changes run provider plan/preview/health gates, and
package-manifest or lockfile changes run the dependency audit. A failed scope
classifier fails its required aggregate; it never becomes a skipped green
check.

## Making a change

### Behavior changes and bug fixes

Write a failing test for the observable contract first. Then make the smallest complete fix and show the test passing. Prefer an existing test layer:

- `packages/*/src/*.test.ts` for package behavior
- `tests/contract/` for provider and persistence interfaces
- `tests/integration/` for multi-component flows
- `tests/security/` for trust boundaries and workflow security
- `tests/end-to-end/acceptance.test.ts` for release acceptance scenarios
- `tests/end-to-end/live-acceptance.test.ts` only for explicitly authorized sandbox-provider verification

Do not add tests that merely search implementation source, duplicate type checking, or lock in incidental formatting. Configuration files such as GitHub workflows, rulesets, and Wrangler bindings are observable contracts and may be tested structurally.

### Catalog and schema changes

- Keep `schema/app.schema.json`, catalog types, loader, canonicalization, semantic validation, fixtures, and documentation aligned.
- Unknown fields must continue to fail.
- Preserve file/line/column/field-path diagnostics.
- Validate both positive and negative examples.

```bash
yarn platform validate --catalog catalog
yarn vitest run packages/catalog
```

### Provider changes

- Extend `packages/provider-contract` before provider-specific implementations when the public contract changes.
- Update every provider adapter and the shared contract-test harness.
- Cover not-found, inaccessible, authorization, transient, rate-limited, malformed, timeout, and unsupported outcomes where applicable.
- Verify mutations through observed postconditions.

### Workflow and controller changes

- Preserve idempotency, durable step boundaries, operation/domain locks, bounded retries, and typed terminal failures.
- Test interruption and replay, not only the happy path.
- For GitHub Actions changes, preserve `permissions: {}` defaults and immutable action pins.

```bash
node scripts/check-workflows.mjs
yarn vitest run tests/security/workflow-security.test.ts
yarn typecheck
```

### Database changes

Add the next numbered file under `migrations/d1/`; never rewrite a released migration. Update D1 and in-memory repository implementations together and run migration and contract tests.

```bash
yarn vitest run tests/contract/migrations.test.ts packages/database
```

### Documentation changes

Keep task-oriented information in guides and incident procedures in runbooks. Link every new document from [docs/README.md](docs/README.md), a guide index, or the runbook index.

```bash
yarn docs:check
```

## Verification matrix

Run the narrowest relevant check while iterating. Before requesting review for a cross-cutting change, run:

```bash
yarn typecheck
yarn lint
yarn test
yarn build
yarn acceptance:offline
yarn docs:check
```

`yarn acceptance:offline` is deterministic and does not prove live provider behavior. The live suite is opt-in, credential-dependent, and refuses resources that do not match its dedicated sandbox prefix. Follow the [deployment guide](docs/guides/deployment.md) and [release checklist](docs/release-checklist.md); never run live acceptance against production.

## Pull request checklist

A review-ready pull request should state:

- the problem and requirement being satisfied;
- the design decision and relevant invariants;
- files and public contracts changed;
- the failing test or reproduction observed before the fix, when applicable;
- exact verification commands and results;
- provider, migration, rollout, or rollback implications;
- documentation updated;
- anything intentionally not verified, especially credential-gated live acceptance.

Before requesting review:

- [ ] The diff contains only changes needed for the stated goal.
- [ ] Exported symbols and callers are updated together.
- [ ] No plaintext secret, live identifier, credential, or sensitive provider response is present.
- [ ] Required tests fail for a plausible regression and pass after the change.
- [ ] Typecheck, lint, tests, build, and documentation checks pass at the appropriate scope.
- [ ] Workflow actions remain SHA-pinned and least-privileged.
- [ ] New migration files are forward-only.
- [ ] Operator-visible behavior has a guide or runbook update.
- [ ] Destructive or external actions were not performed without explicit authorization.

## Security and operational issues

Do not disclose credentials, secret values, deletion approval tokens, private provider payloads, or sensitive incident data in a public issue or pull request. Revoke exposed credentials immediately and follow the [credential rotation runbook](docs/runbooks/credentials.md).

For outages and operational recovery, start at the [runbook index](docs/runbooks/README.md). For a security-sensitive change, document the trust boundary, authorization path, redaction behavior, negative tests, and rollback plan in the pull request.
