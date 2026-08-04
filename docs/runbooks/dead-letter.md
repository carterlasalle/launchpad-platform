# Dead-letter queue processing

1. Inspect the DLQ message ID, source queue, application ID, operation ID, attempt count, and safe error details.
2. Classify the failure as transient, permanent, or malformed input before replaying it.
3. Fix the source condition or code path; do not replay a message that would repeat a destructive action.
4. Replay with the original idempotency key after confirming the operation remains safe to resume.
5. Acknowledge only after the durable workflow records a terminal result.
6. Open an incident issue after retry exhaustion when the application policy requires it.
