# ADR-0001: No Terraform / OpenTofu

- Status: Accepted
- Date: 2026-08-04

## Context

Launchpad's requirements explicitly exclude Terraform and OpenTofu as IaC
tooling. The control repository's `main` branch protection must still be
declared as code, reviewed through pull requests, and machine-verifiable
without an external IaC runtime.

## Decision

- Launchpad does not use Terraform, OpenTofu, HCL, or any IaC runtime in the
  control repository.
- The desired state of the GitHub ruleset protecting `main` is declared as a
  machine-readable JSON specification at `.github/rulesets/main.json`
  (target branch, enforcement, rules, required status checks, bypass actors,
  and repository merge settings).
- `scripts/verify-ruleset.mjs` compares the live ruleset through the GitHub
  REST rulesets API (`GET /repos/{owner}/{repo}/rulesets`) and repository
  settings against the spec. It fails closed: exit 1 on mismatch, exit 2 when
  the API is unavailable, authenticated access is missing, or the ruleset
  cannot be proven.
- Ruleset verification runs before every control-plane production deployment
  (`.github/workflows/deploy-control-plane.yml`), so a production release
  fails when the active ruleset is unavailable or mismatched.

## Consequences

- No state files, no HCL, no Terraform binary anywhere in the toolchain.
- Ruleset changes are ordinary reviewable PRs that also exercise the
  verification gate.
- Verification depends on GitHub API availability and a token with ruleset
  read access (`LAUNCHPAD_RULESET_TOKEN`, fine-grained, Administration: read);
  unavailability fails the release rather than being skipped.

## Compliance

- `.github/rulesets/main.json` is the single machine-readable source of truth.
- `scripts/verify-ruleset.mjs` is the executable verifier.
- `deploy-control-plane.yml` gates deployment on the verifier.
- `docs/release-checklist.md` requires a green ruleset verification per
  release.
