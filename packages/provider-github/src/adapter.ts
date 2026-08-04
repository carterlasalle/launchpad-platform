import { GitHubClient } from './client.js';
import type { ProviderContext, RepositoryObservation, SourceProvider } from '@launchpad/provider-contract';

interface RepositoryResponse { id: number; archived: boolean; private: boolean; default_branch: string; }
interface ContentResponse { type?: string; sha?: string; content?: string; encoding?: string; }
interface RefResponse { object: { sha: string }; }
interface PullResponse { number: number; html_url: string; head?: { ref: string }; }
interface CommentResponse { id: number; body?: string; html_url: string; }

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

  constructor(options: { token?: string; baseUrl?: string; fetchImpl?: typeof fetch }) {
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
    if (!data.content || data.encoding !== 'base64') throw new Error('LP-GITHUB-FILE-CONTENT-MISSING');
    const bytes = Uint8Array.from(atob(data.content.replaceAll('\n', '')), (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  async upsertPullRequestComment(input: { repository: string; pullRequestNumber: number; marker: string; body: string }, ctx: ProviderContext): Promise<{ id: number; url: string }> {
    const { owner, name } = repoPath(input.repository);
    const comments = await this.client.github<CommentResponse[]>(`/repos/${owner}/${name}/issues/${input.pullRequestNumber}/comments?per_page=100`, { correlationId: ctx.correlationId });
    const existing = comments.find((comment) => comment.body?.includes(input.marker));
    if (existing) {
      const updated = await this.client.github<CommentResponse>(`/repos/${owner}/${name}/issues/comments/${existing.id}`, { method: 'PATCH', body: JSON.stringify({ body: input.body }), correlationId: ctx.correlationId });
      return { id: updated.id, url: updated.html_url };
    }
    const created = await this.client.github<CommentResponse>(`/repos/${owner}/${name}/issues/${input.pullRequestNumber}/comments`, { method: 'POST', body: JSON.stringify({ body: input.body }), correlationId: ctx.correlationId });
    return { id: created.id, url: created.html_url };
  }

  async createOrUpdatePullRequest(input: { repository: string; branch: string; title: string; body: string; files: Record<string, string> }, ctx: ProviderContext): Promise<{ number: number; url: string }> {
    const { owner, name } = repoPath(input.repository);
    const repository = await this.observeRepository(input.repository, ctx);
    const defaultRef = await this.client.github<RefResponse>(`/repos/${owner}/${name}/git/ref/heads/${encodeURIComponent(repository.defaultBranch)}`, { correlationId: ctx.correlationId });
    try {
      await this.client.github(`/repos/${owner}/${name}/git/refs`, { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${input.branch}`, sha: defaultRef.object.sha }), correlationId: ctx.correlationId, idempotencyKey: `branch:${input.branch}` });
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
}
