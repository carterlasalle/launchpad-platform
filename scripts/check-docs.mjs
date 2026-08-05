#!/usr/bin/env node
/** Verifies the repository documentation surface and local Markdown links. */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const required = [
  'README.md',
  'AGENTS.md',
  'CONTRIBUTING.md',
  'docs/README.md',
  'docs/guides/README.md',
  'docs/guides/getting-started.md',
  'docs/guides/deployment.md',
  'docs/guides/managing-applications.md',
  'docs/runbooks/README.md',
];
const failures = [];

function repositoryPath(path) {
  return relative(root, path).split(sep).join('/');
}

function markdownFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...markdownFiles(path));
    else if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') files.push(path);
  }
  return files;
}

function localTargets(sourcePath) {
  const source = readFileSync(sourcePath, 'utf8').replace(/```[\s\S]*?```/g, '');
  const links = [];
  const pattern = /!?\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of source.matchAll(pattern)) {
    let target = match[1]?.trim() ?? '';
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
    target = target.split(/\s+['"]/u, 1)[0] ?? target;
    if (target === '' || target.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    target = target.split('#', 1)[0]?.split('?', 1)[0] ?? '';
    if (target === '') continue;
    try { target = decodeURIComponent(target); } catch { failures.push(`${repositoryPath(sourcePath)} contains an invalid encoded link '${target}'.`); continue; }
    links.push(target.startsWith('/') ? resolve(root, `.${target}`) : resolve(dirname(sourcePath), target));
  }
  return links;
}

for (const path of required) {
  if (!existsSync(resolve(root, path))) failures.push(`Missing required documentation: ${path}`);
}

const docsRoot = resolve(root, 'docs');
const allDocs = existsSync(docsRoot) ? markdownFiles(docsRoot) : [];
const entrypoints = ['README.md', 'AGENTS.md', 'CONTRIBUTING.md'].map((path) => resolve(root, path)).filter(existsSync);
const reachable = new Set();
const pending = [...entrypoints];

while (pending.length > 0) {
  const source = pending.shift();
  if (!source || reachable.has(source) || !existsSync(source) || !statSync(source).isFile()) continue;
  reachable.add(source);
  for (const rawTarget of localTargets(source)) {
    let target = rawTarget;
    if (!existsSync(target)) {
      failures.push(`${repositoryPath(source)} links to missing path '${repositoryPath(target)}'.`);
      continue;
    }
    if (statSync(target).isDirectory()) {
      const index = resolve(target, 'README.md');
      if (existsSync(index)) target = index;
      else continue;
    }
    if (extname(target).toLowerCase() === '.md' && !reachable.has(target)) pending.push(target);
  }
}

for (const file of allDocs) {
  if (!reachable.has(file)) failures.push(`Documentation is not reachable from a root entrypoint: ${repositoryPath(file)}`);
}

if (failures.length > 0) {
  console.error('Documentation verification FAILED:');
  for (const failure of [...new Set(failures)].sort()) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`Documentation verified: ${required.length} required files present, ${allDocs.length} docs reachable, local links resolve.`);
