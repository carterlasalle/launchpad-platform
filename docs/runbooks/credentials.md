# Credential expiration, revocation, and rotation

1. Identify provider and purpose from `credentials_metadata`; never copy a secret into an issue or chat.
2. Create a replacement token with the minimum required scope and selected repositories/zones.
3. Store the replacement in the GitHub environment or Worker secret binding for the matching purpose.
4. Run a read-only preflight against a disposable fixture, then run `yarn platform reconcile --catalog catalog --dry-run`.
5. Revoke the old token only after the replacement read and write checks succeed.
6. Record owner, expiration metadata, rotation time, and verification results in the audit event.
