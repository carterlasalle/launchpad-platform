# ADR-0006: Staged production promotion

- Status: Accepted
- Date: 2026-08-04

## Context

Production must never be promoted to an untested rebuild. Requirements
TR-DEP-001..006 bind deployments to project, environment, repository, commit
SHA, and desired generation, and require health verification both pre- and
post-promotion, with rollback to a previously recorded known-good deployment.

## Decision

- Production receives verified staged builds: a candidate deployment is
  created against the intended commit and configuration, health-checked
  before promotion, and only then assigned production domains.
- Identity is re-verified immediately before promotion: project,
  environment, commit SHA, and desired generation must match the approved
  plan; promotion never trusts a deployment name alone.
- A previous deployment is recorded as known-good only after post-promotion
  health succeeds (TR-DEP-005); rollback targets a deployment previously
  recorded as known-good for the same project and environment (TR-DEP-006).
- Post-promotion health failure triggers rollback and leaves the release
  operation failed (fail loud, PRD-APL-008).
- The operator-facing health check is
  `yarn platform health --catalog catalog --app <application-id> --environment production --sha <merged-commit-sha> --url 'https://<production-hostname>'`,
  which exercises the production domain over HTTPS.

## Consequences

- Promotion is the only path to production aliases, and it is gated on
  build state, staged health, identity, and post-promotion health.
- Rollback is bounded to previously verified deployments, so it cannot target
  an arbitrary deployment.

## Compliance

- `workflows/src/promote-production.ts` and `workflows/src/rollback-production.ts`
  implement the promotion/rollback steps.
- `workflows/src/apply-app.ts` records known-good state and keeps the release
  red on failure.
- `docs/runbooks/promotion.md` and `docs/runbooks/rollback.md` operationalize
  detection, containment, recovery, validation, and escalation.
