# Launchpad documentation

This directory contains the product contract, operator and contributor guides, architecture decisions, release gates, and incident runbooks for Launchpad.

## Start here

| Goal | Document |
|---|---|
| Install the repository and run it locally | [Getting started](guides/getting-started.md) |
| Bootstrap GitHub, Cloudflare, Vercel, and production workflows | [Deploying Launchpad](guides/deployment.md) |
| Add or modify a managed application | [Managing applications](guides/managing-applications.md) |
| Respond to an incident or failed operation | [Runbook index](runbooks/README.md) |
| Prepare a release | [Release checklist](release-checklist.md) |
| Understand the complete product and engineering contract | [Unified GitOps Master Plan](Launchpad_Unified_GitOps_Master_Plan.md) |
| Contribute code | [Contributing guide](../CONTRIBUTING.md) |
| Guide a coding agent | [Agent instructions](../AGENTS.md) |

## Guides

The [guide index](guides/README.md) presents the recommended sequence:

1. [Getting started](guides/getting-started.md) — pinned toolchain, immutable install, local D1, Worker development, provider preflight, and verification.
2. [Deploying Launchpad](guides/deployment.md) — resource bootstrap, Worker Secrets Store, GitHub variables/secrets, ruleset activation, sandbox acceptance, and safe enablement.
3. [Managing applications](guides/managing-applications.md) — manifests, zones, pull-request evidence, production apply, drift, and lifecycle operations.

## Design and requirements

- [Launchpad Unified GitOps Master Plan](Launchpad_Unified_GitOps_Master_Plan.md) — normative Launchpad 1.0 product requirements, technical requirements, engineering specifications, implementation plan, acceptance criteria, and traceability.
- [Architecture decision records](adr/README.md) — accepted decisions about desired state, infrastructure tooling, GitHub integration, Cloudflare, reconciliation, promotion, toolchain, and dependency automation.
- [Original implementation design](superpowers/specs/2026-08-04-launchpad-platform-design.md) — design context that preceded the integrated implementation.
- [Original implementation plan](superpowers/plans/2026-08-04-launchpad-platform-plan.md) — historical task decomposition. The master plan governs when documents differ.

## Operations

- [Runbook index](runbooks/README.md) — symptom-to-runbook map and shared incident protocol.
- [Release checklist](release-checklist.md) — static gates, sandbox evidence, live ruleset proof, direct-push rejection, provider acceptance, and rollout checks.

Operational state is also exposed by the authenticated dashboard and controller API. Never substitute a green local or mocked test for a credential-dependent live release gate.

## Documentation conventions

- Product and engineering requirements use RFC 2119 language in the master plan.
- ADRs capture durable architecture decisions and are never silently rewritten.
- Guides explain planned operator workflows.
- Runbooks start from an observed failure and define detection, containment, recovery, validation, and escalation.
- Commands must match repository scripts or pinned provider CLIs.
- Examples use placeholders and disposable resources; they must not include real credentials or sensitive identifiers.
- Every file under `docs/` must be linked from this index or a linked child index.

Validate the documentation graph and local links with:

```bash
yarn docs:check
```
