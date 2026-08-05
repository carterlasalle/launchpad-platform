# ADR-0007: Node.js and Yarn toolchain pinning

- Status: Accepted
- Date: 2026-08-04

## Context

Section 12.3 of the master plan requires the exact Node.js and Yarn patch
versions to be captured in a dependency decision record and updated only
through reviewed dependency PRs. CI must be immutable: installs must not
silently change the dependency graph.

## Decision

<!-- toolchain: node=24.18.0 yarn=4.10.3 immutable-installs=true -->

- Node.js is pinned to the exact patch `24.18.0` (Node 24 LTS line) in:
  - `.node-version` and `.nvmrc`
  - `package.json` `engines.node` (`>=24.18.0 <25`)
  - CI via `actions/setup-node` with `node-version-file: .node-version`
- Yarn is pinned to the exact version `4.10.3` through Corepack in
  `package.json` `packageManager` (`yarn@4.10.3`); no globally installed
  Yarn binary is assumed.
- Installs are immutable: `.yarnrc.yml` sets `enableImmutableInstalls: true`
  and the composite action runs `yarn install --immutable`; a stale
  `yarn.lock` fails CI. No workflow uses `npm install`, `pnpm`, or Bun.
- `scripts/check-toolchain.mjs` machine-verifies that the decision record
  marker above, all pin files, the running Node/Yarn versions, and the
  immutable-install setting agree. It runs in CI
  (`.github/workflows/ci.yml`) and in the production release gate
  (`.github/workflows/deploy-control-plane.yml`).
- Any change to these versions happens only through a reviewed dependency PR
  (Renovate, ADR-0008) that updates the marker, the pin files, and the
  lockfile together; CODEOWNERS owns the toolchain paths.

## Consequences

- Reproducible toolchains for CI, releases, and local development.
- Version bumps are explicit, reviewable, and verified against the decision
  record instead of drifting silently.

## Compliance

- `scripts/check-toolchain.mjs` is the executable check.
- `ci.yml` and `deploy-control-plane.yml` run it on every relevant change and
  before every production release.
