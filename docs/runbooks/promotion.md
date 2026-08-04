# Failed production promotion

1. Confirm candidate project, environment, commit SHA, desired generation, and lock ownership.
2. If identity does not match the approved plan, stop and replan; never promote by deployment name alone.
3. Confirm candidate build terminal state and staged health result.
4. If promotion failed before alias change, keep the prior production deployment and retry only the failed provider step.
5. If alias changed, run the production health suite and follow the rollback runbook when it fails.
6. Keep the release operation red even when availability is restored.
