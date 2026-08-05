# GitHub API outage

Purpose: never apply or report state from cached GitHub data while the GitHub
API is unavailable; repository and review state is unknown during the outage.

## Detection

- Workflow runs fail at `actions/checkout` or at ruleset verification; the
  ruleset verifier reports unavailability (exit 2):
  `LAUNCHPAD_RULESET_TOKEN=<token> GITHUB_REPOSITORY=carterlasalle/launchpad-platform node scripts/verify-ruleset.mjs`
- `yarn platform preflight --catalog catalog` fails on the GitHub repository
  check while other providers pass.
- Check the GitHub status page; confirm whether the outage affects the API,
  webhooks, or Actions only.

## Containment

- Leave merged-main apply and reconciliation operations queued until
  repository identity and commit state can be revalidated; do not cancel
  durable controller workflows.
- Preserve existing Vercel production state. Do not use direct provider
  mutation as a bypass.
- Do not report `SYNCED` for any application whose repository reads failed;
  the state stays `UNKNOWN`/`BLOCKED`.

## Recovery

- When GitHub recovers, rerun the full verification chain against the merged
  SHA:
  `yarn platform validate --catalog catalog`
  `yarn platform preflight --catalog catalog`
  `yarn platform plan --catalog catalog --sha <merged-commit-sha> --format json`
  `LAUNCHPAD_RULESET_TOKEN=<token> GITHUB_REPOSITORY=carterlasalle/launchpad-platform node scripts/verify-ruleset.mjs`
- Compare the plan fingerprint with the one approved for the merged SHA; a
  mismatch means the plan is stale and apply must not proceed
  (`yarn platform apply --catalog catalog --sha <sha> --controller "$LAUNCHPAD_CONTROLLER_URL"` revalidates the fingerprint before writing).
- Reconcile any missed webhook receipts from the persisted event IDs
  (`webhook_events` table) and document the outage window in the incident.
- Sticky PR comments and commit statuses posted during the outage fail
  visibly: their delivery outcome is recorded on the incident row
  (`incidents.delivery_json`) instead of failing silently; re-run the
  fan-out after recovery by refiring the incident
  (`POST /v1/incidents/<id>/resolve` then re-running the operation).

## Validation

- OIDC provenance verifies for the workflow run: the reviewed-plan
  attestation endpoint
  (`POST "$LAUNCHPAD_CONTROLLER_URL/v1/plans/verify"` with the OIDC token, the
  real PR-head plan, `planFingerprint`, and `desiredHash`) returns
  `accepted: true` only after the controller verified the token, bound the
  declared repository/PR identity to the claims, confirmed the submitted
  `sourceCommit` is the current PR head through the GitHub API, and durably
  persisted the attestation. A rejected or unverifiable head (`503
  LP-OIDC-PR-HEAD-UNVERIFIABLE`) means the plan review cannot be recorded and
  the merged apply gate will refuse the release.
- The active ruleset is verified and status checks are green on the merged
  commit.

## Escalation

- Open an incident issue listing the outage window, queued operations, and
  the revalidation results; attach the GitHub status URL.
