# Break-glass branch-rule bypass

1. Confirm the incident requires a bypass and that normal apply, rollback, or provider recovery cannot resolve it.
2. Obtain the emergency approver and record the exact commit, target branch, and reason.
3. Apply the smallest possible change; do not combine configuration cleanup with the emergency fix.
4. Immediately open a follow-up PR containing the durable desired-state representation.
5. Re-enable normal rules, run full validation, and create the required incident audit event.
6. Review the bypass during the production-readiness retrospective.
