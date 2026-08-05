# Failed production promotion

Purpose: never promote by deployment name alone; identity, build state, and
staged health must be proven before production aliases change.

## Detection

- The apply workflow (`apply.yml`) or the controller's `apply-application`
  workflow fails at the promotion step; the release is red.
- Confirm candidate identity (project, environment, commit SHA, desired
  generation, lock ownership):
  `curl -sS "$LAUNCHPAD_CONTROLLER_URL/v1/applications/<id>/operations" -H "Authorization: Bearer $LAUNCHPAD_OPERATOR_TOKEN"`
  `yarn wrangler d1 execute launchpad --remote --command "SELECT id, project_id, environment, repository, commit_sha, desired_generation, state FROM deployments WHERE application_id = '<id>' ORDER BY created_at DESC LIMIT 5"`

## Containment

- If identity does not match the approved plan (commit SHA or desired
  generation differs), stop and replan; never promote by deployment name
  alone.
- Do not change aliases while the failure is under investigation.

## Recovery

- If promotion failed before the alias change, keep the prior production
  deployment and retry only the failed provider step with the original
  idempotency key:
  `curl -sS -X POST "$LAUNCHPAD_CONTROLLER_URL/v1/applications/<id>/actions/retry" -H "Authorization: Bearer $LAUNCHPAD_OPERATOR_TOKEN" -H "Idempotency-Key: <original-key>"`
- If the alias already changed, run the production health suite; on failure
  follow the rollback runbook immediately.
- Generate a fresh candidate instead of re-promoting a stale build:
  merge the corrected manifest and let apply stage a new candidate.

## Validation

- Staged health passed for the candidate before promotion:
  `yarn platform health --catalog catalog --app <application-id> --environment staging --sha <merged-commit-sha> --url 'https://<candidate-hostname>'`.
- After promotion,
  `yarn platform health --catalog catalog --app <application-id> --environment production --sha <merged-commit-sha> --url 'https://<production-hostname>'`
  passes against the production domain.
- The deployment/promotion records show the exact intended commit:
  `yarn wrangler d1 execute launchpad --remote --command "SELECT deployment_id, previous_deployment_id, result, promoted_at FROM deployment_promotions WHERE application_id = '<id>' ORDER BY promoted_at DESC LIMIT 5"`

## Escalation

- Keep the release operation red even when availability is restored (fail
  loud). Open an incident with candidate identity, the failed step, health
  evidence, and the promotion records.
