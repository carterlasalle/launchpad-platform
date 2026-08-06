/**
 * Opt-in live sandbox acceptance harness (tests/end-to-end).
 *
 * Drives the REAL adapters (GitHubAdapter / VercelAdapter / CloudflareAdapter)
 * against DEDICATED sandbox resources with real provider network calls —
 * never mocks, never fallbacks. It performs only safe, reversible operations
 * in the named sandbox: observe → create/update → preview deployment + health
 * → drift restore → cleanup → direct-push-rejected probe (an attempted
 * non-force fast-forward update of the sandbox default branch must be
 * explicitly rejected by the live ruleset; unexpected success restores the
 * original ref and fails).
 *
 * Gating (fail closed):
 *  - `LAUNCHPAD_LIVE_ACCEPTANCE=1` is required; without it the suite writes a
 *    'skipped' report and skips (an opt-in harness is never part of the
 *    required offline matrix).
 *  - Every `LP_LIVE_*` variable is required when enabled; missing variables
 *    fail the run.
 *  - Every targeted resource must visibly belong to the sandbox prefix
 *    (project id, domain, zone label, repository name); ambiguous targets
 *    are refused.
 *
 * Evidence: artifacts/acceptance-live-report.json (machine-readable,
 * resource ids redacted, never containing tokens).
 *
 * Run: yarn acceptance:live  (see scripts/acceptance-live.mjs)
 */

import { expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { checkHealth } from '@launchpad/health';
import { canonicalJson } from '@launchpad/shared';
import { GitHubAdapter } from '@launchpad/provider-github';
import { VercelAdapter } from '@launchpad/provider-vercel';
import { CloudflareAdapter } from '@launchpad/provider-cloudflare';
import type { ProjectSpec, ProviderContext } from '@launchpad/provider-contract';
import { redactResourceIds } from './acceptance-harness.js';
import { LIVE_GATES } from './acceptance-matrix.js';
import { probeDirectPushRejected } from './live-direct-push.js';

const LIVE_REPORT_PATH = resolve(process.cwd(), 'artifacts/acceptance-live-report.json');
const ENABLED = process.env.LAUNCHPAD_LIVE_ACCEPTANCE === '1';

function writeLiveReport(report: unknown): void {
  mkdirSync(dirname(LIVE_REPORT_PATH), { recursive: true });
  const serialized = `${JSON.stringify(report, (key, value) => (typeof value === 'string' ? redactResourceIds(value) : value), 2)}\n`;
  writeFileSync(LIVE_REPORT_PATH, serialized, 'utf8');
}

if (!ENABLED) {
  writeLiveReport({
    schemaVersion: 'launchpad.acceptance/v1',
    mode: 'skipped',
    command: 'yarn acceptance:live',
    generatedAt: new Date().toISOString(),
    reason: 'LAUNCHPAD_LIVE_ACCEPTANCE is not set to 1; live sandbox acceptance is opt-in and skipped. A skipped run is NOT release evidence.',
    phases: [],
    liveGates: [],
  });
  it.skip('live sandbox acceptance is disabled (LAUNCHPAD_LIVE_ACCEPTANCE != 1); no evidence claimed', () => undefined);
} else {
  const started = performance.now();

  function requiredEnv(name: string): string {
    const value = process.env[name];
    if (value === undefined || value.trim() === '') {
      throw new Error(`LP_LIVE_MISSING_ENV: ${name} is required when LAUNCHPAD_LIVE_ACCEPTANCE=1`);
    }
    return value.trim();
  }

  const prefix = requiredEnv('LP_LIVE_SANDBOX_PREFIX');
  const githubToken = requiredEnv('LP_LIVE_GITHUB_TOKEN');
  const repository = requiredEnv('LP_LIVE_GITHUB_REPOSITORY');
  const repositoryId = requiredEnv('LP_LIVE_GITHUB_REPOSITORY_ID');
  const vercelToken = requiredEnv('LP_LIVE_VERCEL_TOKEN');
  const teamId = requiredEnv('LP_LIVE_VERCEL_TEAM_ID');
  const projectId = requiredEnv('LP_LIVE_VERCEL_PROJECT');
  const cloudflareToken = requiredEnv('LP_LIVE_CLOUDFLARE_TOKEN');
  const zoneName = requiredEnv('LP_LIVE_CLOUDFLARE_ZONE');
  const domain = requiredEnv('LP_LIVE_DOMAIN');

  // Ambiguity guards (defense in depth; the wrapper script already enforces these).
  if (!projectId.startsWith(prefix)) throw new Error(`LP_LIVE_AMBIGUOUS_TARGET: project '${projectId}' does not start with sandbox prefix '${prefix}'`);
  if (!domain.startsWith(prefix)) throw new Error(`LP_LIVE_AMBIGUOUS_TARGET: domain '${domain}' does not start with sandbox prefix '${prefix}'`);
  if (!zoneName.split('.').includes(prefix.replace(/-+$/, ''))) throw new Error(`LP_LIVE_AMBIGUOUS_TARGET: zone '${zoneName}' does not contain sandbox prefix '${prefix}'`);
  if (!repository.includes(prefix)) throw new Error(`LP_LIVE_AMBIGUOUS_TARGET: repository '${repository}' does not contain sandbox prefix '${prefix}'`);
  if (!/^\d+$/.test(repositoryId)) throw new Error(`LP_LIVE_AMBIGUOUS_TARGET: repository id '${repositoryId}' is not numeric`);

  const context: ProviderContext = { correlationId: 'live-acceptance', applicationId: projectId, workflowId: 'live-acceptance', actor: { kind: 'system', id: 'live-acceptance' }, dryRun: false };
  const zoneRef = `config://cloudflare/${zoneName}`;

  // Real adapters, real provider network. No fetchImpl overrides anywhere.
  const github = new GitHubAdapter({ token: githubToken });
  const vercel = new VercelAdapter({ token: vercelToken, teamId });
  const cloudflare = new CloudflareAdapter({ token: cloudflareToken });

  const healthSpec = { path: '/api/health', method: 'GET', expectedStatus: [200], timeoutSeconds: 10, attempts: 3, intervalSeconds: 1 };

  interface PhaseRecord { name: string; status: 'passed' | 'failed'; durationMs: number; observed: string; resourceIds?: Record<string, string>; }

  interface LiveGateReportEntry { id: string; command: string; description: string; status: 'passed' | 'failed' | 'unclaimed'; note?: string; }

  /** Truthful per-gate status for the live report, derived only from phases that actually ran. */
  function liveGateEntries(phaseEntries: PhaseRecord[]): LiveGateReportEntry[] {
    const e2ePhaseNames = ['observe', 'create-or-update', 'preview', 'health', 'drift-restore', 'cleanup'];
    return LIVE_GATES.map((gate) => {
      if (gate.id === 'LIVE-RULESET') {
        return { ...gate, status: 'unclaimed' as const, note: "verified separately by 'node scripts/verify-ruleset.mjs' against the control repository in the deploy gate (distinct token)" };
      }
      const passed = gate.id === 'LIVE-DIRECT-PUSH'
        ? phaseEntries.some((entry) => entry.name === 'direct-push-rejected' && entry.status === 'passed')
        : e2ePhaseNames.every((name) => phaseEntries.some((entry) => entry.name === name && entry.status === 'passed'));
      return { ...gate, status: passed ? 'passed' as const : 'failed' as const };
    });
  }

  const phases: PhaseRecord[] = [];
  async function phase<T>(name: string, run: () => Promise<T & { observed: string; resourceIds?: Record<string, string> }>): Promise<T & { observed: string; resourceIds?: Record<string, string> }> {
    const phaseStarted = performance.now();
    try {
      const outcome = await run();
      phases.push({ name, status: 'passed', durationMs: Math.round(performance.now() - phaseStarted), observed: outcome.observed, ...(outcome.resourceIds !== undefined ? { resourceIds: outcome.resourceIds } : {}) });
      return outcome;
    } catch (error) {
      phases.push({ name, status: 'failed', durationMs: Math.round(performance.now() - phaseStarted), observed: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  function projectSpec(overrides: Partial<ProjectSpec> = {}): ProjectSpec {
    return {
      id: projectId,
      name: projectId,
      teamId,
      framework: null,
      rootDirectory: '.',
      nodeVersion: '24.x',
      build: { installCommand: 'yarn install --immutable', buildCommand: 'yarn build', outputDirectory: null },
      repository,
      productionBranch: 'main',
      settings: { autoAssignProductionDomains: false },
      ...overrides,
    };
  }

  function flatProjectConfig(configuration: Record<string, unknown>): Record<string, unknown> {
    const keys = ['name', 'framework', 'rootDirectory', 'nodeVersion', 'installCommand', 'buildCommand', 'outputDirectory', 'autoAssignProductionDomains', 'prioritizeProductionBuilds', 'rollingRelease', 'skewProtection'] as const;
    return Object.fromEntries(keys.map((key) => [key, key in configuration ? configuration[key] : null]));
  }

  it('live sandbox acceptance: observe → create/update → preview → health → drift-restore → cleanup → direct-push-rejected', async () => {
    let created = false;
    let baselineProject: Record<string, unknown> | null = null;
    let baselineRecord: Record<string, unknown> | null = null;
    let deploymentUrl: string | null = null;

    try {
      // 1. Observe the dedicated sandbox resources.
      const baseline = await phase('observe', async () => {
        const repositoryObservation = await github.observeRepository(repository, context);
        if (!repositoryObservation.access) throw new Error(`LP_LIVE_PREREQ: repository '${repository}' is not accessible with the provided token`);
        const observedProject = await vercel.observeProject({ projectId }, context);
        const zone = await cloudflare.observeZone(zoneRef, context);
        const record = await cloudflare.observeRecord(zone.zoneId, domain, context);
        baselineProject = observedProject !== null ? (observedProject.configuration as Record<string, unknown>) : null;
        baselineRecord = record !== null ? (record as unknown as Record<string, unknown>) : null;
        return {
          observed: `repository '${repository}' accessible; project ${observedProject === null ? 'absent' : `present (${observedProject.providerResourceId})`}; zone '${zone.name}' found; dns record ${record === null ? 'absent' : `present (${record.id})`}`,
          resourceIds: {
            githubRepository: repository,
            vercelProject: observedProject?.providerResourceId ?? projectId,
            cloudflareZone: zone.zoneId,
            dnsRecord: record?.id ?? null,
          } as Record<string, string>,
        };
      });

      // 2. Create (when absent) or update. The only safe reversible setting
      // mutation is autoAssignProductionDomains → false (never auto-assigns
      // domains); the drift-restore phase writes the baseline value back.
      await phase('create-or-update', async () => {
        const spec = projectSpec({ settings: { autoAssignProductionDomains: false } });
        created = baselineProject === null;
        const mutation = await vercel.ensureProject(spec, context);
        await vercel.ensureGitConnection({ projectId, repository, productionBranch: 'main' }, context);
        const verified = await vercel.observeProject({ projectId }, context);
        if (verified === null) throw new Error('LP_LIVE_READBACK: project not observed after ensure');
        return {
          observed: `${created ? 'created' : 'updated'} project '${mutation.resource.providerResourceId}' (changed=${mutation.changed}); readback confirmed`,
          resourceIds: { vercelProject: mutation.resource.providerResourceId },
        };
      });

      // 3. Real preview deployment of the exact sandbox main commit.
      const preview = await phase('preview', async () => {
        const ref = await github.resolveRef(repository, 'main', context);
        const deployment = await vercel.createDeployment({
          projectId,
          environment: 'preview',
          repository,
          commitSha: ref.sha,
          desiredGeneration: 1,
          staged: false,
          rootDirectory: '.',
        }, context);
        const terminal = await vercel.waitForDeployment({ projectId, deploymentId: deployment.id, timeoutMs: 600_000, pollMs: 10_000 }, context);
        if (terminal.state !== 'READY') {
          let excerpt = '';
          try {
            excerpt = (await vercel.fetchDeploymentLogs({ deploymentId: terminal.id, maxLines: 50, maxBytes: 4096 }, context)).excerpt;
          } catch {
            excerpt = '(logs unavailable)';
          }
          throw new Error(`LP_LIVE_PREVIEW: deployment '${terminal.id}' ended in ${terminal.state}; log excerpt: ${excerpt}`);
        }
        if (terminal.url === null) throw new Error('LP_LIVE_PREVIEW: READY deployment carried no URL');
        deploymentUrl = terminal.url;
        return {
          observed: `preview deployment '${terminal.id}' READY at ${terminal.url}`,
          resourceIds: { deployment: terminal.id },
        };
      });

      // 4. Health gate against the live preview.
      await phase('health', async () => {
        if (deploymentUrl === null) throw new Error('LP_LIVE_HEALTH: no preview URL from the preview phase');
        const record = await checkHealth({
          applicationId: projectId,
          environment: 'preview',
          deploymentId: preview.resourceIds?.deployment ?? null,
          baseUrl: deploymentUrl,
          spec: healthSpec,
        });
        if (record.result !== 'PASSED') throw new Error(`LP_LIVE_HEALTH: health check failed (${record.errorCode ?? record.result})`);
        return { observed: `health PASSED against ${deploymentUrl} (HTTP ${record.statusCode})` };
      });

      // 5. Drift restore: write the baseline settings back and verify convergence.
      await phase('drift-restore', async () => {
        const spec = projectSpec({
          settings: {
            autoAssignProductionDomains: baselineProject !== null && typeof baselineProject.autoAssignProductionDomains === 'boolean' ? baselineProject.autoAssignProductionDomains : false,
          },
        });
        await vercel.ensureProject(spec, context);
        const observed = await vercel.observeProject({ projectId }, context);
        if (observed === null) throw new Error('LP_LIVE_RESTORE: project disappeared during drift restore');
        const expected = flatProjectConfig(baselineProject ?? {});
        const actual = flatProjectConfig(observed.configuration as Record<string, unknown>);
        const drift = Object.keys(expected).filter((key) => canonicalJson(expected[key]) !== canonicalJson(actual[key]));
        if (drift.length > 0) throw new Error(`LP_LIVE_RESTORE: drift remains after restore: ${drift.join(', ')}`);
        return { observed: 'project settings restored to the baseline observation; no drift remains' };
      });

      // 6. Cleanup: delete only what this run created; otherwise verify nothing changed.
      await phase('cleanup', async () => {
        if (created) {
          await vercel.deleteProject(projectId, context);
          const readback = await vercel.observeProject({ projectId }, context);
          if (readback !== null) throw new Error('LP_LIVE_CLEANUP: project still exists after delete');
          return { observed: `cleanup deleted the project created by this run (${projectId})` };
        }
        const observed = await vercel.observeProject({ projectId }, context);
        if (observed === null) throw new Error('LP_LIVE_CLEANUP: pre-existing sandbox project disappeared');
        const baselineFlat = flatProjectConfig(baselineProject ?? {});
        const actualFlat = flatProjectConfig(observed.configuration as Record<string, unknown>);
        const drift = Object.keys(baselineFlat).filter((key) => canonicalJson(baselineFlat[key]) !== canonicalJson(actualFlat[key]));
        if (drift.length > 0) throw new Error(`LP_LIVE_CLEANUP: pre-existing project drifted from baseline: ${drift.join(', ')}`);
        const zone = await cloudflare.observeZone(zoneRef, context);
        const record = await cloudflare.observeRecord(zone.zoneId, domain, context);
        const baselineRecordId = baselineRecord !== null ? (baselineRecord.id as string | null) : null;
        const recordChanged = (record?.id ?? null) !== baselineRecordId;
        if (recordChanged) throw new Error('LP_LIVE_CLEANUP: sandbox DNS record changed from baseline; nothing may be left behind');
        return { observed: 'pre-existing sandbox resources verified unchanged at baseline; nothing deleted' };
      });

      // 7. Direct-push rejection probe: an unattached child commit of the
      // default-branch head must be refused by an explicit ruleset/branch-
      // protection rejection when a non-force fast-forward update of the
      // default-branch ref is attempted. Unexpected success restores the
      // original ref (inside the probe) and fails loudly.
      await phase('direct-push-rejected', async () => {
        const probe = await probeDirectPushRejected({ client: github.client, repository, correlationId: context.correlationId });
        return {
          observed: `direct push to refs/heads/${probe.defaultBranch} rejected (HTTP ${probe.attemptStatus}, ${probe.rejectionReason}); unattached probe commit ${probe.probeSha} did not land; ref unchanged at ${probe.headSha}`,
        };
      });

      const report = {
        schemaVersion: 'launchpad.acceptance/v1',
        mode: 'passed',
        command: 'yarn acceptance:live',
        generatedAt: new Date().toISOString(),
        durationMs: Math.round(performance.now() - started),
        sandbox: {
          prefix,
          githubRepository: repository,
          githubRepositoryId: repositoryId,
          vercelProject: projectId,
          cloudflareZone: zoneName,
          domain,
        },
        phases,
        liveGates: liveGateEntries(phases),
        summary: { total: phases.length, passed: phases.filter((entry) => entry.status === 'passed').length, failed: phases.filter((entry) => entry.status === 'failed').length },
      };
      writeLiveReport(report);
      expect(report.summary.failed).toBe(0);
      expect(report.summary.passed).toBe(7);
      expect(report.liveGates.find((gate) => gate.id === 'LIVE-DIRECT-PUSH')?.status).toBe('passed');
    } catch (error) {
      writeLiveReport({
        schemaVersion: 'launchpad.acceptance/v1',
        mode: 'failed',
        command: 'yarn acceptance:live',
        generatedAt: new Date().toISOString(),
        durationMs: Math.round(performance.now() - started),
        sandbox: { prefix, githubRepository: repository, vercelProject: projectId, cloudflareZone: zoneName, domain },
        phases,
        liveGates: liveGateEntries(phases),
        summary: { total: phases.length, passed: phases.filter((entry) => entry.status === 'passed').length, failed: phases.filter((entry) => entry.status === 'failed').length },
        failure: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }, 30 * 60 * 1000);
}
