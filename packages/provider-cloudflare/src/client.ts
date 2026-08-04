import { ProviderHttpClient } from '@launchpad/provider-contract';

export class CloudflareClient extends ProviderHttpClient {
  constructor(options: { token?: string; baseUrl?: string; fetchImpl?: typeof fetch }) {
    super({ provider: 'cloudflare', token: options.token, baseUrl: options.baseUrl ?? 'https://api.cloudflare.com/client/v4', fetchImpl: options.fetchImpl, timeoutMs: 20_000 });
  }
}
