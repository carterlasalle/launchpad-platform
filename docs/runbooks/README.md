# Launchpad runbooks

Use these runbooks for incidents, failed workflows, provider outages, credential problems, and controlled recovery. Start from the observed symptom; do not mutate provider state until the operation, ownership, and last durable boundary are known.

## First response

1. Freeze new automatic changes when continued mutation could worsen the incident by setting `LAUNCHPAD_CONTROL_PLANE_ENABLED=false` through the reviewed emergency procedure.
2. Preserve the currently serving production deployment.
3. Record application ID, operation ID, workflow ID, correlation ID, source commit, provider, step, error code, and first/last timestamps.
4. Read the controller/dashboard operation and incident records; do not infer state from one provider dashboard.
5. Classify the failure as validation, authentication, authorization, not-found, conflict, unsupported, rate-limited, transient provider, malformed response, timeout, build, health, policy, stale plan, or internal.
6. Confirm the relevant resource ownership and lock before retrying or changing it.
7. Use the narrow recovery action in the applicable runbook.
8. Verify provider state, D1 state, deployment/health state, audit history, and the user-visible endpoint before resolving the incident.

A restored service does not make the original failed operation successful. Preserve both the failure and the recovery record.

## Symptom-to-runbook map

| Symptom | Runbook |
|---|---|
| GitHub API errors, plan/reconciliation PR failures, ruleset verification unavailable | [GitHub API outage](github-api-outage.md) |
| Vercel project, build, domain, promotion, or deployment API errors | [Vercel API outage](vercel-api-outage.md) |
| Cloudflare zone, DNS write, or authoritative verification API errors | [Cloudflare API outage](cloudflare-api-outage.md) |
| Controller deployment failed or a newly deployed Worker is unhealthy | [Controller rollback](controller-rollback.md) |
| Candidate/promotion sequence failed before or after production movement | [Promotion failure](promotion.md) |
| Application production health failed and known-good restoration is required | [Application rollback](rollback.md) |
| D1 migration failed, partially applied, or schema compatibility is uncertain | [D1 migration](d1-migration.md) |
| Credential is expiring, revoked, over-scoped, or rejected | [Credential rotation](credentials.md) |
| Secret references cannot be resolved or fingerprinted | [Secret-provider outage](secret-provider.md) |
| Queue retries exhausted or a dead-letter incident appeared | [Dead-letter handling](dead-letter.md) |
| Operation is blocked by an application or domain lock | [Lock recovery](locks.md) |
| Shadow preview cleanup failed or orphaned preview resources remain | [Preview cleanup](preview-cleanup.md) |
| Provider response schema/capability changed or required fields disappeared | [Provider schema change](provider-schema.md) |
| Application must be safely decommissioned and destroyed | [Safe deletion](deletion.md) |
| An emergency repository/ruleset bypass is being considered | [Break glass](break-glass.md) |

## Shared evidence

Capture bounded, redacted evidence:

```text
applicationId
operationId
workflowId
correlationId
sourceCommit
provider
step
errorCode and retryable classification
current desired generation and plan fingerprint
last completed durable step
current application/domain lock owner and expiry
candidate/current/known-good deployment IDs
health result and checked URL
open incident or reconciliation PR
```

Never paste provider tokens, operator tokens, webhook secrets, deletion approval tokens, secret values, raw environment payloads, or unbounded provider responses into an incident.

## Shared validation

After recovery, verify the exact affected path and then the platform baseline:

```bash
yarn platform validate --catalog catalog
yarn typecheck
yarn test
yarn build
```

For release-affecting incidents, complete the [release checklist](../release-checklist.md). Live provider claims require the dedicated sandbox suite; local or mocked checks are not substitutes.

## Escalation principles

- Fail closed when provider state, ownership, reviewed plan, credential validity, or health cannot be proven.
- Do not release locks by deleting rows until provider operations and lease ownership have been reconciled.
- Do not repeat non-idempotent writes outside the durable workflow.
- Do not mark `SYNCED` after a provider read failure.
- Do not promote an unverified candidate or record it known-good early.
- Do not use normal apply for deletion.
- Do not weaken branch protection, secret separation, or workflow permissions to restore a green check.
