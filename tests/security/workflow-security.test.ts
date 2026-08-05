import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const workflowDirectory = join(process.cwd(), '.github/workflows');
const workflowFiles = ['validate-plan.yml', 'apply.yml', 'reconcile.yml', 'destroy.yml', 'deploy-control-plane.yml', 'reusable-app-preview.yml'];

it('pins third-party actions and uses least-privilege workflow defaults', () => {
  for (const file of workflowFiles) {
    const source = readFileSync(join(workflowDirectory, file), 'utf8');
    expect(source).toContain('permissions: {}');
    for (const line of source.split('\n').filter((candidate) => candidate.includes('uses: actions/'))) expect(line).toMatch(/@[0-9a-f]{40}/);
    expect(source).not.toMatch(/npm install|pnpm install|bun install/);
    expect(source).not.toMatch(/\bcache:\s*yarn\b/);
  }
});
