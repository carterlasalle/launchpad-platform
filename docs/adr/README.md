# Launchpad architecture decision records

Architecture decision records (ADRs) capture decisions that shape Launchpad's
contracts. They are reviewed through normal pull requests and are owned by the
platform owner (see `.github/CODEOWNERS`).

## Process

- A new ADR is proposed as a pull request against `docs/adr/`.
- ADRs are numbered sequentially and never renumbered or deleted; superseded
  decisions record their replacement in the `Status` line.
- Milestone 0 required records are `0001` through `0006`; the toolchain
  decision record is `0007` and dependency automation is `0008`.

## Index

| ADR | Title | Status |
| --- | --- | --- |
| 0001 | No Terraform / OpenTofu | Accepted |
| 0002 | No custom GitHub App | Accepted |
| 0003 | Cloudflare Worker / Workflows / D1 control plane | Accepted |
| 0004 | Git as the desired state | Accepted |
| 0005 | Open-PR reconciliation default | Accepted |
| 0006 | Staged production promotion | Accepted |
| 0007 | Node.js and Yarn toolchain pinning | Accepted |
| 0008 | Automated dependency updates through reviewed PRs | Accepted |
