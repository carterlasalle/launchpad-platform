# Deletion and decommission runbook

Removing an application manifest is **never** deletion (TR-LIFE-001). The only
path that destroys provider resources is the reviewed lifecycle flow below,
executed by the `DecommissionApplicationWorkflow` destroy machine. Normal
apply and reconciliation always refuse `DESTROY`; a missing manifest produces
`BLOCKED_MISSING_MANIFEST` with zero provider writes.

## Lifecycle states

```
active → decommissioning → approved-for-deletion → deleted
```

Reverse reactivation (`decommissioning → active`) is only possible **before
deletion approval** and only via a reviewed PR that declares
`lifecycle.recoveryPolicy.allowReactivateBeforeDeletionApproval: true`
(`LP-LIFECYCLE-RECOVERY-POLICY-REQUIRED` otherwise). After
`approved-for-deletion`, reactivation is permanently blocked
(`LP-LIFECYCLE-REACTIVATION-AFTER-APPROVAL-BLOCKED`).

## Step 1 — First deletion PR (operator)

```
POST /v1/applications/<id>/decommission
Authorization: Bearer $LAUNCHPAD_OPERATOR_TOKEN
```

The controller computes the impact report (reverse dependents from the
control repository at `main`, including external links referencing owned
domains), opens **one** PR per application (`decommission/<id>`), and sets:

```yaml
lifecycle:
  state: decommissioning
  deletionProtection: true
  decommission:
    requestedAt: <now>
    deleteAfter: <now + 48h>        # cooling-off
    approvalToken: null             # never committed
```

Effects after merge:

- Promotion is stopped (`LP-PROMOTION-LIFECYCLE-BLOCKED`); the service keeps
  running (no provider mutation).
- The PR body carries the impact report; dependents block the final destroy
  (`LP-DESTROY-DEPENDENTS`).
- A cooling-off period begins (`deleteAfter`).

### Cancel decommissioning (recovery, before approval)

```
POST /v1/applications/<id>/decommission/reactivate
{"reason": "service restored after incident review"}
```

Opens the reviewed recovery PR (state back to `active`, recovery policy
declared). Approved-for-deletion manifests cannot be reactivated.

## Step 2 — Issue the single-use approval token

```
POST /v1/applications/<id>/decommission/approval
{"domain": "<production domain>", "sourceCommit": "<merged final deletion PR head sha>", "actor": "<operator>"}
```

Returns the plaintext token **exactly once**:

```json
{ "approvalId": "…", "token": "<64 hex chars>", "domain": "…", "sourceCommit": "…", "expiresAt": "…" }
```

- The token is cryptographically random (256-bit); only its SHA-256
  fingerprint is persisted (`deletion_approvals`), never the plaintext.
- The binding (application + domain + approved source commit + actor +
  expiry) is recorded in the immutable audit trail
  (`DELETION_APPROVAL_ISSUED`) and re-verified at destruction.

## Step 3 — Final deletion PR (CODEOWNER review)

A reviewed PR sets:

```yaml
lifecycle:
  state: approved-for-deletion
  deletionProtection: false
  decommission:
    requestedAt: <first PR requestedAt>
    deleteAfter: <elapsed>
    approvalToken: null
    preserveDeployments: true|false
```

The PR requires CODEOWNER approval and passing checks. Record the merged
commit sha — that is the `sourceCommit` the approval must bind.

## Step 4 — Destroy (operator)

```
POST /v1/applications/<id>/delete
Authorization: Bearer $LAUNCHPAD_OPERATOR_TOKEN
{
  "approvalId": "…",
  "approvalToken": "<plaintext token>",
  "sourceCommit": "<approved merged commit sha>",
  "domain": "<production domain>",
  "actor": "<operator>"
}
```

Returns `202` with `operationId`. The durable destroy machine runs ordered,
idempotent steps (each persisted in D1; resume with the same `idempotencyKey`
or the workflow instance id):

1. `validate-destroy-request` — payload shape.
2. `load-approved-manifest` — manifest must exist at `sourceCommit` **and**
   on `main` (`BLOCKED_MISSING_MANIFEST` if absent; `LP-DESTROY-COOLING-OFF`
   until `deleteAfter`; `LP-DESTROY-APPROVAL-COMMIT-STALE` if main moved).
3. `verify-approval` — binding re-check, then **single-use** consumption
   (`LP-DESTROY-APPROVAL-USED` / `-EXPIRED` / `-REVOKED` /
   `-BINDING-MISMATCH`).
4. `check-dependents` — reverse dependents block (`LP-DESTROY-DEPENDENTS`).
5. `check-operations-and-locks` — no other active runs, application + domain
   locks acquired (`LP-DESTROY-BLOCKING-OPERATIONS`, `LP-LOCK-CONFLICT`).
6. `stop-promotion` — sync status `DECOMMISSIONING`, audit.
7. `export-final-metadata` — canonical export (manifest, resources,
   deployments, audit) persisted via `DESTROY_EXPORT` audit event.
8. `cloudflare-proxy-off` — proxied records flipped to `dns-only` (owned
   fingerprint only).
9. `unassign-production-domain` — production domain removed from the project.
10. `delete-owned-dns` — records deleted by provider record id + ownership
    fingerprint (`LP-DNS-CONFLICT-UNOWNED` otherwise).
11. `release-custom-environments` — D1 resource ledger released.
12. `delete-deployments-per-policy` — deleted when
    `preserveDeployments: false` and the provider supports it.
13. `remove-git-and-project` — project deleted only when the live ownership
    fingerprint matches the recorded ledger (`LP-OWNERSHIP-CONFLICT`); with
    `preserveDeployments: true` the project and its history are retained.
14. `mark-deployments-inactive` — GitHub deployment statuses.
15. `record-tombstone` — lifecycle `deleted`, tombstone (`retainUntil` =
    now + 30 days), `DELETED` audit event.

Every destructive mutation re-reads provider state and verifies ownership
before acting; nothing is guessed by hostname or name.

## Interruption and resume

A failed run stays `FAILED` with `failedStep` + typed `errorCode` (audited as
`DESTROY_FAILED`). Completed steps are never re-executed: re-dispatch the same
request (same `idempotencyKey` / workflow instance) and the machine resumes
from the failed step. If the failure happened after approval consumption, the
same token resumes the run (the verification step is already durably
SUCCEEDED); a **new** attempt (different key) requires a fresh approval
(`LP-DESTROY-APPROVAL-USED`).

## Ownership ledger prerequisite

The project deletion step requires ownership evidence recorded in the D1
resource ledger (fingerprint written by a prior apply observation). If the
ledger has no project row, the destroy fails closed with
`LP-OWNERSHIP-CONFLICT` **before** the irreversible project deletion — domains
and DNS already removed are re-creatable by apply. Populate the ledger (run a
normal apply) and resume with the same idempotency key.

## Tombstones and reuse

- Reuse of a deleted application ID or its domain is blocked
  (`LP-DB-TOMBSTONE-REUSE-BLOCKED`, `LP-DB-APP-DELETED-IMMUTABLE`) until
  `retainUntil` elapses **or** a reviewed override is supplied.
- Reviewed override:

```
POST /v1/applications/<id>/tombstone/release
{
  "domain": "<domain>",
  "override": {
    "reviewedBy": "<operator>",
    "reviewedAt": "<now ISO>",
    "reason": "<review evidence>",
    "evidenceUrl": "https://github.com/…/pull/<n>"
  }
}
```

  Returns `409` with `LP-TOMBSTONE-OVERRIDE-REQUIRED` /
  `LP-TOMBSTONE-REUSE-BLOCKED` when not satisfied; on success the tombstone is
  released with attributable evidence (`TOMBSTONE_RELEASED` audit event) and
  the domain can be registered again. Note: the store keeps deleted
  application rows immutable (`LP-DB-APP-DELETED-IMMUTABLE`); re-creating the
  exact application ID requires a new application ID or a store-level recovery
  decision.

## Destructive-path error codes

| Code | Meaning |
|---|---|
| `BLOCKED_MISSING_MANIFEST` | Manifest absent; never a deletion |
| `LP-DESTROY-COOLING-OFF` | `deleteAfter` not elapsed |
| `LP-DESTROY-APPROVAL-COMMIT-STALE` | Manifest moved on main after approval |
| `LP-DESTROY-APPROVAL-USED/EXPIRED/REVOKED` | Token no longer valid |
| `LP-DESTROY-APPROVAL-BINDING-MISMATCH` | Domain/commit/actor differ from issuance |
| `LP-DESTROY-DEPENDENTS` | Reverse dependents still exist |
| `LP-DESTROY-BLOCKING-OPERATIONS` / `LP-LOCK-CONFLICT` | Concurrent work |
| `LP-DNS-CONFLICT-UNOWNED` | DNS record not owned by this application |
| `LP-OWNERSHIP-CONFLICT` | Project ownership evidence mismatch/missing |

## Deletion checklist

- [ ] First PR merged: `state: decommissioning`, `requestedAt`/`deleteAfter` set.
- [ ] Impact report reviewed; dependents resolved or documented.
- [ ] Cooling-off elapsed (`deleteAfter` in the past).
- [ ] Final PR merged: `state: approved-for-deletion`, `deletionProtection: false`.
- [ ] Approval issued and bound to the exact merged commit + domain + actor.
- [ ] Destroy dispatched with the plaintext token; token never stored/logged.
- [ ] Destroy `DELETED`: export + tombstone + audit present; resume-safe on failure.
- [ ] Reuse of the ID/domain remains blocked until retention or reviewed override.
