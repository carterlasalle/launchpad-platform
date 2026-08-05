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
| [0001](0001-no-terraform.md) | No Terraform / OpenTofu | Accepted |
| [0002](0002-no-custom-github-app.md) | No custom GitHub App | Accepted |
| [0003](0003-cloudflare-control-plane.md) | Cloudflare Worker / Workflows / D1 control plane | Accepted |
| [0004](0004-git-as-desired-state.md) | Git as the desired state | Accepted |
| [0005](0005-open-pr-reconciliation.md) | Open-PR reconciliation default | Accepted |
| [0006](0006-staged-production-promotion.md) | Staged production promotion | Accepted |
| [0007](0007-toolchain-node-yarn.md) | Node.js and Yarn toolchain pinning | Accepted |
| [0008](0008-dependency-automation.md) | Automated dependency updates through reviewed PRs | Accepted |
