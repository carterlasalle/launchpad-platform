# Launchpad release checklist

## Code quality

- `yarn install --immutable` succeeds.
- `yarn typecheck`, `yarn lint`, `yarn test`, and `yarn build` succeed.
- Dependency and action-SHA review is complete.

## Safety

- Direct pushes to `main` are rejected.
- CODEOWNER approval is required for catalog, schema, workflow, controller, and policy paths.
- Normal apply blocks `DESTROY` before provider writes.
- Stale plan fingerprints block apply.
- Secret-canary scan is clean.

## Reliability

- Durable workflow interruption/resume test passes.
- Retry exhaustion reaches the DLQ and creates visible failure state.
- Application and domain lock recovery is tested.

## Deployment correctness

- Invalid-root preview fails with bounded Vercel log output.
- Candidate health blocks promotion.
- Exact commit promotion is verified.
- Post-promotion failure restores known-good and leaves release red.

## Reconciliation and deletion

- Manual drift produces one reconciliation PR per fingerprint.
- Restore and adopt paths are reviewable.
- Provider read failure reports `UNKNOWN`/`BLOCKED`.
- Manifest removal does not delete resources.
- Approved deletion validates token, cooling-off, dependencies, export, teardown, and tombstone.

## Operations

- Dashboard reads from D1 and separates sync, health, deployment, and operation state.
- All outage, credential, migration, lock, DLQ, promotion, rollback, provider-schema, break-glass, controller, and secret-provider runbooks are reviewed.
- Alerts for DLQ, reconciliation failure, credential expiry, and controller error rate are tested.
