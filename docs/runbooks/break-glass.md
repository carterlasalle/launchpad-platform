# Break-glass branch-rule bypass

Purpose: perform the smallest possible emergency change when the normal
review path cannot be used, and prove that the ruleset is active again
afterwards.

## Detection

- An incident requires a change faster than normal review, or the protected
  branch is unreachable through normal means; normal apply, rollback, or
  provider recovery cannot resolve it.

## Containment

- Obtain the emergency approver and record the exact commit, target branch,
  and reason before acting. Apply the smallest possible change; do not
  combine configuration cleanup with the emergency fix.
- Prefer a temporary ruleset bypass for a break-glass role over direct
  pushes; every bypass must create an audit event and an incident issue.

## Recovery

1. Perform the emergency change through the temporary bypass, or directly
   via a reviewed, minimized commit.
2. Immediately open a follow-up PR containing the durable desired-state
   representation of the change.
3. Remove the temporary bypass and re-enable normal rules.
4. Prove the ruleset is active and bypass-free again:
   `LAUNCHPAD_RULESET_TOKEN=<token> GITHUB_REPOSITORY=CarterLaSalle/launchpad node scripts/verify-ruleset.mjs`
5. Run full validation: `yarn platform validate --catalog catalog`,
   `yarn platform preflight --catalog catalog`, and the release checklist
   gates.
6. Create the incident audit event (actor, commit, reason, bypass window,
   follow-up PR).

## Validation

- `scripts/verify-ruleset.mjs` exits 0: `launchpad-main` active, zero bypass
  actors, all required rules and status checks present.
- The follow-up PR merged through the normal review path, and the incident
  issue links commit, bypass window, and audit event.

## Escalation

- If the ruleset cannot be restored to the spec (e.g. API unavailable),
  treat the platform as unverified: freeze production releases
  (`deploy-control-plane.yml` fails its foundation gate by design) and
  escalate to the platform owner. Review the bypass during the
  production-readiness retrospective.
