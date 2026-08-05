# ADR-0004: Git as the desired state

- Status: Accepted
- Date: 2026-08-04

## Context

Launchpad's governing principle is that Git is the desired-state source of
truth: application manifests under `catalog/apps/` declare what production
should look like, and pull requests are the only normal path to production
configuration changes.

## Decision

- The catalog (`catalog/apps/`, `catalog/defaults.yaml`,
  `catalog/environments.yaml`) is the authoritative desired state; dashboard
  and direct operator actions never mutate provider configuration outside a
  reviewed change.
- Every catalog PR receives schema, catalog, preflight, plan, preview, and
  health validation (`validate-plan.yml`), a deterministic plan fingerprint,
  and a sticky PR comment.
- Merge to protected `main` triggers automatic apply (`apply.yml`); apply
  revalidates the merged SHA and the live plan fingerprint and stops when the
  approved plan is stale (TR-APL-002, TR-APL-003).
- Destructive changes require the explicit decommissioning workflow and a
  single-use approval token; manifest removal alone never deletes resources
  (TR-LIFE-001).

## Consequences

- All production-affecting configuration is reviewable, revertible, and
  auditable through ordinary Git history.
- Manual provider changes become drift, detected and surfaced as
  reconciliation PRs (ADR-0005), never silently adopted.

## Compliance

- `catalog/` + `validate-plan.yml` + `apply.yml` implement the review/apply
  path.
- `packages/catalog` enforces unknown-field rejection and deterministic
  loading.
- `packages/core` plan fingerprints and `workflows/src/apply-app.ts` enforce
  stale-plan protection.
