#!/usr/bin/env node
/**
 * Verifies the repository's Node.js and Yarn pins agree with the toolchain
 * decision record (docs/adr/0007-toolchain-node-yarn.md) and that the
 * running runtime matches them. Fails (exit 1) on any mismatch.
 *
 * Intended for CI (ci.yml), the production release gate
 * (deploy-control-plane.yml), and the release checklist. The decision record
 * marker is the single source of truth:
 *
 *   <!-- toolchain: node=<exact> yarn=<exact> immutable-installs=<bool> -->
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const expected = { node: null, yarn: null, immutable: false };

// 1. Decision record marker (single source of truth).
const adrPath = resolve(root, 'docs/adr/0007-toolchain-node-yarn.md');
const marker = readFileSync(adrPath, 'utf8').match(
  /<!--\s*toolchain:\s*node=(\d+\.\d+\.\d+)\s+yarn=(\d+\.\d+\.\d+)\s+immutable-installs=(true|false)\s*-->/,
);
if (!marker) {
  failures.push('docs/adr/0007-toolchain-node-yarn.md is missing the machine-readable toolchain marker');
} else {
  [expected.node, expected.yarn] = [marker[1], marker[2]];
  expected.immutable = marker[3] === 'true';
}

const read = (path) => readFileSync(resolve(root, path), 'utf8').trim();

// 2. Pin files.
const nodeVersion = read('.node-version');
const nvmrc = read('.nvmrc');
if (expected.node) {
  if (nodeVersion !== expected.node) failures.push(`.node-version is '${nodeVersion}', decision record requires '${expected.node}'`);
  if (nvmrc !== expected.node) failures.push(`.nvmrc is '${nvmrc}', decision record requires '${expected.node}'`);
}

const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
if (expected.yarn && pkg.packageManager !== `yarn@${expected.yarn}`) {
  failures.push(`package.json packageManager is '${pkg.packageManager}', decision record requires 'yarn@${expected.yarn}'`);
}
const enginesNode = typeof pkg.engines?.node === 'string' ? pkg.engines.node : '';
if (expected.node) {
  const lowerBound = new RegExp(`>=${expected.node.replaceAll('.', '\\.')}`);
  if (!lowerBound.test(enginesNode)) failures.push(`package.json engines.node '${enginesNode}' does not pin the lower bound ${expected.node}`);
  if (!/<25\b/.test(enginesNode)) failures.push(`package.json engines.node '${enginesNode}' must cap the major at <25 (Node 24 LTS line)`);
}

const yarnrc = read('.yarnrc.yml');
if (expected.immutable && !yarnrc.includes('enableImmutableInstalls: true')) {
  failures.push('.yarnrc.yml must set enableImmutableInstalls: true (decision record mandates immutable installs)');
}

// 3. Running runtime (CI and release gates run this with the exact toolchain).
let runningNode = null;
let runningYarn = null;
try {
  runningNode = execFileSync('node', ['--version'], { encoding: 'utf8' }).trim();
} catch {
  failures.push('node is not available on PATH');
}
try {
  runningYarn = execFileSync('yarn', ['--version'], { encoding: 'utf8' }).trim();
} catch {
  failures.push('yarn is not available on PATH (enable Corepack with `corepack enable`)');
}
if (expected.node && runningNode && runningNode !== `v${expected.node}`) {
  failures.push(`running node is ${runningNode}, decision record requires v${expected.node}`);
}
if (expected.yarn && runningYarn && runningYarn !== expected.yarn) {
  failures.push(`running yarn is ${runningYarn}, decision record requires ${expected.yarn}`);
}

if (failures.length > 0) {
  console.error('Toolchain verification FAILED:');
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(`Expected per docs/adr/0007-toolchain-node-yarn.md: node ${expected.node ?? '?'}, yarn ${expected.yarn ?? '?'}, immutable-installs=${expected.immutable}`);
  process.exit(1);
}
console.log(`Toolchain verified: node v${expected.node}, yarn ${expected.yarn}, immutable installs; decision record, pin files, and running runtime agree.`);
