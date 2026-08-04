# Controller rollback

1. Identify the failing Worker version and the last known-good version.
2. Stop new controller deployments and preserve D1 state; do not reset or delete operation history.
3. Promote the last known-good Worker version through the deployment environment.
4. Run `/healthz`, dashboard read, OIDC rejection, webhook signature rejection, and idempotency smoke checks.
5. Resume durable operations only after workflow state and locks are readable.
6. Open a corrective PR with the failing fixture and rollback evidence.
