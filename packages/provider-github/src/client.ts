import { ProviderHttpClient } from '@launchpad/provider-contract';

export class GitHubClient extends ProviderHttpClient {
  constructor(options: { token?: string; baseUrl?: string; fetchImpl?: typeof fetch; timeoutMs?: number }) {
    super({ provider: 'github', token: options.token, baseUrl: options.baseUrl ?? 'https://api.github.com', fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs ?? 20_000 });
  }

  async github<T>(path: string, init: RequestInit & { correlationId?: string; idempotencyKey?: string } = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('x-github-api-version', '2022-11-28');
    headers.set('user-agent', 'launchpad-control-plane/1');
    return this.request<T>(path, { ...init, headers });
  }
}
