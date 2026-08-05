import { GitHubClient } from './client.js';
import { boundStickyCommentBody } from '@launchpad/shared';
import { ProviderRequestError, type DeploymentStatusInput, type DeploymentStatusResult, type ProviderContext, type RepositoryObservation, type SourceProvider } from '@launchpad/provider-contract';

interface RepositoryResponse { id: number; archived: boolean; private: boolean; default_branch: string; }
interface ContentResponse { type?: string; sha?: string; content?: string; encoding?: string; }
interface RefResponse { object: { sha: string }; }
interface PullResponse { number: number; html_url: string; head?: { ref: string }; }
interface CommentResponse { id: number; body?: string; html_url: string; }
interface DeploymentResponse { id?: number; environment?: string; ref?: string; url?: string; }
interface DeploymentStatusResponse { id: number; url: string; }

function repoPath(repository: string): { owner: string; name: string } {
  const [owner, name, ...rest] = repository.split('/');
  if (!owner || !name || rest.length > 0) throw new Error(`Invalid GitHub repository '${repository}'.`);
  return { owner, name };
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('%2F');
}

export class GitHubAdapter implements SourceProvider {
  readonly client: GitHubClient;

  constructor(options: { token?: string; baseUrl?: string; fetchImpl?: typeof fetch; timeoutMs?: number }) {
    this.client = new GitHubClient(options);
  }

  async observeRepository(repository: string, ctx: ProviderContext): Promise<RepositoryObservation> {
    const { owner, name } = repoPath(repository);
    const data = await this.client.github<RepositoryResponse>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, { correlationId: ctx.correlationId });
    return { provider: 'github', repository, repositoryId: data.id, archived: data.archived, private: data.private, defaultBranch: data.default_branch, access: true };
  }

  async hasPath(repository: string, ref: string, path: string, ctx: ProviderContext): Promise<'file' | 'directory' | 'missing'> {
    const { owner, name } = repoPath(repository);
    try {
      const data = await this.client.github<ContentResponse | ContentResponse[]>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`, { correlationId: ctx.correlationId });
      return Array.isArray(data) || data.type === 'dir' ? 'directory' : 'file';
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'class' in error && error.class === 'NOT_FOUND') return 'missing';
      throw error;
    }
  }
  async readFile(repository: string, ref: string, path: string, ctx: ProviderContext): Promise<string> {
    const { owner, name } = repoPath(repository);
    const data = await this.client.github<ContentResponse>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`, { correlationId: ctx.correlationId });
    if (!data.content || data.encoding !== 'base64') throw new ProviderRequestError({ code: 'LP-GITHUB-FILE-CONTENT-MISSING', class: 'MALFORMED_PROVIDER_RESPONSE', provider: 'github', message: 'GitHub did not return base64 file content.', retryable: false });
    const bytes = Uint8Array.from(atob(data.content.replaceAll('\n', '')), (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  async resolveRef(repository: string, ref: string, ctx: ProviderContext): Promise<{ sha: string }> {
    const { owner, name } = repoPath(repository);
    const data = await this.client.github<RefResponse>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/ref/heads/${encodeURIComponent(ref)}`, { correlationId: ctx.correlationId });
    if (!data.object || typeof data.object.sha !== 'string' || data.object.sha.length === 0) throw new ProviderRequestError({ code: 'LP-GITHUB-REF-MALFORMED', class: 'MALFORMED_PROVIDER_RESPONSE', provider: 'github', message: 'GitHub returned a ref without a commit sha.', retryable: false });
    return { sha: data.object.sha };
  }

  async upsertPullRequestComment(input: { repository: string; pullRequestNumber: number; marker: string; body: string }, ctx: ProviderContext): Promise<{ id: number; url: string }> {
    const { owner, name } = repoPath(input.repository);
    const body = boundStickyCommentBody(input.body);
    const comments = await this.client.github<CommentResponse[]>(`/repos/${owner}/${name}/issues/${input.pullRequestNumber}/comments?per_page=100`, { correlationId: ctx.correlationId });
    const existing = comments.find((comment) => comment.body?.includes(input.marker));
    if (existing) {
      const updated = await this.client.github<CommentResponse>(`/repos/${owner}/${name}/issues/comments/${existing.id}`, { method: 'PATCH', body: JSON.stringify({ body }), correlationId: ctx.correlationId });
      return { id: updated.id, url: updated.html_url };
    }
    const created = await this.client.github<CommentResponse>(`/repos/${owner}/${name}/issues/${input.pullRequestNumber}/comments`, { method: 'POST', body: JSON.stringify({ body }), correlationId: ctx.correlationId });
    return { id: created.id, url: created.html_url };
  }

  async createOrUpdatePullRequest(input: { repository: string; branch: string; title: string; body: string; files: Record<string, string>; baseSha?: string }, ctx: ProviderContext): Promise<{ number: number; url: string }> {
    const { owner, name } = repoPath(input.repository);
    const repository = await this.observeRepository(input.repository, ctx);
    const defaultRef = await this.client.github<RefResponse>(`/repos/${owner}/${name}/git/ref/heads/${encodeURIComponent(repository.defaultBranch)}`, { correlationId: ctx.correlationId });
    // The branch base is the caller-provided protected main SHA when given
    // (reconciliation pins the base to the commit it diffed against,
    // TR-REC-001); otherwise the default branch ref at creation time.
    const baseSha = input.baseSha ?? defaultRef.object.sha;
    try {
      await this.client.github(`/repos/${owner}/${name}/git/refs`, { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${input.branch}`, sha: baseSha }), correlationId: ctx.correlationId, idempotencyKey: `branch:${input.branch}` });
    } catch (error) {
      if (!(typeof error === 'object' && error !== null && 'class' in error && error.class === 'CONFLICT')) throw error;
    }
    for (const [path, content] of Object.entries(input.files)) {
      let sha: string | undefined;
      try {
        const existing = await this.client.github<ContentResponse>(`/repos/${owner}/${name}/contents/${encodePath(path)}?ref=${encodeURIComponent(input.branch)}`, { correlationId: ctx.correlationId });
        sha = existing.sha;
      } catch (error) {
        if (!(typeof error === 'object' && error !== null && 'class' in error && error.class === 'NOT_FOUND')) throw error;
      }
      await this.client.github(`/repos/${owner}/${name}/contents/${encodePath(path)}`, { method: 'PUT', body: JSON.stringify({ message: `chore: reconcile ${path}`, content: btoa(unescape(encodeURIComponent(content))), branch: input.branch, ...(sha ? { sha } : {}) }), correlationId: ctx.correlationId, idempotencyKey: `content:${input.branch}:${path}` });
    }
    const open = await this.client.github<PullResponse[]>(`/repos/${owner}/${name}/pulls?state=open&head=${encodeURIComponent(`${owner}:${input.branch}`)}`, { correlationId: ctx.correlationId });
    if (open[0]) {
      const updated = await this.client.github<PullResponse>(`/repos/${owner}/${name}/pulls/${open[0].number}`, { method: 'PATCH', body: JSON.stringify({ title: input.title, body: input.body }), correlationId: ctx.correlationId });
      return { number: updated.number, url: updated.html_url };
    }
    const created = await this.client.github<PullResponse>(`/repos/${owner}/${name}/pulls`, { method: 'POST', body: JSON.stringify({ title: input.title, body: input.body, head: input.branch, base: repository.defaultBranch }), correlationId: ctx.correlationId });
    return { number: created.number, url: created.html_url };
  }

  /**
   * Creates or reuses the GitHub Deployment for the exact commit + environment
   * and publishes one status on it. Reusing the existing deployment keeps one
   * deployment per commit so statuses accumulate on a stable identity
   * (TR-GH-006); the deployment is transient so it is cleaned up after merge.
   */
  async createDeploymentStatus(input: DeploymentStatusInput, ctx: ProviderContext): Promise<DeploymentStatusResult> {
    const { owner, name } = repoPath(input.repository);
    const existing = await this.client.github<DeploymentResponse[]>(`/repos/${owner}/${name}/deployments?ref=${encodeURIComponent(input.commitSha)}&environment=${encodeURIComponent(input.environment)}`, { correlationId: ctx.correlationId });
    const deployment = existing.find((candidate) => candidate.environment === input.environment);
    if (deployment && typeof deployment.id !== 'number') throw new ProviderRequestError({ code: 'LP-GITHUB-DEPLOYMENT-MALFORMED', class: 'MALFORMED_PROVIDER_RESPONSE', provider: 'github', message: 'GitHub returned a deployment without an id.', retryable: false });
    const target = deployment ?? (await this.client.github<DeploymentResponse>(`/repos/${owner}/${name}/deployments`, { method: 'POST', body: JSON.stringify({ ref: input.commitSha, environment: input.environment, description: input.description, transient_environment: true, auto_merge: false, required_contexts: [] }), correlationId: ctx.correlationId, ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}) }));
    if (typeof target.id !== 'number') throw new ProviderRequestError({ code: 'LP-GITHUB-DEPLOYMENT-MALFORMED', class: 'MALFORMED_PROVIDER_RESPONSE', provider: 'github', message: 'GitHub did not return a deployment id.', retryable: false });
    const status = await this.client.github<DeploymentStatusResponse>(`/repos/${owner}/${name}/deployments/${target.id}/statuses`, { method: 'POST', body: JSON.stringify({ state: input.state, description: input.description, ...(input.targetUrl ? { target_url: input.targetUrl } : {}), ...(input.logUrl ? { log_url: input.logUrl } : {}) }), correlationId: ctx.correlationId });
    return { deploymentId: target.id, statusId: status.id, deploymentUrl: typeof target.url === 'string' ? target.url : null, statusUrl: status.url };
  }
}
