# ADR-0005: Open-PR reconciliation default

- Status: Accepted
- Date: 2026-08-04

## Context

Drift between Git desired state and live provider state is inevitable.
Launchpad must detect it continuously, surface it, and resolve it without
silently overwriting manual changes or destroying resources (TR-REC-001..006).

## Decision

- Reconciliation runs from the latest protected `main` commit, on the
  30-minute schedule in `reconcile.yml` and through the
  `reconcile-application` workflow.
- Drift is identified by stable fingerprints; one open reconciliation PR per
  application and fingerprint is maintained (`reconciliation_requests`).
- The default resolution mode is `open-pr`: a reviewable PR offers either
  restore-desired-state or adopt-observed-state, and normal plan, preview,
  review, and approval gates remain in force.
- Reconciliation never automatically destroys resources; loss of provider
  access is represented as `UNKNOWN`/`BLOCKED`, never `SYNCED` (TR-REC-006).
- `yarn platform reconcile --catalog catalog --dry-run` performs a read-only
  check; the write path goes through the controller
  (`POST /v1/cli/reconcile`).

## Consequences

- Every drift resolution is auditable and reviewable; nothing is auto-applied
  outside the protected-branch gate.
- Reconciliation PR traffic is bounded by fingerprint deduplication.

## Compliance

- `workflows/src/reconcile-app.ts` implements restore/adopt modes.
- `reconcile.yml` schedules the run; `packages/database` records
  `reconciliation_requests` and `drift_events`.
- `docs/runbooks/promotion.md` and `docs/runbooks/rollback.md` describe the
  operational recovery paths that keep reconciliation as the desired-state
  source.
