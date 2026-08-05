import { ProviderHttpClient } from '@launchpad/provider-contract';

export class CloudflareClient extends ProviderHttpClient {
  constructor(options: { token?: string | undefined; baseUrl?: string | undefined; fetchImpl?: typeof fetch | undefined; timeoutMs?: number | undefined }) {
    super({ provider: 'cloudflare', token: options.token, baseUrl: options.baseUrl ?? 'https://api.cloudflare.com/client/v4', fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs ?? 20_000 });
  }
}
