# ADR-0002: No custom GitHub App

- Status: Accepted
- Date: 2026-08-04

## Context

Launchpad automates repository validation, previews, plans, applies, and
reconciliation from GitHub Actions. Requirements exclude building a custom
GitHub App (TR-GH-001..004) while still requiring OIDC-based cross-repository
authentication and purpose-separated credentials.

## Decision

- Launchpad does not build or operate a custom GitHub App.
- Control-repository workflows use the native `GITHUB_TOKEN` where sufficient
  (TR-GH-001).
- Cross-repository reads and writes use purpose-separated fine-grained tokens
  (`LAUNCHPAD_GITHUB_TOKEN`, `LAUNCHPAD_RULESET_TOKEN`, and per-purpose
  credentials documented in `docs/runbooks/credentials.md`) (TR-GH-002).
- Application repositories authenticate to the controller through GitHub
  Actions OIDC; the controller verifies issuer, audience, repository, SHA,
  and workflow claims cryptographically (`apps/controller/src/auth/oidc.ts`)
  (TR-GH-003, TR-GH-004).
- Dependency automation runs on the hosted Renovate GitHub App (a third-party
  service, not a custom application) and opens ordinary reviewable PRs; see
  ADR-0008.

## Consequences

- No App installation, webhook, or signing key to operate for the platform
  itself.
- Token expiry and revocation are handled per purpose through the credential
  rotation runbook.
- OIDC remains the trust boundary for cross-repository control-plane calls;
  verification failures reject the request (fail closed).

## Compliance

- All workflows authenticate with `github.token` or purpose tokens; no App
  client IDs or installation secrets exist in the repository.
- `apps/controller/src/auth/oidc.ts` and `auth/webhooks.ts` enforce the
  cryptographic verification paths.
- `docs/runbooks/credentials.md` covers rotation of every purpose token.
