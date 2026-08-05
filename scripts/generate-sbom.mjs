#!/usr/bin/env node
/**
 * Generates a CycloneDX 1.5 SBOM for the controller release (ADR-0008):
 *
 *   - every dependency recorded in yarn.lock (name, version, SHA-512 checksum)
 *   - every workspace package and its direct dependencies
 *   - every third-party GitHub Action pinned by the repository workflows
 *   - repository provenance (repository, commit, workflow, run id)
 *
 * The release workflow generates this from the protected commit, uploads it
 * as an artifact, and attests it with actions/attest-build-provenance before
 * `wrangler deploy` (deploy-control-plane.yml).
 *
 * Usage: node scripts/generate-sbom.mjs [--output artifacts/launchpad-sbom.cdx.json]
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputFlag = process.argv.indexOf('--output');
const outputPath = resolve(root, outputFlag >= 0 ? process.argv[outputFlag + 1] : 'artifacts/launchpad-sbom.cdx.json');

const commit = (process.env.GITHUB_SHA || execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toLowerCase();
const repository = process.env.GITHUB_REPOSITORY || 'local';
const workflow = process.env.GITHUB_WORKFLOW || 'local';
const runId = process.env.GITHUB_RUN_ID || 'local';

const npmPurl = (name, version) => {
  const encoded = name.startsWith('@') ? `%40${name.slice(1).replace('/', '%2F')}` : name;
  return `pkg:npm/${encoded}@${version}`;
};

// --- 1. yarn.lock dependency components ---
const lockLines = readFileSync(resolve(root, 'yarn.lock'), 'utf8').split('\n');
const lockComponents = [];
const seen = new Set();
let keys = [];
let version = null;
let checksum = null;

const flush = () => {
  const name = keys.length > 0 ? keys[0] : null;
  if (name && name !== '__metadata' && version) {
    const identity = `${name}@${version}`;
    if (!seen.has(identity)) {
      seen.add(identity);
      const component = { type: 'library', name, version, 'bom-ref': npmPurl(name, version) };
      if (checksum) {
        const hex = checksum.replace(/^10c0\//, '');
        if (/^[0-9a-f]{128}$/.test(hex)) component.hashes = [{ alg: 'SHA-512', content: hex }];
      }
      lockComponents.push(component);
    }
  }
  keys = [];
  version = null;
  checksum = null;
};

for (const line of lockLines) {
  if (line.startsWith('#') || line.trim() === '') continue;
  if (!line.startsWith(' ') && line.endsWith(':')) {
    flush();
    keys = line.slice(0, -1).split(',').map((key) => key.trim().replace(/^"|"$/g, ''));
    continue;
  }
  const versionMatch = line.match(/^\s{2}version:\s*(.+)$/);
  if (versionMatch) version = versionMatch[1].trim();
  const checksumMatch = line.match(/^\s{2}checksum:\s*(.+)$/);
  if (checksumMatch) checksum = checksumMatch[1].trim();
}
flush();

// --- 2. Workspace packages + dependency edges ---
const workspacePackages = [];
const packageJsonNames = ['package.json'];
const workspaceDirs = ['packages', 'apps', 'workflows'].filter((directory) => statSync(resolve(root, directory), { throwIfNoEntry: false }));
for (const directory of workspaceDirs) {
  for (const entry of readdirSync(resolve(root, directory))) {
    const manifestPath = join(resolve(root, directory), entry, 'package.json');
    if (!statSync(manifestPath, { throwIfNoEntry: false })) continue;
    workspacePackages.push(JSON.parse(readFileSync(manifestPath, 'utf8')));
  }
}
const rootPackage = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

const dependencyMap = new Map(); // bom-ref -> direct dependency purls
const addDirectDeps = (manifest, name, versionValue) => {
  const purl = npmPurl(name, versionValue);
  const direct = [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ];
  dependencyMap.set(purl, direct.map((depName) => {
    const lockEntry = lockComponents.find((component) => component.name === depName);
    return lockEntry ? lockEntry['bom-ref'] : npmPurl(depName, '0.0.0');
  }).filter((ref, index, all) => all.indexOf(ref) === index));
  return purl;
};

const rootRef = `pkg:github/${repository}@${commit}`;
const components = [
  {
    type: 'application',
    name: 'launchpad-control-plane',
    version: commit.slice(0, 12),
    'bom-ref': rootRef,
    properties: [
      { name: 'launchpad:repository', value: repository },
      { name: 'launchpad:commit', value: commit },
      { name: 'launchpad:workflow', value: workflow },
      { name: 'launchpad:run_id', value: runId },
      { name: 'launchpad:generator', value: 'scripts/generate-sbom.mjs' },
      { name: 'launchpad:hash_source', value: 'yarn.lock checksums (SHA-512)' },
    ],
  },
  ...lockComponents,
];

addDirectDeps(rootPackage, 'launchpad', commit.slice(0, 12));
for (const manifest of workspacePackages) {
  if (!manifest.name) continue;
  const versionValue = manifest.version ?? '0.0.0';
  const purl = addDirectDeps(manifest, manifest.name, versionValue);
  components.push({ type: 'application', name: manifest.name, version: versionValue, 'bom-ref': purl });
}

// --- 3. Pinned GitHub Actions used by the repository workflows ---
const usesPattern = /^\s*(?:-\s+)?uses:\s*["']?([^\s"']+)["']?\s*(?:#.*)?$/;
const actionRefs = [];
for (const directory of ['.github/workflows', '.github/actions']) {
  const base = resolve(root, directory);
  if (!statSync(base, { throwIfNoEntry: false })) continue;
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (/(^|\.)ya?ml$/i.test(entry)) {
        for (const line of readFileSync(full, 'utf8').split('\n')) {
          const use = line.match(usesPattern);
          if (!use) continue;
          const ref = use[1];
          if (ref.startsWith('./') || ref.startsWith('docker://')) continue;
          const at = ref.lastIndexOf('@');
          if (at < 1) continue;
          const [ownerRepo, sha] = [ref.slice(0, at), ref.slice(at + 1)];
          if (!actionRefs.some((existing) => existing.ownerRepo === ownerRepo && existing.sha === sha)) {
            actionRefs.push({ ownerRepo, sha });
          }
        }
      }
    }
  };
  walk(base);
}
for (const { ownerRepo, sha } of actionRefs) {
  const purl = `pkg:githubactions/${ownerRepo}@${sha}`;
  components.push({ type: 'file', name: `github-action:${ownerRepo}`, version: sha, 'bom-ref': purl });
  if (!dependencyMap.has(rootRef)) dependencyMap.set(rootRef, []);
  if (!dependencyMap.get(rootRef).includes(purl)) dependencyMap.get(rootRef).push(purl);
}

const dependencies = [...dependencyMap.entries()].map(([ref, dependsOn]) => ({ ref, dependsOn }));

const bom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    tools: [{ vendor: 'launchpad', name: 'launchpad-sbom', version: '1.0.0' }],
    component: components[0],
  },
  components,
  dependencies,
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(bom, null, 2)}\n`);
console.log(`SBOM written to ${outputPath}: ${components.length} components (${lockComponents.length} lockfile, ${workspacePackages.length + 1} workspace, ${actionRefs.length} pinned actions), ${dependencies.length} dependency node(s), commit ${commit}.`);
