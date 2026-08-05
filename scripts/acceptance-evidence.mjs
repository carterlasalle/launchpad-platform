/**
 * Shared acceptance-evidence contract.
 *
 * Single source of truth for the environment metadata the runtime
 * acceptance report (artifacts/acceptance-report.json) must carry and that
 * scripts/acceptance-offline.mjs verifies before any report is accepted as
 * release evidence:
 *
 *   - toolchain: the Node/Yarn pins from the decision-record marker in
 *     docs/adr/0007-toolchain-node-yarn.md — the same source of truth
 *     scripts/check-toolchain.mjs enforces;
 *   - source commit: `GITHUB_SHA` when present, otherwise the current git
 *     HEAD, always exactly 40 lowercase hex characters.
 *
 * Absent, malformed, or mismatched metadata fails the gate. repoRoot and
 * generatedAt are descriptive only and are never treated as commit
 * evidence.
 *
 * Imported by both the acceptance suite (via
 * tests/end-to-end/acceptance-matrix.ts) and the offline gate
 * (scripts/acceptance-offline.mjs) so the recorded and expected values can
 * never drift apart.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const COMMIT_SHA_RE = /^[0-9a-f]{40}$/;

/**
 * Node/Yarn pins from the decision record
 * (docs/adr/0007-toolchain-node-yarn.md). Throws when the marker is
 * missing or malformed; the pin files and running runtime are the job of
 * scripts/check-toolchain.mjs.
 */
export function readToolchainPins(root) {
  const marker = readFileSync(resolve(root, 'docs/adr/0007-toolchain-node-yarn.md'), 'utf8').match(
    /<!--\s*toolchain:\s*node=(\d+\.\d+\.\d+)\s+yarn=(\d+\.\d+\.\d+)\s+immutable-installs=(true|false)\s*-->/,
  );
  if (!marker) {
    throw new Error('docs/adr/0007-toolchain-node-yarn.md is missing the machine-readable toolchain marker');
  }
  return { node: marker[1], yarn: marker[2], immutable: marker[3] === 'true' };
}

/** Exact versions of the running runtime (node without the leading 'v'). */
export function runningToolchain() {
  const node = execFileSync('node', ['--version'], { encoding: 'utf8' }).trim().replace(/^v/, '');
  const yarn = execFileSync('yarn', ['--version'], { encoding: 'utf8' }).trim();
  return { node, yarn };
}

/**
 * Deterministic source commit for acceptance evidence: `GITHUB_SHA` when
 * present, otherwise the current git HEAD. Exactly 40 lowercase hex
 * characters are required; anything else fails closed (no fallback, no
 * abbreviation, no truncation).
 */
export function resolveSourceCommit(root, env = process.env) {
  const fromEnv = typeof env.GITHUB_SHA === 'string' ? env.GITHUB_SHA.trim() : '';
  const commit =
    fromEnv !== ''
      ? fromEnv
      : execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  if (!COMMIT_SHA_RE.test(commit)) {
    throw new Error(
      `source commit '${commit === '' ? '<empty>' : commit}' is not exactly 40 lowercase hex characters ` +
        `(GITHUB_SHA is ${fromEnv !== '' ? 'set' : 'unset'}); refusing ambiguous commit evidence`,
    );
  }
  return commit;
}
