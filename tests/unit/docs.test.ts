import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { expect, it } from 'vitest';

/** Extracts repo-relative local markdown link targets (anchors and URLs excluded). */
function localLinks(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const links: string[] = [];
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    let target = match[1]?.trim() ?? '';
    if (target === '' || target.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    target = target.split('#', 1)[0]?.split('?', 1)[0] ?? '';
    if (target === '') continue;
    links.push(relative(process.cwd(), resolve(dirname(file), target)).split('\\').join('/'));
  }
  return links;
}

it('keeps required documentation present, linked, and reachable', () => {
  const result = spawnSync(process.execPath, [join(process.cwd(), 'scripts/check-docs.mjs')], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });

  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toMatch(/Documentation verified:/);
});

it('links the required entrypoints from README.md', () => {
  const links = localLinks(join(process.cwd(), 'README.md'));
  for (const required of [
    'docs/Launchpad_Unified_GitOps_Master_Plan.md',
    'docs/guides/getting-started.md',
    'docs/guides/deployment.md',
    'docs/guides/managing-applications.md',
    'docs/runbooks/README.md',
  ]) {
    expect(links, `README.md must link ${required}`).toContain(required);
  }
});

it('links the documentation index entrypoints from docs/README.md', () => {
  const links = localLinks(join(process.cwd(), 'docs/README.md'));
  for (const required of [
    'docs/Launchpad_Unified_GitOps_Master_Plan.md',
    'docs/adr/README.md',
    'docs/guides/README.md',
    'docs/guides/getting-started.md',
    'docs/runbooks/README.md',
    'docs/release-checklist.md',
  ]) {
    expect(links, `docs/README.md must link ${required}`).toContain(required);
  }
});

it('documents the master plan and the pull-request change path in AGENTS.md', () => {
  const agents = readFileSync(join(process.cwd(), 'AGENTS.md'), 'utf8');
  expect(agents).toContain('docs/Launchpad_Unified_GitOps_Master_Plan.md');
  expect(agents).toMatch(/pull requests? are the normal production-change path/i);
  expect(agents).toMatch(/secret values? never enter git/i);
});

it('references the getting-started guide and contribution path from CONTRIBUTING.md', () => {
  const links = localLinks(join(process.cwd(), 'CONTRIBUTING.md'));
  for (const required of ['docs/guides/getting-started.md', 'docs/Launchpad_Unified_GitOps_Master_Plan.md', 'docs/release-checklist.md']) {
    expect(links, `CONTRIBUTING.md must link ${required}`).toContain(required);
  }
});
