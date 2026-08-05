#!/usr/bin/env node
/**
 * Offline acceptance gate (release checklist: "Acceptance evidence").
 *
 * Runs the deterministic offline acceptance matrix and validates the
 * runtime acceptance report:
 *
 *   yarn acceptance:offline
 *
 * Exit codes:
 *   0  passed: the toolchain contract is satisfied; every required scenario
 *      ran and passed; the report is fresh, complete, and carries the exact
 *      pinned Node/Yarn and the exact source commit.
 *   1  failed: a scenario failed, was skipped, is missing from the report,
 *      the report is stale/invalid, or its environment metadata is absent,
 *      malformed, or does not match the repository's Node/Yarn pins and the
 *      source commit (GITHUB_SHA or current HEAD).
 *   2  environment error: the toolchain contract is not satisfied
 *      (scripts/check-toolchain.mjs), vitest could not start, or the report
 *      could not be produced.
 *
 * The report (artifacts/acceptance-report.json) is generated at runtime by
 * the suite; a checked-in or stale report is never accepted as evidence.
 * repoRoot and generatedAt are descriptive only and are never treated as
 * commit evidence.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readToolchainPins, resolveSourceCommit } from './acceptance-evidence.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const reportPath = resolve(root, 'artifacts/acceptance-report.json');
const SUITE = 'tests/end-to-end/acceptance.test.ts';
const MAX_REPORT_AGE_MS = 30 * 60 * 1000;

function fail(message) {
  console.error(`acceptance:offline FAILED: ${message}`);
  process.exit(1);
}

/**
 * Validates a parsed runtime acceptance report. Returns an array of failure
 * messages; an empty array means the report is acceptable evidence.
 *
 * `root` is the repository root (for the toolchain pins and source commit);
 * `env` supplies GITHUB_SHA for the expected source commit and defaults to
 * process.env. Exported so the focused script tests can prove the gate's
 * provenance rules without running the suite.
 */
export function validateReport(report, { root: reportRoot, env = process.env } = {}) {
  const failures = [];

  if (report.schemaVersion !== 'launchpad.acceptance/v1') {
    failures.push(`report has unknown schemaVersion '${String(report.schemaVersion)}'`);
  }
  if (report.mode !== 'offline') {
    failures.push(`report mode is '${String(report.mode)}', expected 'offline'`);
  }
  if (!Array.isArray(report.matrix) || report.matrix.length === 0) {
    failures.push('report contains no scenario matrix entries');
  }

  const missingFields = [];
  const skipped = [];
  const failed = [];
  if (Array.isArray(report.matrix)) {
    for (const entry of report.matrix) {
      for (const field of ['id', 'status', 'sections', 'checklist', 'description', 'observed', 'evidence']) {
        if (!(field in entry)) missingFields.push(`${entry.id ?? '<unknown>'}.${field}`);
      }
      if (entry.status === 'skipped') skipped.push(entry.id);
      if (entry.status === 'failed') failed.push(entry.id);
      if (!['passed', 'failed', 'skipped'].includes(entry.status)) failed.push(`${entry.id} (status '${String(entry.status)}')`);
    }
  }
  if (missingFields.length > 0) failures.push(`report entries missing fields: ${missingFields.join(', ')}`);
  if (skipped.length > 0) failures.push(`required scenarios were skipped in offline CI: ${skipped.join(', ')}`);
  if (failed.length > 0) failures.push(`scenarios failed: ${failed.join(', ')}`);
  if (report.summary?.failed !== 0 || report.summary?.skipped !== 0) {
    failures.push(`summary mismatch: ${JSON.stringify(report.summary)}`);
  }
  if (report.summary?.passed !== report.matrix?.length) {
    failures.push(`summary mismatch: ${report.summary?.passed ?? 0}/${report.matrix?.length ?? 0} passed`);
  }

  // Evidence provenance: the report must carry the exact pinned Node/Yarn
  // and the exact source commit. Absent, malformed, or mismatched metadata
  // fails the gate; repoRoot and generatedAt are never commit evidence.
  const environment = report.environment;
  if (environment === undefined || environment === null || typeof environment !== 'object') {
    failures.push('report is missing environment metadata (node, yarn, and source commit are required evidence)');
    return failures;
  }
  const node = environment.node;
  const yarn = environment.yarn;
  const commit = environment.commit;
  if (typeof node !== 'string' || node === '') {
    failures.push('report is missing environment.node (exact Node version)');
  }
  if (typeof yarn !== 'string' || yarn === '') {
    failures.push('report is missing environment.yarn (exact Yarn version)');
  }
  if (typeof commit !== 'string' || commit === '') {
    failures.push('report is missing environment.commit (source commit)');
  } else if (!/^[0-9a-f]{40}$/.test(commit)) {
    failures.push(`report environment.commit '${commit}' is not exactly 40 lowercase hex characters; repoRoot and generatedAt are not commit evidence`);
  }

  let expected;
  try {
    expected = { ...readToolchainPins(reportRoot), commit: resolveSourceCommit(reportRoot, env) };
  } catch (error) {
    failures.push(`cannot derive expected evidence metadata: ${error instanceof Error ? error.message : String(error)}`);
    return failures;
  }

  if (typeof node === 'string' && node !== '' && node !== expected.node) {
    failures.push(`report environment.node '${node}' does not match the repository pin ${expected.node}`);
  }
  if (typeof yarn === 'string' && yarn !== '' && yarn !== expected.yarn) {
    failures.push(`report environment.yarn '${yarn}' does not match the repository pin ${expected.yarn}`);
  }
  if (typeof commit === 'string' && /^[0-9a-f]{40}$/.test(commit) && commit !== expected.commit) {
    failures.push(`report environment.commit '${commit}' does not match the source commit '${expected.commit}' (GITHUB_SHA or current HEAD)`);
  }

  return failures;
}

function main() {
  // -------------------------------------------------------------------------
  // 1. Toolchain contract: unsupported Node/Yarn must never generate
  //    accepted evidence, so the exact toolchain check runs before the
  //    suite. scripts/check-toolchain.mjs is the single owner of that
  //    contract (decision record + pin files + running runtime).
  // -------------------------------------------------------------------------

  console.log('acceptance:offline: verifying the toolchain contract (scripts/check-toolchain.mjs)');
  const toolchainRun = spawnSync(process.execPath, [resolve(root, 'scripts/check-toolchain.mjs')], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
    shell: process.platform === 'win32',
  });
  if (toolchainRun.error) {
    console.error(`acceptance:offline: could not start the toolchain check: ${toolchainRun.error.message}`);
    process.exit(2);
  }
  if (toolchainRun.status !== 0) {
    console.error('acceptance:offline FAILED: the toolchain contract is not satisfied; unsupported Node/Yarn cannot produce accepted acceptance evidence');
    process.exit(2);
  }

  // -------------------------------------------------------------------------
  // 2. Run the deterministic offline suite
  // -------------------------------------------------------------------------

  console.log(`acceptance:offline: running ${SUITE} (deterministic offline matrix)`);
  const run = spawnSync('yarn', ['vitest', 'run', SUITE, '--reporter=dot'], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
    shell: process.platform === 'win32',
  });
  if (run.error) {
    console.error(`acceptance:offline: could not start vitest: ${run.error.message}`);
    process.exit(2);
  }
  if (run.status !== 0) {
    fail(`vitest exited with status ${run.status}; one or more acceptance scenarios failed`);
  }

  // -------------------------------------------------------------------------
  // 3. Validate the runtime report
  // -------------------------------------------------------------------------

  if (!existsSync(reportPath)) {
    fail(`report not generated at artifacts/acceptance-report.json; the suite must write it at runtime`);
  }
  const reportAgeMs = Date.now() - statSync(reportPath).mtimeMs;
  if (reportAgeMs > MAX_REPORT_AGE_MS) {
    fail(`report is stale (${Math.round(reportAgeMs / 1000)}s old); a checked-in or pre-existing report is never accepted as evidence`);
  }

  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch (error) {
    fail(`report is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  for (const failure of validateReport(report, { root, env: process.env })) {
    fail(failure);
  }

  // The report embeds the live-only gates so the release can see exactly what
  // offline mode does NOT claim.
  const liveGates = Array.isArray(report.liveGates) ? report.liveGates : [];
  console.log(`acceptance:offline PASSED: ${report.matrix.length} scenarios, ${report.summary.passed} passed, 0 failed, 0 skipped (${(report.durationMs / 1000).toFixed(1)}s)`);
  console.log(`acceptance:offline: evidence metadata — node ${report.environment.node}, yarn ${report.environment.yarn}, commit ${report.environment.commit}`);
  console.log(`acceptance:offline: report at artifacts/acceptance-report.json`);
  if (liveGates.length > 0) {
    console.log(`acceptance:offline: live-only gates NOT claimed by offline mode (run 'yarn acceptance:live' with dedicated sandbox credentials):`);
    for (const gate of liveGates) console.log(`  - ${gate.id}: ${gate.command} — ${gate.description}`);
  }
}

// Run the gate only when executed directly; importing for tests must not
// spawn the toolchain check or the suite.
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
