#!/usr/bin/env node
/**
 * Verifies GitHub Actions hygiene for every workflow and composite action:
 *
 *  1. All third-party `uses:` references are pinned to immutable commit SHAs
 *     (40-hex) or local `./` actions; `docker://` images must pin a
 *     `@sha256:` digest; expressions in `uses:` are rejected.
 *  2. Every workflow declares top-level `permissions: {}` and grants only
 *     job-level permissions (workflow security baseline, master plan 25.2).
 *  3. setup-node must not request Yarn caching before the repository's local
 *     setup action enables Corepack; GitHub-hosted runners otherwise invoke
 *     their global Yarn 1 and fail before immutable installation can begin.
 *
 * Fails (exit 1) on any violation. Intended for CI (ci.yml), the production
 * release gate (deploy-control-plane.yml), and the release checklist.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
let filesChecked = 0;

const usesPattern = /^\s*(?:-\s+)?uses:\s*["']?([^\s"']+)["']?\s*(?:#.*)?$/;
const sha40 = /^[0-9a-f]{40}$/;
const sha256Digest = /^sha256:[0-9a-f]{64}$/;

function collectYamlFiles(directory, into) {
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) collectYamlFiles(full, into);
    else if (/(^|\.)ya?ml$/i.test(entry)) into.push(full);
  }
}

const workflowFiles = [];
collectYamlFiles(resolve(root, '.github/workflows'), workflowFiles);
const actionFiles = [];
if (statSync(resolve(root, '.github/actions'), { throwIfNoEntry: false })?.isDirectory()) {
  collectYamlFiles(resolve(root, '.github/actions'), actionFiles);
}

for (const filePath of [...workflowFiles, ...actionFiles]) {
  filesChecked += 1;
  const relative = filePath.slice(root.length + 1);
  const isWorkflow = relative.startsWith('.github/workflows/');
  const lines = readFileSync(filePath, 'utf8').split('\n');

  let topLevelPermissions = false;
  let permissionsValue = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (isWorkflow && /\bcache:\s*yarn\b/.test(line)) {
      failures.push(`${relative}:${index + 1}: setup-node Yarn caching runs before Corepack is enabled; remove 'cache: yarn'`);
    }
    if (/^permissions:\s*/.test(line)) {
      topLevelPermissions = true;
      const rest = line.replace(/^permissions:\s*/, '').trim();
      if (rest === '{}') permissionsValue = '{}';
      else if (rest === '' || rest.startsWith('#')) permissionsValue = 'NESTED';
      else permissionsValue = rest;
      if (!isWorkflow) break;
    }
    const use = line.match(usesPattern);
    if (!use) continue;
    const ref = use[1];
    if (ref.startsWith('./')) continue; // local action
    if (ref.startsWith('docker://')) {
      if (!ref.includes('@sha256:')) failures.push(`${relative}:${index + 1}: docker image '${ref}' must pin a @sha256: digest`);
      continue;
    }
    if (ref.includes('${{')) {
      failures.push(`${relative}:${index + 1}: 'uses:' must not contain expressions ('${ref}')`);
      continue;
    }
    const at = ref.lastIndexOf('@');
    if (at < 1 || !sha40.test(ref.slice(at + 1))) {
      failures.push(`${relative}:${index + 1}: third-party action '${ref}' must be pinned to an immutable 40-hex commit SHA`);
    }
  }

  if (isWorkflow) {
    if (!topLevelPermissions) {
      failures.push(`${relative}: missing top-level 'permissions: {}'`);
    } else if (permissionsValue !== '{}') {
      failures.push(`${relative}: top-level permissions must be '{}' (grant per-job), found '${permissionsValue}'`);
    }
  }
}

if (failures.length > 0) {
  console.error('Workflow security verification FAILED:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`Workflow security verified: ${filesChecked} workflow/action file(s); all third-party actions SHA-pinned, all workflows start with permissions: {}, and setup-node never invokes Yarn before Corepack.`);
