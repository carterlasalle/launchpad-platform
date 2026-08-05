#!/usr/bin/env node
/**
 * Opt-in live sandbox acceptance (release checklist: "Acceptance evidence").
 *
 * Runs the live acceptance harness against DEDICATED sandbox resources only.
 * It never runs against ambiguous or production resources, never falls back
 * to mocks, and never claims evidence when prerequisites are missing.
 *
 *   yarn acceptance:live
 *
 * When disabled (no `LAUNCHPAD_LIVE_ACCEPTANCE=1`): prints a clear skip and
 * exits 0. A skipped run is NOT evidence — the release checklist treats a
 * gate that cannot run as a failed gate.
 *
 * When enabled, ALL of the following are required (missing → exit 1):
 *   LAUNCHPAD_LIVE_ACCEPTANCE=1
 *   LP_LIVE_SANDBOX_PREFIX           explicit sandbox prefix, e.g. lp-live-
 *   LP_LIVE_GITHUB_TOKEN             fine-grained token scoped to the sandbox repo
 *                                    (Contents read/write: the direct-push probe
 *                                    creates an unattached commit and attempts the
 *                                    ref update it expects to be rejected)
 *   LP_LIVE_GITHUB_REPOSITORY        owner/name of the dedicated sandbox repo (must contain the prefix)
 *   LP_LIVE_GITHUB_REPOSITORY_ID     numeric GitHub repository id of the sandbox repo
 *   LP_LIVE_VERCEL_TOKEN             Vercel token scoped to the sandbox team
 *   LP_LIVE_VERCEL_TEAM_ID           Vercel team id that owns the sandbox project
 *   LP_LIVE_VERCEL_PROJECT           dedicated sandbox project id (must start with the prefix)
 *   LP_LIVE_CLOUDFLARE_TOKEN         Cloudflare token scoped to the sandbox zone
 *   LP_LIVE_CLOUDFLARE_ZONE          dedicated sandbox zone (must contain the prefix as a label)
 *   LP_LIVE_DOMAIN                   dedicated sandbox subdomain (must start with the prefix)
 *
 * The harness performs only safe operations on the named sandbox resources:
 * observe → create/update → preview deployment + health → drift restore →
 * cleanup → direct-push-rejected (an attempted non-force fast-forward update
 * of the sandbox default branch must be explicitly rejected by a
 * rule/protection; unexpected success restores the original ref and fails).
 * Evidence is emitted machine-readable to
 * artifacts/acceptance-live-report.json; any failure or deviation exits
 * non-zero.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const reportPath = resolve(root, 'artifacts/acceptance-live-report.json');
const SUITE = 'tests/end-to-end/live-acceptance.test.ts';

const REQUIRED_VARS = [
  'LP_LIVE_SANDBOX_PREFIX',
  'LP_LIVE_GITHUB_TOKEN',
  'LP_LIVE_GITHUB_REPOSITORY',
  'LP_LIVE_GITHUB_REPOSITORY_ID',
  'LP_LIVE_VERCEL_TOKEN',
  'LP_LIVE_VERCEL_TEAM_ID',
  'LP_LIVE_VERCEL_PROJECT',
  'LP_LIVE_CLOUDFLARE_TOKEN',
  'LP_LIVE_CLOUDFLARE_ZONE',
  'LP_LIVE_DOMAIN',
];

const REQUIRED_LIVE_PHASES = ['observe', 'create-or-update', 'preview', 'health', 'drift-restore', 'cleanup', 'direct-push-rejected'];

function fail(message) {
  console.error(`acceptance:live FAILED: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 1. Opt-in gate
// ---------------------------------------------------------------------------

if (process.env.LAUNCHPAD_LIVE_ACCEPTANCE !== '1') {
  console.log('acceptance:live SKIPPED: set LAUNCHPAD_LIVE_ACCEPTANCE=1 and provide the dedicated sandbox variables (LP_LIVE_*) to run the live sandbox acceptance.');
  console.log('acceptance:live SKIPPED: a skipped run is NOT release evidence; see docs/release-checklist.md (Acceptance evidence).');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 2. Prerequisites: dedicated sandbox resources only, no production defaults
// ---------------------------------------------------------------------------

const missing = REQUIRED_VARS.filter((name) => {
  const value = process.env[name];
  return value === undefined || value.trim() === '';
});
if (missing.length > 0) {
  fail(`enabled but missing required variables: ${missing.join(', ')} (refusing to guess or fall back)`);
}

const prefix = process.env.LP_LIVE_SANDBOX_PREFIX.trim();
if (!/^[a-z0-9][a-z0-9-]*$/.test(prefix)) {
  fail(`LP_LIVE_SANDBOX_PREFIX '${prefix}' must be a lowercase DNS-label-shaped prefix (letters, digits, hyphens)`);
}

const project = process.env.LP_LIVE_VERCEL_PROJECT.trim();
const domain = process.env.LP_LIVE_DOMAIN.trim();
const zone = process.env.LP_LIVE_CLOUDFLARE_ZONE.trim();
const repository = process.env.LP_LIVE_GITHUB_REPOSITORY.trim();
const repositoryId = process.env.LP_LIVE_GITHUB_REPOSITORY_ID.trim();

// Ambiguity guards: every targeted resource must visibly belong to the named
// sandbox. No production default, no prefix-free project/domain, no
// non-sandbox zone or repository.
if (!project.startsWith(prefix)) fail(`LP_LIVE_VERCEL_PROJECT '${project}' does not start with the sandbox prefix '${prefix}'; refusing an ambiguous target`);
if (!domain.startsWith(prefix)) fail(`LP_LIVE_DOMAIN '${domain}' does not start with the sandbox prefix '${prefix}'; refusing an ambiguous target`);
if (!zone.split('.').includes(prefix.replace(/-+$/, ''))) fail(`LP_LIVE_CLOUDFLARE_ZONE '${zone}' does not contain the sandbox prefix '${prefix}' as a label; refusing an ambiguous zone`);
if (!repository.includes(prefix)) fail(`LP_LIVE_GITHUB_REPOSITORY '${repository}' does not contain the sandbox prefix '${prefix}'; refusing an ambiguous repository`);
if (!/^\d+$/.test(repositoryId)) fail(`LP_LIVE_GITHUB_REPOSITORY_ID '${repositoryId}' must be a numeric repository id`);

// ---------------------------------------------------------------------------
// 3. Run the live harness (real adapters, real network; no mocks)
// ---------------------------------------------------------------------------

console.log(`acceptance:live: running ${SUITE} against dedicated sandbox resources (prefix '${prefix}')`);
const run = spawnSync('yarn', ['vitest', 'run', SUITE, '--reporter=dot'], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
  shell: process.platform === 'win32',
});
if (run.error) {
  console.error(`acceptance:live: could not start vitest: ${run.error.message}`);
  process.exit(2);
}
if (run.status !== 0) {
  fail(`live acceptance harness exited with status ${run.status}; no live evidence is claimed`);
}

// ---------------------------------------------------------------------------
// 4. Validate the live report
// ---------------------------------------------------------------------------

if (!existsSync(reportPath)) {
  fail('live report not generated at artifacts/acceptance-live-report.json');
}
let report;
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'));
} catch (error) {
  fail(`live report is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
}
if (report.mode !== 'passed' && report.mode !== 'failed') {
  fail(`live report mode is '${String(report.mode)}', expected 'passed' or 'failed'`);
}
if (report.mode !== 'passed') {
  fail(`live acceptance did not pass (${report.phases?.filter((phase) => phase.status !== 'passed').map((phase) => phase.name).join(', ') ?? 'unknown phase'})`);
}
// Every one of the seven executable phases must have run and passed; a live
// report that omits or skips a phase claims evidence it does not have.
for (const name of REQUIRED_LIVE_PHASES) {
  if (!Array.isArray(report.phases) || !report.phases.some((phase) => phase.name === name && phase.status === 'passed')) {
    fail(`live phase '${name}' did not pass; all ${REQUIRED_LIVE_PHASES.length} required phases must pass (${REQUIRED_LIVE_PHASES.join(', ')})`);
  }
}
if (!Array.isArray(report.phases) || report.phases.some((phase) => phase.status !== 'passed')) {
  fail(`live report contains failed phases: ${report.phases.filter((phase) => phase.status !== 'passed').map((phase) => phase.name).join(', ')}`);
}
if (report.summary?.total !== REQUIRED_LIVE_PHASES.length || report.summary?.passed !== REQUIRED_LIVE_PHASES.length || report.summary?.failed !== 0) {
  fail(`summary mismatch: ${JSON.stringify(report.summary)}; expected ${REQUIRED_LIVE_PHASES.length} passed / 0 failed / ${REQUIRED_LIVE_PHASES.length} total`);
}
// The live report must list LIVE-DIRECT-PUSH truthfully: the sandbox default
// branch update was explicitly rejected by a rule/protection.
const liveGates = Array.isArray(report.liveGates) ? report.liveGates : [];
const directPushGate = liveGates.find((gate) => gate.id === 'LIVE-DIRECT-PUSH');
if (directPushGate === undefined || directPushGate.status !== 'passed') {
  fail(`live report must list LIVE-DIRECT-PUSH with status 'passed' (direct push to the sandbox default branch must be explicitly rejected by a rule/protection); got ${directPushGate === undefined ? 'no entry' : `'${directPushGate.status}'`}`);
}
console.log(`acceptance:live PASSED: ${REQUIRED_LIVE_PHASES.join('/')} verified against the named sandbox resources`);
if (liveGates.length > 0) {
  for (const gate of liveGates) console.log(`  - ${gate.id}: ${gate.command} — ${gate.description} (${gate.status}${gate.note ? `; ${gate.note}` : ''})`);
}
console.log(`acceptance:live: report at artifacts/acceptance-live-report.json`);
