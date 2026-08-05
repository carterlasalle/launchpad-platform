import { stringify } from 'yaml';
import { idempotencyKey } from '@launchpad/shared';
import { RecordedTransport } from './transport.js';

/**
 * Stateful, offline simulations of the GitHub REST API, Vercel REST API, and
 * Cloudflare API mounted on a `RecordedTransport`. The real adapters
 * (GitHubAdapter/VercelAdapter/CloudflareAdapter) talk to these through their
 * injected `fetchImpl`; every request is recorded for exactness assertions.
 * State mutation follows the real API semantics the adapters rely on (ref
 * conflicts as 422, contents by branch/ref, deployments by id).
 */

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

export interface GithubFile { content: string; sha: string; }
export interface GithubPull { number: number; branch: string; sha: string; }

export interface GithubState {
  repoId: number;
  defaultBranch: string;
  /** branch -> head sha */
  refs: Map<string, string>;
  /** branch -> path -> file (branches created through POST /git/refs) */
  branches: Map<string, Map<string, GithubFile>>;
  /** files at the default branch */
  mainFiles: Map<string, GithubFile>;
  /** historical commit snapshots: sha -> path -> file (reads at exact commits) */
  commits: Map<string, Map<string, GithubFile>>;
  /** open pull requests by number */
  pulls: Map<number, GithubPull>;
  /** issue comments by issue number */
  comments: Map<number, Array<{ id: number; body: string; html_url: string }>>;
  /** deployment records by commit ref + environment */
  deployments: Array<{ id: number; ref: string; environment: string; url: string | null }>;
  nextCommentId: number;
  nextDeploymentId: number;
  nextPullNumber: number;
  nextFileSha: number;
}

export function createGithubState(options: { repoId?: number; defaultBranch?: string } = {}): GithubState {
  return {
    repoId: options.repoId ?? 424242,
    defaultBranch: options.defaultBranch ?? 'main',
    refs: new Map(),
    branches: new Map(),
    mainFiles: new Map(),
    commits: new Map(),
    pulls: new Map(),
    comments: new Map(),
    deployments: [],
    nextCommentId: 900,
    nextDeploymentId: 500,
    nextPullNumber: 7,
    nextFileSha: 1,
  };
}

export function setGithubFile(state: GithubState, ref: string, path: string, content: string): string {
  const sha = `file-sha-${state.nextFileSha++}`;
  const file: GithubFile = { content, sha };
  if (state.refs.has(ref) && ref === state.refs.get(state.defaultBranch)) {
    state.mainFiles.set(path, file);
  } else if (state.refs.has(ref)) {
    const branch = state.branches.get(ref) ?? new Map();
    branch.set(path, file);
    state.branches.set(ref, branch);
  } else {
    const snapshot = state.commits.get(ref) ?? new Map();
    snapshot.set(path, file);
    state.commits.set(ref, snapshot);
  }
  return sha;
}

/** Reads a file at a ref: branch name, the current main commit sha, or a historical commit sha. */
export function githubFileAt(state: GithubState, ref: string, path: string): GithubFile | null {
  const refs = state.refs.get(state.defaultBranch);
  if (ref === state.defaultBranch || (refs !== undefined && ref === refs)) {
    return state.mainFiles.get(path) ?? null;
  }
  if (state.refs.has(ref)) {
    return state.branches.get(ref)?.get(path) ?? null;
  }
  return state.commits.get(ref)?.get(path) ?? null;
}

function githubPathParts(pathname: string): string[] {
  return pathname.split('/').filter((part) => part.length > 0);
}

function fileResponse(file: GithubFile): Record<string, unknown> {
  return { type: 'file', sha: file.sha, content: Buffer.from(file.content, 'utf8').toString('base64'), encoding: 'base64' };
}

function notFound(body: Record<string, unknown> = {}): { status: number; body: unknown } {
  return { status: 404, body: { message: 'Not Found', ...body } };
}

/** Mounts the GitHub REST API simulation. Base URL must be https://api.github.com (the controller hardcodes it). */
export function mountGithubApi(transport: RecordedTransport, state: GithubState): void {
  const repoInfo = () => ({ id: state.repoId, archived: false, private: true, default_branch: state.defaultBranch });

  transport.route('github:repo', (method, url) => method === 'GET' && /^\/repos\/[^/]+\/[^/]+$/.test(url.pathname), () => ({ status: 200, body: repoInfo() }));

  transport.route('github:ref', (method, url) => method === 'GET' && /^\/repos\/[^/]+\/[^/]+\/git\/ref\/heads\/[^/]+$/.test(url.pathname), (request) => {
    const branch = decodeURIComponent(request.url.pathname.split('/').at(-1) ?? '');
    const sha = state.refs.get(branch);
    if (!sha) return notFound({ message: 'Not Found' });
    return { status: 200, body: { object: { sha, type: 'commit', url: request.url.href } } };
  });

  transport.route('github:create-ref', (method, url) => method === 'POST' && /^\/repos\/[^/]+\/[^/]+\/git\/refs$/.test(url.pathname), (request) => {
    const body = request.body as { ref?: unknown; sha?: unknown };
    const name = typeof body?.ref === 'string' ? body.ref.replace(/^refs\/heads\//, '') : '';
    if (!name || typeof body?.sha !== 'string') return { status: 422, body: { message: 'Validation Failed' } };
    if (state.refs.has(name)) {
      // GitHub returns 422 when the ref already exists; the adapter maps
      // CONFLICT and treats it as idempotent reuse.
      return { status: 422, body: { message: `Reference already exists: refs/heads/${name}` } };
    }
    state.refs.set(name, body.sha);
    state.branches.set(name, new Map());
    return { status: 201, body: { ref: `refs/heads/${name}`, object: { sha: body.sha } } };
  });

  transport.route('github:contents', (method, url) => method === 'GET' && /^\/repos\/[^/]+\/[^/]+\/contents\/.+$/.test(url.pathname) && !url.pathname.includes('/git/'), (request) => {
    const parts = githubPathParts(request.url.pathname);
    const path = decodeURIComponent(parts.slice(4).join('/'));
    const ref = request.url.searchParams.get('ref') ?? state.defaultBranch;
    const file = githubFileAt(state, ref, path);
    if (!file) return notFound();
    return { status: 200, body: fileResponse(file) };
  });

  transport.route('github:put-contents', (method, url) => method === 'PUT' && /^\/repos\/[^/]+\/[^/]+\/contents\/.+$/.test(url.pathname), (request) => {
    const parts = githubPathParts(request.url.pathname);
    const path = decodeURIComponent(parts.slice(4).join('/'));
    const body = request.body as { content?: unknown; branch?: unknown; sha?: unknown; message?: unknown };
    const branch = typeof body?.branch === 'string' ? body.branch : state.defaultBranch;
    if (typeof body?.content !== 'string') return { status: 422, body: { message: 'Validation Failed' } };
    const content = Buffer.from(body.content, 'base64').toString('utf8');
    const file: GithubFile = { content, sha: `file-sha-${state.nextFileSha++}` };
    const tree = state.branches.get(branch) ?? state.mainFiles;
    if (!state.branches.has(branch) && branch === state.defaultBranch) state.mainFiles = tree;
    tree.set(path, file);
    return { status: 200, body: { content: fileResponse(file), commit: { sha: `commit-${state.nextFileSha}` } } };
  });

  transport.route('github:pulls-list', (method, url) => method === 'GET' && /^\/repos\/[^/]+\/[^/]+\/pulls$/.test(url.pathname), (request) => {
    const head = request.url.searchParams.get('head');
    const branch = head?.includes(':') ? head.split(':')[1] : head;
    const matches = [...state.pulls.values()].filter((pull) => branch === undefined || pull.branch === branch);
    return { status: 200, body: matches.map((pull) => ({ number: pull.number, html_url: `https://github.com/repo/pull/${pull.number}`, head: { ref: pull.branch, sha: pull.sha } })) };
  });

  transport.route('github:pull-get', (method, url) => method === 'GET' && /^\/repos\/[^/]+\/[^/]+\/pulls\/\d+$/.test(url.pathname), (request) => {
    const number = Number(request.url.pathname.split('/').at(-1));
    const pull = state.pulls.get(number);
    if (!pull) return notFound({ message: 'Not Found' });
    return { status: 200, body: { number: pull.number, html_url: `https://github.com/repo/pull/${pull.number}`, head: { ref: pull.branch, sha: pull.sha } } };
  });

  transport.route('github:pull-create', (method, url) => method === 'POST' && /^\/repos\/[^/]+\/[^/]+\/pulls$/.test(url.pathname), (request) => {
    const body = request.body as { head?: unknown; title?: unknown; body?: unknown };
    const branch = typeof body?.head === 'string' ? body.head : '';
    const number = state.nextPullNumber++;
    const headSha = state.refs.get(branch) ?? `sha-${number}`;
    state.pulls.set(number, { number, branch, sha: headSha });
    return { status: 201, body: { number, html_url: `https://github.com/repo/pull/${number}`, title: body?.title ?? '', body: body?.body ?? '' } };
  });

  transport.route('github:pull-patch', (method, url) => method === 'PATCH' && /^\/repos\/[^/]+\/[^/]+\/pulls\/\d+$/.test(url.pathname), (request) => {
    const number = Number(request.url.pathname.split('/').at(-1));
    const pull = state.pulls.get(number);
    if (!pull) return notFound({ message: 'Not Found' });
    return { status: 200, body: { number: pull.number, html_url: `https://github.com/repo/pull/${pull.number}`, head: { ref: pull.branch, sha: pull.sha } } };
  });

  transport.route('github:comments-list', (method, url) => method === 'GET' && /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments/.test(url.pathname), (request) => {
    const number = Number(request.url.pathname.split('/').at(-2));
    return { status: 200, body: state.comments.get(number) ?? [] };
  });

  transport.route('github:comment-create', (method, url) => method === 'POST' && /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments/.test(url.pathname), (request) => {
    const number = Number(request.url.pathname.split('/').at(-2));
    const body = request.body as { body?: unknown };
    const id = state.nextCommentId++;
    const comment = { id, body: typeof body?.body === 'string' ? body.body : '', html_url: `https://github.com/repo/issues/comments/${id}` };
    state.comments.set(number, [...(state.comments.get(number) ?? []), comment]);
    return { status: 201, body: comment };
  });

  transport.route('github:comment-patch', (method, url) => method === 'PATCH' && /^\/repos\/[^/]+\/[^/]+\/issues\/comments\/\d+$/.test(url.pathname), (request) => {
    const id = Number(request.url.pathname.split('/').at(-1));
    const body = request.body as { body?: unknown };
    for (const comments of state.comments.values()) {
      const comment = comments.find((candidate) => candidate.id === id);
      if (comment) {
        comment.body = typeof body?.body === 'string' ? body.body : comment.body;
        return { status: 200, body: comment };
      }
    }
    return notFound({ message: 'Not Found' });
  });

  transport.route('github:commit-status', (method, url) => method === 'POST' && /^\/repos\/[^/]+\/[^/]+\/statuses\/[0-9a-f]+$/.test(url.pathname), (request) => {
    const sha = decodeURIComponent(request.url.pathname.split('/').at(-1) ?? '');
    const id = state.nextDeploymentId + 5000;
    return { status: 201, body: { id, sha, state: 'failure', url: `https://api.github.com/repos/x/y/statuses/${sha}/${id}` } };
  });

  transport.route('github:deployments-list', (method, url) => method === 'GET' && /^\/repos\/[^/]+\/[^/]+\/deployments$/.test(url.pathname), (request) => {
    const ref = request.url.searchParams.get('ref');
    const environment = request.url.searchParams.get('environment');
    const matches = state.deployments.filter((deployment) => (ref === null || deployment.ref === ref) && (environment === null || deployment.environment === environment));
    return { status: 200, body: matches };
  });

  transport.route('github:deployment-create', (method, url) => method === 'POST' && /^\/repos\/[^/]+\/[^/]+\/deployments$/.test(url.pathname), (request) => {
    const body = request.body as { ref?: unknown; environment?: unknown };
    const id = state.nextDeploymentId++;
    const deployment = { id, ref: typeof body?.ref === 'string' ? body.ref : '', environment: typeof body?.environment === 'string' ? body.environment : 'production', url: null };
    state.deployments.push(deployment);
    return { status: 201, body: deployment };
  });

  transport.route('github:deployment-status', (method, url) => method === 'POST' && /^\/repos\/[^/]+\/[^/]+\/deployments\/\d+\/statuses$/.test(url.pathname), (request) => {
    const deploymentId = Number(request.url.pathname.split('/').at(-2));
    const id = state.nextDeploymentId + 1000;
    return { status: 201, body: { id, deployment_id: deploymentId, url: `https://api.github.com/repos/x/y/deployments/${deploymentId}/statuses/${id}` } };
  });
}

// ---------------------------------------------------------------------------
// Vercel
// ---------------------------------------------------------------------------

export interface VercelState {
  projects: Map<string, Record<string, unknown>>;
  deployments: Map<string, Record<string, unknown>>;
  /** Scripted terminal state per deployment id; defaults to READY. */
  terminalStates: Map<string, string>;
  /** When set, every deployment read returns this terminal state (build-failure fixtures). */
  defaultTerminalState: string | null;
  /** When set, deployment creates and reads report this commit instead of the requested sha (stale-commit fixtures). */
  commitShaOverride: string | null;
  /** When set, project reads return this rootDirectory (simulated provider drift). */
  driftRootDirectory: string | null;
  /** When set, project reads fail with HTTP 500 (access-loss fixtures). */
  failProjectReads: boolean;
  nextDeployment: number;
  nextDomain: number;
  /** Project-scoped environment variables by id (the official env collection surface). */
  envs: Map<string, Record<string, unknown>>;
  nextEnv: number;
  envCalls: Array<Record<string, unknown>>;
  domainCalls: Array<Record<string, unknown>>;
  promoteCalls: Array<{ projectId: string; deploymentId: string }>;
  /** Rollback requests: POST /v1/projects/{projectId}/rollback/{deploymentId} (current official contract). */
  rollbackCalls: Array<{ projectId: string; deploymentId: string }>;
}

export function createVercelState(): VercelState {
  return {
    projects: new Map(),
    deployments: new Map(),
    terminalStates: new Map(),
    defaultTerminalState: null,
    commitShaOverride: null,
    driftRootDirectory: null,
    failProjectReads: false,
    nextDeployment: 10,
    nextDomain: 20,
    envs: new Map(),
    nextEnv: 1,
    envCalls: [],
    domainCalls: [],
    promoteCalls: [],
    rollbackCalls: [],
  };
}

export function vercelProject(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: id,
    framework: 'nextjs',
    rootDirectory: '.',
    nodeVersion: '24.x',
    installCommand: 'yarn install --immutable',
    buildCommand: 'yarn build',
    outputDirectory: null,
    autoAssignProductionDomains: false,
    prioritizeProductionBuilds: false,
    rollingRelease: null,
    skewProtection: false,
    settings: {},
    protection: {},
    functions: [],
    target: 'production',
    ...overrides,
  };
}

function vercelError(status: number, code: string): { status: number; body: unknown } {
  return { status, body: { error: { code, message: code } } };
}

/** Mounts the Vercel REST API simulation. Base URL must be https://api.vercel.com. */
export function mountVercelApi(transport: RecordedTransport, state: VercelState): void {
  transport.route('vercel:project-get', (method, url) => method === 'GET' && /^\/v9\/projects\/[^/]+$/.test(url.pathname), (request) => {
    if (state.failProjectReads) return vercelError(500, 'server_error');
    const id = decodeURIComponent(request.url.pathname.split('/').at(-1) ?? '');
    const project = state.projects.get(id);
    if (!project) return vercelError(404, 'not_found');
    if (state.driftRootDirectory !== null) return { status: 200, body: { ...project, rootDirectory: state.driftRootDirectory } };
    return { status: 200, body: project };
  });

  transport.route('vercel:project-patch', (method, url) => method === 'PATCH' && /^\/v9\/projects\/[^/]+$/.test(url.pathname), (request) => {
    const id = decodeURIComponent(request.url.pathname.split('/').at(-1) ?? '');
    const body = request.body as Record<string, unknown>;
    const existing = state.projects.get(id) ?? vercelProject(id);
    state.projects.set(id, { ...existing, ...body });
    return { status: 200, body: state.projects.get(id) };
  });

  transport.route('vercel:project-create', (method, url) => method === 'POST' && /^\/v10\/projects$/.test(url.pathname), (request) => {
    const body = request.body as Record<string, unknown>;
    const id = typeof body?.name === 'string' ? body.name : 'project';
    const project = vercelProject(id, body);
    state.projects.set(id, project);
    return { status: 200, body: project };
  });

  transport.route('vercel:project-delete', (method, url) => method === 'DELETE' && /^\/v9\/projects\/[^/]+$/.test(url.pathname), (request) => {
    const id = decodeURIComponent(request.url.pathname.split('/').at(-1) ?? '');
    state.projects.delete(id);
    return { status: 200, body: {} };
  });

  transport.route('vercel:shadow-search', (method, url) => method === 'GET' && url.pathname === '/v9/projects' && (url.searchParams.get('search') ?? '').includes('lp-pr-'), () => {
    const shadows = [...state.projects.entries()].filter(([id]) => id.startsWith('lp-pr-')).map(([id, project]) => ({ ...project, id, name: id }));
    return { status: 200, body: { projects: shadows } };
  });

  // Official environment-variable surface (list GET /v9/projects/{id}/env,
  // get GET /v9/projects/{id}/env/{envId}, create POST /v10/projects/{id}/env,
  // update PATCH /v9/projects/{id}/env/{envId}). Values are echoed back in
  // reads so the adapter's decrypt-capable readback verification can compare.
  transport.route('vercel:env-list', (method, url) => method === 'GET' && /^\/v9\/projects\/[^/]+\/env$/.test(url.pathname), (request) => {
    const projectId = decodeURIComponent(request.url.pathname.split('/').at(-2) ?? '');
    const envs = [...state.envs.values()].filter((env) => env.projectId === projectId).map(({ projectId: _projectId, ...env }) => env);
    return { status: 200, body: { envs } };
  });

  transport.route('vercel:env-get', (method, url) => method === 'GET' && /^\/v9\/projects\/[^/]+\/env\/[^/]+$/.test(url.pathname), (request) => {
    const id = decodeURIComponent(request.url.pathname.split('/').at(-1) ?? '');
    const env = state.envs.get(id);
    if (!env) return vercelError(404, 'not_found');
    const { projectId: _projectId, ...body } = env;
    return { status: 200, body };
  });

  transport.route('vercel:env-create', (method, url) => method === 'POST' && /^\/v10\/projects\/[^/]+\/env$/.test(url.pathname), (request) => {
    const projectId = decodeURIComponent(request.url.pathname.split('/').at(-2) ?? '');
    const body = request.body as Record<string, unknown>;
    const id = `env_${state.nextEnv++}`;
    const env: Record<string, unknown> = {
      id,
      projectId,
      key: typeof body?.key === 'string' ? body.key : 'LAUNCHPAD_ENV',
      value: typeof body?.value === 'string' ? body.value : 'managed-by-launchpad',
      type: typeof body?.type === 'string' ? body.type : 'encrypted',
      target: Array.isArray(body?.target) ? body.target : typeof body?.target === 'string' ? [body.target] : ['production'],
      gitBranch: typeof body?.gitBranch === 'string' ? body.gitBranch : null,
      createdAt: '2026-08-04T00:00:00.000Z',
      updatedAt: '2026-08-04T00:00:00.000Z',
    };
    state.envs.set(id, env);
    state.envCalls.push({ ...body });
    const { projectId: _projectId, ...created } = env;
    return { status: 200, body: { created: [created], failed: [] } };
  });

  transport.route('vercel:env-patch', (method, url) => method === 'PATCH' && /^\/v9\/projects\/[^/]+\/env\/[^/]+$/.test(url.pathname), (request) => {
    const id = decodeURIComponent(request.url.pathname.split('/').at(-1) ?? '');
    const body = request.body as Record<string, unknown>;
    const existing = state.envs.get(id);
    if (!existing) return vercelError(404, 'not_found');
    const updated: Record<string, unknown> = {
      ...existing,
      key: typeof body?.key === 'string' ? body.key : existing.key,
      value: typeof body?.value === 'string' ? body.value : existing.value,
      type: typeof body?.type === 'string' ? body.type : existing.type,
      target: Array.isArray(body?.target) ? body.target : typeof body?.target === 'string' ? [body.target] : existing.target,
      gitBranch: typeof body?.gitBranch === 'string' ? body.gitBranch : existing.gitBranch,
      updatedAt: '2026-08-04T00:00:00.000Z',
    };
    state.envs.set(id, updated);
    const { projectId: _projectId, ...responseBody } = updated;
    return { status: 200, body: responseBody };
  });

  transport.route('vercel:domain-create', (method, url) => method === 'POST' && /^\/v10\/projects\/[^/]+\/domains$/.test(url.pathname), (request) => {
    const projectId = decodeURIComponent(request.url.pathname.split('/').at(-2) ?? '');
    const body = request.body as Record<string, unknown>;
    const id = `dom-${state.nextDomain++}`;
    state.domainCalls.push({ ...body, projectId });
    return { status: 200, body: { id, name: body?.name ?? '', projectId, verified: true, verificationState: 'VERIFIED' } };
  });

  transport.route('vercel:domain-get', (method, url) => method === 'GET' && /^\/v9\/projects\/[^/]+\/domains\/[^/]+$/.test(url.pathname), (request) => {
    const projectId = decodeURIComponent(request.url.pathname.split('/').at(-3) ?? '');
    const hostname = decodeURIComponent(request.url.pathname.split('/').at(-1) ?? '');
    const attached = state.domainCalls.some((call) => call.name === hostname && call.projectId === projectId);
    if (!attached) return vercelError(404, 'not_found');
    return { status: 200, body: { name: hostname, apexName: hostname.split('.').slice(-2).join('.'), projectId, verified: true, verification: [], redirect: null, gitBranch: null, customEnvironmentId: null } };
  });

  transport.route('vercel:domain-verify', (method, url) => method === 'POST' && /^\/v9\/projects\/[^/]+\/domains\/[^/]+\/verify$/.test(url.pathname), (request) => {
    const projectId = decodeURIComponent(request.url.pathname.split('/').at(-4) ?? '');
    const hostname = decodeURIComponent(request.url.pathname.split('/').at(-2) ?? '');
    const attached = state.domainCalls.some((call) => call.name === hostname && call.projectId === projectId);
    if (!attached) return vercelError(404, 'not_found');
    return { status: 200, body: { name: hostname, apexName: hostname.split('.').slice(-2).join('.'), projectId, verified: true, verification: [], redirect: null, gitBranch: null, customEnvironmentId: null } };
  });

  transport.route('vercel:certs-list', (method, url) => method === 'GET' && url.pathname === '/v8/certs', () => {
    const cns = state.domainCalls.map((call) => call.name).filter((name): name is string => typeof name === 'string');
    const certs = cns.length === 0 ? [] : [{ id: 'cert-integration', createdAt: 1782835200000, expiresAt: 4102444800000, autoRenew: true, cns }];
    return { status: 200, body: { certs, pagination: { count: certs.length, next: 0, prev: 0 } } };
  });

  transport.route('vercel:domain-delete', (method, url) => method === 'DELETE' && /^\/v9\/projects\/[^/]+\/domains\/[^/]+$/.test(url.pathname), (request) => {
    const projectId = decodeURIComponent(request.url.pathname.split('/').at(-3) ?? '');
    const hostname = decodeURIComponent(request.url.pathname.split('/').at(-1) ?? '');
    // Detached domains must no longer be observable (domain reads 404 and the
    // certificate list drops the hostname), mirroring the real Vercel API.
    const callIndex = state.domainCalls.findIndex((call) => call.name === hostname && call.projectId === projectId);
    if (callIndex >= 0) state.domainCalls.splice(callIndex, 1);
    const project = state.projects.get(projectId);
    if (project !== undefined) {
      const domains = Array.isArray(project.domains) ? project.domains.filter((domain) => domain !== hostname) : [];
      state.projects.set(projectId, { ...project, domains });
    }
    return { status: 200, body: {} };
  });

  transport.route('vercel:dns-config', (method, url) => method === 'GET' && /^\/v6\/domains\/[^/]+\/config$/.test(url.pathname), () => ({
    status: 200,
    body: { misconfigured: false, recommendedCNAME: [{ rank: 1, value: ['cname.vercel-dns.com'] }] },
  }));

  transport.route('vercel:deployment-create', (method, url) => method === 'POST' && url.pathname === '/v13/deployments', (request) => {
    const body = request.body as Record<string, unknown>;
    const projectId = typeof body?.project === 'string' ? body.project : 'project';
    const meta = (body?.meta ?? {}) as Record<string, unknown>;
    const sha = (body?.gitSource as Record<string, unknown> | undefined)?.sha;
    const requestedCommit = typeof sha === 'string' ? sha : typeof meta?.gitCommitSha === 'string' ? meta.gitCommitSha : 'a'.repeat(40);
    const commitSha = state.commitShaOverride ?? requestedCommit;
    const id = `dpl_${state.nextDeployment++}`;
    const deployment: Record<string, unknown> = {
      id,
      projectId,
      url: `${projectId}-${id}.vercel.app`,
      state: 'QUEUED',
      readyState: 'QUEUED',
      commitSha,
      target: body?.target ?? 'preview',
      createdAt: '2026-08-04T00:00:00.000Z',
      meta: { ...meta, repo: meta?.repo ?? 'example/fixture', desiredGeneration: String(meta?.desiredGeneration ?? 1) },
    };
    state.deployments.set(id, deployment);
    return { status: 200, body: deployment };
  });

  transport.route('vercel:deployment-get', (method, url) => method === 'GET' && /^\/v13\/deployments\/[^/]+$/.test(url.pathname), (request) => {
    const id = decodeURIComponent(request.url.pathname.split('/').at(-1) ?? '');
    const deployment = state.deployments.get(id);
    if (!deployment) return vercelError(404, 'not_found');
    const terminal = state.terminalStates.get(id) ?? state.defaultTerminalState ?? 'READY';
    return { status: 200, body: { ...deployment, state: terminal, readyState: terminal } };
  });

  transport.route('vercel:deployment-delete', (method, url) => method === 'DELETE' && /^\/v13\/deployments\/[^/]+$/.test(url.pathname), (request) => {
    const id = decodeURIComponent(request.url.pathname.split('/').at(-1) ?? '');
    state.deployments.delete(id);
    return { status: 200, body: { uid: id, state: 'DELETED' } };
  });

  transport.route('vercel:deployment-events', (method, url) => method === 'GET' && /^\/v[23]\/deployments\/[^/]+\/events/.test(url.pathname), () => ({
    status: 200,
    body: { events: [{ payload: { text: 'Compiled successfully' } }, { payload: { command: 'yarn build' } }] },
  }));

  transport.route('vercel:deployments-list', (method, url) => method === 'GET' && url.pathname === '/v7/deployments', (request) => {
    const projectId = request.url.searchParams.get('projectId');
    const matches = [...state.deployments.values()].filter((deployment) => projectId === null || deployment.projectId === projectId);
    return { status: 200, body: { deployments: matches } };
  });

  // Current official promote contract: POST /v10/projects/{projectId}/promote/{deploymentId}
  // with an empty 201/202 response (the deployment identity is the URL path).
  transport.route('vercel:promote', (method, url) => method === 'POST' && /^\/v10\/projects\/[^/]+\/promote\/[^/]+$/.test(url.pathname), (request) => {
    const projectId = decodeURIComponent(request.url.pathname.split('/').at(-3) ?? '');
    const deploymentId = decodeURIComponent(request.url.pathname.split('/').at(-1) ?? '');
    state.promoteCalls.push({ projectId, deploymentId });
    const deployment = state.deployments.get(deploymentId);
    if (!deployment) return vercelError(404, 'not_found');
    const promoted = { ...deployment, state: 'CURRENT', readyState: 'CURRENT' };
    state.deployments.set(deploymentId, promoted);
    return { status: 201, body: {} };
  });

  // Current official rollback contract: POST /v1/projects/{projectId}/rollback/{deploymentId}
  // (deploymentId is the deployment to roll back *to*), empty 201 response.
  transport.route('vercel:rollback', (method, url) => method === 'POST' && /^\/v1\/projects\/[^/]+\/rollback\/[^/]+$/.test(url.pathname), (request) => {
    const projectId = decodeURIComponent(request.url.pathname.split('/').at(-3) ?? '');
    const deploymentId = decodeURIComponent(request.url.pathname.split('/').at(-1) ?? '');
    state.rollbackCalls.push({ projectId, deploymentId });
    const deployment = state.deployments.get(deploymentId);
    if (!deployment) return vercelError(404, 'not_found');
    state.deployments.set(deploymentId, { ...deployment, state: 'CURRENT', readyState: 'CURRENT' });
    return { status: 201, body: {} };
  });
}

// ---------------------------------------------------------------------------
// Cloudflare
// ---------------------------------------------------------------------------

export interface CloudflareZone { id: string; name: string; name_servers: string[]; status: string; }
export interface CloudflareRecord {
  id: string;
  zoneId: string;
  name: string;
  type: string;
  content: string;
  ttl: number;
  proxied: boolean;
  comment: string | null;
}

export interface CloudflareState {
  zones: CloudflareZone[];
  records: CloudflareRecord[];
  nextRecord: number;
}

export function createCloudflareState(options: { zoneName?: string; nameservers?: string[] } = {}): CloudflareState {
  return {
    zones: [{ id: 'zone_1', name: options.zoneName ?? 'example.com', name_servers: options.nameservers ?? ['ns1.example.net', 'ns2.example.net'], status: 'active' }],
    records: [],
    nextRecord: 1,
  };
}

export function cfRecord(input: { zoneId: string; name: string; type: string; content: string; ttl?: number; proxied?: boolean; comment?: string | null }, state: CloudflareState): CloudflareRecord {
  return { id: `dns_${state.nextRecord++}`, zoneId: input.zoneId, name: input.name, type: input.type, content: input.content, ttl: input.ttl ?? 1, proxied: input.proxied ?? false, comment: input.comment ?? null };
}

function cfEnvelope(result: unknown): Record<string, unknown> {
  return { success: true, result, errors: [], messages: [] };
}

/** Ownership comment convention the apply machine writes (applyEnsureDns). */
export function expectedDnsOwnership(applicationId: string, hostname: string): string {
  return idempotencyKey('ownership', applicationId, hostname);
}

/** Mounts the Cloudflare API simulation. Base URL must be https://api.cloudflare.com/client/v4. */
export function mountCloudflareApi(transport: RecordedTransport, state: CloudflareState): void {
  // The adapter talks to https://api.cloudflare.com/client/v4/..., so every
  // route strips that prefix before matching.
  const path = (url: URL): string => url.pathname.replace(/^\/client\/v4/, '');

  transport.route('cloudflare:zone-list', (method, url) => method === 'GET' && path(url) === '/zones', (request) => {
    const name = request.url.searchParams.get('name');
    const matches = state.zones.filter((zone) => name === null || zone.name === name);
    return { status: 200, body: cfEnvelope(matches) };
  });

  transport.route('cloudflare:records-list', (method, url) => method === 'GET' && /^\/zones\/[^/]+\/dns_records$/.test(path(url)), (request) => {
    const zoneId = decodeURIComponent(path(request.url).split('/').at(-2) ?? '');
    const name = request.url.searchParams.get('name');
    const type = request.url.searchParams.get('type');
    const matches = state.records.filter((record) => record.zoneId === zoneId && (name === null || record.name === name) && (type === null || record.type === type));
    return { status: 200, body: cfEnvelope(matches) };
  });

  transport.route('cloudflare:record-get', (method, url) => method === 'GET' && /^\/zones\/[^/]+\/dns_records\/[^/]+$/.test(path(url)), (request) => {
    const id = decodeURIComponent(path(request.url).split('/').at(-1) ?? '');
    const record = state.records.find((candidate) => candidate.id === id);
    if (!record) return { status: 404, body: { success: false, errors: [{ code: 1003, message: 'record not found' }] } };
    return { status: 200, body: cfEnvelope(record) };
  });

  transport.route('cloudflare:record-create', (method, url) => method === 'POST' && /^\/zones\/[^/]+\/dns_records$/.test(path(url)), (request) => {
    const zoneId = decodeURIComponent(path(request.url).split('/').at(-2) ?? '');
    const body = request.body as Record<string, unknown>;
    const record = cfRecord({ zoneId, name: String(body?.name ?? ''), type: String(body?.type ?? 'CNAME'), content: String(body?.content ?? ''), ttl: typeof body?.ttl === 'number' ? body.ttl : 1, proxied: body?.proxied === true, comment: typeof body?.comment === 'string' ? body.comment : null }, state);
    state.records.push(record);
    return { status: 200, body: cfEnvelope(record) };
  });

  transport.route('cloudflare:record-update', (method, url) => method === 'PUT' && /^\/zones\/[^/]+\/dns_records\/[^/]+$/.test(path(url)), (request) => {
    const id = decodeURIComponent(path(request.url).split('/').at(-1) ?? '');
    const body = request.body as Record<string, unknown>;
    const record = state.records.find((candidate) => candidate.id === id);
    if (!record) return { status: 404, body: { success: false, errors: [{ code: 1003, message: 'record not found' }] } };
    record.name = String(body?.name ?? record.name);
    record.type = String(body?.type ?? record.type);
    record.content = String(body?.content ?? record.content);
    record.ttl = typeof body?.ttl === 'number' ? body.ttl : record.ttl;
    record.proxied = body?.proxied === true;
    record.comment = typeof body?.comment === 'string' ? body.comment : record.comment;
    return { status: 200, body: cfEnvelope(record) };
  });

  transport.route('cloudflare:record-delete', (method, url) => method === 'DELETE' && /^\/zones\/[^/]+\/dns_records\/[^/]+$/.test(path(url)), (request) => {
    const id = decodeURIComponent(path(request.url).split('/').at(-1) ?? '');
    const index = state.records.findIndex((record) => record.id === id);
    if (index < 0) return { status: 404, body: { success: false, errors: [{ code: 1003, message: 'record not found' }] } };
    const [removed] = state.records.splice(index, 1);
    return { status: 200, body: cfEnvelope(removed) };
  });
}

// ---------------------------------------------------------------------------
// Health probes
// ---------------------------------------------------------------------------

export interface HealthState {
  /** hostname -> HTTP status; absent hosts answer `defaultStatus`. */
  statuses: Map<string, number>;
  bodies: Map<string, string>;
  /** Fallback status for unlisted hosts (health-failure fixtures). */
  defaultStatus: number;
}

export function createHealthState(): HealthState {
  return { statuses: new Map(), bodies: new Map(), defaultStatus: 200 };
}

/** Mounts a catch-all health route for https://<deployment-host>/api/health. */
export function mountHealth(transport: RecordedTransport, state: HealthState): void {
  transport.route('health', (method, url) => method === 'GET' && url.protocol === 'https:' && url.pathname === '/api/health', (request) => {
    const host = request.url.hostname;
    const status = state.statuses.get(host) ?? state.defaultStatus;
    return { status, body: state.bodies.get(host) ?? JSON.stringify({ status: 'ok' }) };
  });
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Mounts the full provider surface used by the controller flows. */
export function mountProviders(transport: RecordedTransport, state: { github: GithubState; vercel: VercelState; cloudflare: CloudflareState; health: HealthState }): void {
  mountGithubApi(transport, state.github);
  mountVercelApi(transport, state.vercel);
  mountCloudflareApi(transport, state.cloudflare);
  mountHealth(transport, state.health);
}

/** Reads the manifest fixture and returns its catalog YAML content (loader-injected fields dropped). */
export function manifestYamlFrom(desiredRecord: Record<string, unknown>): string {
  const { sourcePath: _sourcePath, ...body } = desiredRecord;
  return stringify(body, { aliasDuplicateObjects: false, lineWidth: 0 });
}
