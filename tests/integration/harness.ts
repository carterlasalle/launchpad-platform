import { readFileSync } from 'node:fs';
import type { D1Database } from '@cloudflare/workers-types';
import { DatabaseSync } from 'node:sqlite';
import type { ProviderContext } from '@launchpad/provider-contract';
import { InMemoryDatabase, LaunchpadRepositories } from '@launchpad/database';
import { loadCatalog } from '@launchpad/catalog';
import type { DesiredApplication } from '@launchpad/core';
import { GitHubAdapter } from '@launchpad/provider-github';
import { VercelAdapter } from '@launchpad/provider-vercel';
import { CloudflareAdapter } from '@launchpad/provider-cloudflare';
import { EnvironmentSecretProvider } from '@launchpad/provider-secrets';
import { controllerDependencies, createWorkflowHandlers } from '../../apps/controller/src/handlers.js';
import { createControllerApp } from '../../apps/controller/src/api.js';
import type { ControllerEnv, WorkflowBinding } from '../../apps/controller/src/env.js';
import { buildObservability } from '../../apps/controller/src/observability.js';
import { createD1Shim, type D1TestShim } from '../fixtures/d1.js';
import { RecordedTransport } from '../fixtures/transport.js';
import { createOidcTestKeys, type OidcTestKeys } from '../fixtures/oidc.js';
import { WorkflowStepHarness, workflowEvent, type WorkflowEventShape } from '../fixtures/workflow-harness.js';
import {
  createCloudflareState, createGithubState, createHealthState, createVercelState, mountProviders,
  vercelProject,
  type CloudflareState, type GithubState, type HealthState, type VercelState,
} from '../fixtures/providers.js';

export const ISSUER = 'https://token.actions.test';
export const AUDIENCE = 'launchpad-test';
export const CONTROL_REPOSITORY = 'example/control';
export const MANIFEST_PATH = 'catalog/apps/fixture-app.yaml';
export const MAIN_SHA = 'c'.repeat(40);
export const SOURCE_COMMIT = 'a'.repeat(40);
export const HEAD_SHA = 'b'.repeat(40);
export const MERGE_SHA = 'd'.repeat(40);

export interface ProviderStates {
  github: GithubState;
  vercel: VercelState;
  cloudflare: CloudflareState;
  health: HealthState;
}

export interface HarnessOptions {
  controlRepository?: string;
  resolveDns?: (hostname: string, type: string, nameservers: string[]) => Promise<string[]>;
  envOverrides?: Record<string, unknown>;
  /** Secret provider the apply phases resolve source-based bindings with (defaults to an empty EnvironmentSecretProvider). */
  secrets?: EnvironmentSecretProvider;
}

export interface ControllerHarness {
  transport: RecordedTransport;
  d1: D1Database;
  raw: DatabaseSync;
  store: D1TestShim['store'];
  /** Structural slice of the Hono controller app the tests drive. */
  app: {
    request(input: RequestInfo | URL, init?: RequestInit, env?: unknown): Promise<Response>;
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  };
  env: Record<string, unknown>;
  workflowEnv: Record<string, unknown>;
  oidc: OidcTestKeys;
  states: ProviderStates;
  workflowInstances: Array<{ id: string; params: Record<string, unknown> }>;
  queueMessages: unknown[];
  /** Real adapters wired to the recorded transport (same instances the handlers use). */
  github: GitHubAdapter;
  vercel: VercelAdapter;
  cloudflare: CloudflareAdapter;
  /** DNS answers the Cloudflare adapter resolver returns (mutable per test). */
  dnsAnswers: string[];
  /** Builds a ProviderContext in the controller's shape. */
  context(workflowId?: string): ProviderContext;
  /** Fetches the fixture manifest content from tests/fixtures/catalog. */
  fixtureYaml(): string;
  /** Loads the fixture manifest through the real catalog loader. */
  loadFixtureDesired(): Promise<DesiredApplication>;
  /** Writes the control-repository manifest at a ref (defaults to current main). */
  setControlManifest(content: string, ref?: string): void;
  /** Writes any control-repository file at a ref (defaults to current main). */
  setControlFile(path: string, content: string, ref?: string): void;
  /** Seeds a matching Vercel project (the applied-application shape). */
  seedVercelProject(overrides?: Record<string, unknown>): void;
  registerApplication(): Promise<void>;
  request(path: string, init?: RequestInit): Promise<Response>;
  /** Drives a real Cloudflare Workflow class with the step harness. */
  runWorkflow<P = Record<string, unknown>>(WorkflowClass: new (ctx: unknown, env: unknown) => { run(event: WorkflowEventShape<P>, step: unknown): Promise<unknown> }, params: P, options?: { interruptAfter?: number; instanceId?: string }): Promise<{ result: unknown; steps: WorkflowStepHarness }>;
  restore(): void;
}

let fixtureYamlCache: string | null = null;

function fixtureYaml(): string {
  if (fixtureYamlCache === null) fixtureYamlCache = readFileSync(new URL('../fixtures/catalog/fixture-app.yaml', import.meta.url), 'utf8');
  return fixtureYamlCache;
}

export async function createHarness(options: HarnessOptions = {}): Promise<ControllerHarness> {
  const shim = createD1Shim();
  const transport = new RecordedTransport();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = transport.fetchImpl;

  const states: ProviderStates = {
    github: createGithubState({ repoId: 424242 }),
    vercel: createVercelState(),
    cloudflare: createCloudflareState(),
    health: createHealthState(),
  };
  mountProviders(transport, states);

  const oidc = await createOidcTestKeys(ISSUER, AUDIENCE);
  transport.route('oidc:jwks', (method, url) => method === 'GET' && url.href === oidc.jwksUrl, () => ({ status: 200, body: oidc.jwksBody }));

  const workflowInstances: Array<{ id: string; params: Record<string, unknown> }> = [];
  const queueMessages: unknown[] = [];
  const workflowBinding: WorkflowBinding = {
    create: async (input) => {
      workflowInstances.push({ id: input.id ?? '', params: input.params as Record<string, unknown> });
      return { id: input.id ?? '' };
    },
  };
  const queue = { send: async (message: unknown) => { queueMessages.push(message); } };

  const dnsAnswers: string[] = ['cname.vercel-dns.com'];
  const resolveDns: (hostname: string, type: string, nameservers: string[]) => Promise<string[]> = options.resolveDns ?? (async () => [...dnsAnswers]);

  const github = new GitHubAdapter({ token: 'ghp_integration', fetchImpl: transport.fetchImpl });
  const vercel = new VercelAdapter({ token: 'vercel_integration', fetchImpl: transport.fetchImpl });
  const cloudflare = new CloudflareAdapter({
    token: 'cf_integration',
    fetchImpl: transport.fetchImpl,
    resolveDns,
    verification: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 50, timeoutMs: 5_000, jitter: () => 0, sleep: async () => undefined },
  });

  const controlRepository = options.controlRepository ?? CONTROL_REPOSITORY;
  const env: Record<string, unknown> = {
    DB: shim.d1,
    CONTROLLER_INTERNAL_URL: 'http://internal',
    CONTROLLER_INTERNAL_TOKEN: 'internal-token',
    OPERATOR_TOKEN: 'operator-token',
    CONTROL_REPOSITORY: controlRepository,
    GITHUB_TOKEN: 'ghp_integration',
    GITHUB_BASE_URL: 'https://api.github.com',
    VERCEL_TOKEN: 'vercel_integration',
    CLOUDFLARE_TOKEN: 'cf_integration',
    VERCEL_WEBHOOK_SECRET: 'webhook-secret',
    OIDC_ISSUER: ISSUER,
    OIDC_AUDIENCE: AUDIENCE,
    OIDC_JWKS: oidc.jwksUrl,
    APPLY_WORKFLOW: workflowBinding,
    PREVIEW_WORKFLOW: workflowBinding,
    APP_PREVIEW_STATUS_WORKFLOW: workflowBinding,
    RECONCILE_WORKFLOW: workflowBinding,
    DECOMMISSION_WORKFLOW: workflowBinding,
    PROVIDER_EVENTS: queue,
    HEALTH_CHECKS: queue,
    LAUNCHPAD_ALERTS_ENABLED: 'true',
    ...(options.envOverrides ?? {}),
  } as Record<string, unknown>;

  const repositories = new LaunchpadRepositories(new InMemoryDatabase());
  const observability = buildObservability(env as ControllerEnv['Bindings'], shim.store);
  const dependencies = controllerDependencies(env as ControllerEnv['Bindings'], repositories, observability);
  dependencies.workflowHandlers = createWorkflowHandlers(env as ControllerEnv['Bindings'], repositories, { providers: { vercel, cloudflare, github, ...(options.secrets !== undefined ? { secrets: options.secrets } : {}) } });
  const app = createControllerApp({ ...dependencies, store: shim.store });

  let appRef: { current: typeof app } = { current: app };
  transport.route('internal:workflows', (method, url) => method === 'POST' && url.origin === 'http://internal' && url.pathname.startsWith('/internal/workflows/'), async (request) => {
    const response = await appRef.current.fetch(new Request(request.url.href, { method: request.method, headers: request.headers, body: request.bodyText ?? undefined }));
    return { status: response.status, body: await response.text() };
  });

  const workflowEnv: Record<string, unknown> = {
    CONTROLLER_INTERNAL_URL: 'http://internal',
    CONTROLLER_INTERNAL_TOKEN: 'internal-token',
    DB: shim.d1,
    GITHUB_TOKEN: 'ghp_integration',
    GITHUB_BASE_URL: 'https://api.github.com',
    LAUNCHPAD_ALERTS_ENABLED: 'true',
    LAUNCHPAD_LOG_LEVEL: 'info',
  };

  const harness: ControllerHarness = {
    transport,
    d1: shim.d1,
    raw: shim.raw,
    store: shim.store,
    app,
    env,
    workflowEnv,
    oidc,
    states,
    workflowInstances,
    queueMessages,
    github,
    vercel,
    cloudflare,
    dnsAnswers,
    context: (workflowId?: string) => ({ correlationId: 'integration-correlation', applicationId: 'fixture-app', workflowId: workflowId ?? 'integration-workflow', actor: { kind: 'github-actions', id: 'workflow' }, dryRun: false }),
    fixtureYaml,
    loadFixtureDesired: async () => {
      const catalog = loadCatalog([{ path: MANIFEST_PATH, content: fixtureYaml() }]);
      if (catalog.issues.length > 0) throw new Error(`fixture manifest invalid: ${catalog.issues[0]?.code ?? 'unknown'}`);
      const desired = catalog.applications.find((application) => application.metadata.id === 'fixture-app');
      if (!desired) throw new Error('fixture manifest has no fixture-app application');
      return desired;
    },
    setControlManifest: (content: string, ref?: string) => {
      harness.setControlFile(MANIFEST_PATH, content, ref);
    },
    setControlFile: (path: string, content: string, ref?: string) => {
      states.github.refs.set(states.github.defaultBranch, MAIN_SHA);
      const file = { content, sha: `control-file-${content.length}` };
      states.github.mainFiles.set(path, file);
      const target = ref ?? MAIN_SHA;
      if (target !== MAIN_SHA && !states.github.refs.has(target)) {
        const snapshot = states.github.commits.get(target) ?? new Map();
        snapshot.set(path, file);
        states.github.commits.set(target, snapshot);
      }
    },
    seedVercelProject: (overrides?: Record<string, unknown>) => {
      states.vercel.projects.set('fixture-app', vercelProject('fixture-app', overrides));
    },
    registerApplication: async () => {
      await harness.store.upsertApplication({ id: 'fixture-app', displayName: 'Fixture App', sourcePath: MANIFEST_PATH, desiredGeneration: 0, desiredHash: '', syncStatus: 'UNKNOWN', healthStatus: 'UNKNOWN', lifecycleState: 'active', owners: ['@platform'] });
    },
    request: (path: string, init?: RequestInit) => harness.app.request(path, init, harness.env as never),
    runWorkflow: async (WorkflowClass, params, workflowOptions) => {
      const steps = new WorkflowStepHarness({ interruptAfter: workflowOptions?.interruptAfter });
      const instance = new WorkflowClass({} as never, harness.workflowEnv);
      const event = workflowEvent(params as Record<string, unknown>, workflowOptions?.instanceId ?? `inst-${Math.random().toString(36).slice(2)}`);
      const result = await instance.run(event, steps as never);
      return { result, steps };
    },
    restore: () => { globalThis.fetch = originalFetch; },
  };
  harness.setControlFile('catalog/zones.yaml', 'apiVersion: launchpad.dev/v1\nzones:\n  - example.com\n');
  return harness;
}
