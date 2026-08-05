import { ProviderHttpClient } from '@launchpad/provider-contract';

export class VercelClient extends ProviderHttpClient {
  readonly teamId: string | null;

  constructor(options: { token?: string; teamId?: string | null; baseUrl?: string; fetchImpl?: typeof fetch; timeoutMs?: number }) {
    super({ provider: 'vercel', token: options.token, baseUrl: options.baseUrl ?? 'https://api.vercel.com', fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs ?? 30_000 });
    this.teamId = options.teamId ?? null;
  }

  withTeam(path: string): string {
    if (!this.teamId) return path;
    return `${path}${path.includes('?') ? '&' : '?'}teamId=${encodeURIComponent(this.teamId)}`;
  }
}
