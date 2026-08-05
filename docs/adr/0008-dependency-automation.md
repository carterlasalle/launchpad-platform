# ADR-0008: Automated dependency updates through reviewed PRs

- Status: Accepted
- Date: 2026-08-04

## Context

NFR-MNT-005 requires dependency updates to be automated through reviewed
PRs; section 28.3 (supply chain) requires a lockfile, immutable installs,
dependency review, SHA-pinned third-party Actions, and build provenance and
SBOM for controller releases. The master plan names Renovate as the
version-update automation.

## Decision

- Renovate (hosted GitHub App, configured in `renovate.json`) opens
  dependency update PRs against `main` for npm/Yarn, Corepack-managed
  toolchain versions, and GitHub Action pins. PRs carry the `dependencies`
  label, are assigned/reviewed through CODEOWNERS, and pass the normal
  protected-branch gates.
- Node updates stay on the 24 LTS line; exact patch changes to Node/Yarn
  must also update the ADR-0007 decision record and are verified by
  `scripts/check-toolchain.mjs`.
- `actions/dependency-review-action` (`.github/workflows/dependency-review.yml`)
  fails PRs that introduce high-severity vulnerabilities, and dependency
  review is a required status check on protected `main`.
- Every third-party Action in production workflows is pinned to an immutable
  40-hex commit SHA; `scripts/check-workflows.mjs` enforces this and top-level
  `permissions: {}` in CI and the release gate. Renovate keeps the pinned
  digests current.
- Controller releases generate a CycloneDX SBOM of the exact lockfile
  dependency graph plus pinned Actions (`scripts/generate-sbom.mjs`), upload
  it as a workflow artifact, and attest build provenance with
  `actions/attest-build-provenance` before `wrangler deploy`. Deployment
  only uses reviewed artifacts from the protected commit
  (`git merge-base --is-ancestor` check in `deploy-control-plane.yml`).

## Consequences

- Dependency churn arrives as small, reviewable PRs with CI evidence, never
  as silent lockfile edits.
- A stale lockfile, an unpinned Action, or a missing attestation fails CI or
  the production release rather than shipping.

## Compliance

- `renovate.json` — automation policy.
- `.github/workflows/dependency-review.yml` — vulnerability gate.
- `scripts/check-workflows.mjs`, `scripts/check-toolchain.mjs` — executable
  static checks.
- `scripts/generate-sbom.mjs` + `deploy-control-plane.yml` — SBOM and
  provenance in every controller release.
