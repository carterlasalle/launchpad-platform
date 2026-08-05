# Controller rollback

Purpose: restore the last known-good Worker version without losing durable
workflow state or D1 history.

## Detection

- The deploy workflow succeeded but the controller misbehaves (smoke check
  failure is caught by the workflow; runtime errors appear in Cloudflare
  logs), or a released change regresses apply/preview/reconcile behavior.
- Identify the failing Worker version and the last known-good version:
  `yarn wrangler versions list --env production`

## Containment

- Stop new controller deployments (disable the `launchpad-control-plane`
  environment protection rule or the deploy workflow).
- Preserve D1 state; do not reset or delete operation history or audit rows.

## Recovery

1. Promote the last known-good Worker version:
   `yarn wrangler rollback <version-id> --env production`
   (or re-deploy the known-good version through the release workflow).
2. Run the smoke suite against the restored version:
   `yarn platform controller-smoke --controller "$LAUNCHPAD_CONTROLLER_URL"`
   `curl -sS "$LAUNCHPAD_CONTROLLER_URL/healthz"`
   `curl -sS "$LAUNCHPAD_CONTROLLER_URL/v1/applications" -H "Authorization: Bearer $LAUNCHPAD_OPERATOR_TOKEN"`
3. Verify the security boundaries still reject bad input:
   - OIDC rejection: `POST "$LAUNCHPAD_CONTROLLER_URL/v1/plans/verify"` with
     no token returns 401.
   - Webhook signature rejection: `POST "$LAUNCHPAD_CONTROLLER_URL/webhooks/vercel"`
     without a valid `x-vercel-signature` returns 401.
   - Operator rejection: a `GET /v1/applications` without a bearer token
     returns 401.
4. Verify idempotency: replay an apply/preview request with the same
   idempotency key and confirm the same operation is returned (no duplicate
   workflow).
5. Resume durable operations only after workflow state and locks are
   readable (D1 `workflow_runs`/`workflow_steps` intact; Workflows instances
   resume from completed steps).

## Validation

- The deployed version id matches the chosen known-good; smoke, OIDC,
  webhook, operator-auth, and idempotency checks all pass.
- D1 observability state is intact after the rollback: incident rows,
  provider-error rows, and metric snapshots are still queryable
  (`SELECT type, count(*) FROM incidents GROUP BY type`).
- `yarn platform controller-smoke --controller "$LAUNCHPAD_CONTROLLER_URL"` exits 0.

## Escalation

- Open a corrective PR with the failing fixture and rollback evidence; if
  D1 schema and Worker code are incompatible, follow the D1 migration
  runbook before redeploying.
