# Stuck application or domain lock

1. Inspect the lock owner, workflow ID, lease expiry, and latest durable step.
2. Confirm the owning workflow is not still running before releasing anything.
3. If the owner is dead and the lease expired, release the lock through the audited operator action.
4. If the lease has not expired, wait or terminate the owning workflow; never overwrite an active lock.
5. Re-run the failed step with the same idempotency key and verify provider postconditions.
6. Record the operator, evidence, and recovery outcome in the audit history.
