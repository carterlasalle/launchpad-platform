# ADR-0003: Cloudflare Worker / Workflows / D1 control plane

- Status: Accepted
- Date: 2026-08-04

## Context

Launchpad needs a durable controller: long-running provider operations with
step-level retries, at-least-once semantics, persistent state, and scheduled
reconciliation, without operating Kubernetes or a container orchestrator.

## Decision

- The control plane runs as a Cloudflare Worker (`apps/controller/`) deployed
  with Wrangler (`wrangler.jsonc`, `yarn wrangler deploy --env production`).
- Durable orchestration uses Cloudflare Workflows with four workflow classes:
  `apply-application`, `preview-application`, `reconcile-application`, and
  `decommission-application`.
- Persistent relational state lives in Cloudflare D1 (`launchpad` database,
  `migrations/d1/`, forward-only migrations) behind the provider-neutral
  store (`packages/database`).
- Asynchronous fan-out uses Cloudflare Queues
  (`launchpad-provider-events`, `launchpad-health-checks`) with bounded
  retries (`max_retries: 5`) and a dead-letter queue
  (`launchpad-dead-letter`).
- Scheduled reconciliation is independently restartable from apply
  workflows (NFR-REL-005); the reconcile GitHub Action triggers the
  `reconcile-application` workflow on a 30-minute schedule.

## Consequences

- Controller restarts resume durable steps; workflow state and locks are not
  lost in D1-backed environments.
- Retry exhaustion lands on the dead-letter queue and remains visible instead
  of disappearing.
- The platform is bound to Cloudflare's runtime; provider-specific details
  stay behind modular adapters (core never imports provider SDKs).

## Compliance

- `wrangler.jsonc` declares the Worker, D1, Queues, and Workflows bindings for
  production without inheritance gaps.
- `apps/controller/src/workflows.ts`, `worker.ts`, and `queues.ts` implement
  the runtime entry points.
- `migrations/d1/` holds the forward-only schema.
