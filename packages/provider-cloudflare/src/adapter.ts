import { canonicalJson, idempotencyKey } from '@launchpad/shared';
import { ProviderRequestError, type DnsProvider, type DnsRecordObservation, type MutationResult, type ProviderCapabilities, type ProviderContext, type RequiredDnsRecord, type ZoneObservation } from '@launchpad/provider-contract';
import { CloudflareClient } from './client.js';

interface ZoneResponse { id: string; name: string; name_servers?: string[]; status?: string; }
interface RecordResponse { id: string; name: string; type: string; content: string; ttl: number; proxied?: boolean; comment?: string | null; }

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function ownershipFromComment(comment: unknown): string | null {
  return typeof comment === 'string' && comment.startsWith('launchpad:') ? comment.slice('launchpad:'.length) : null;
}

export class CloudflareAdapter implements DnsProvider {
  readonly client: CloudflareClient;
  readonly resolveDns: (hostname: string, type: string) => Promise<string[]>;

  constructor(options: { token?: string | undefined; baseUrl?: string | undefined; fetchImpl?: typeof fetch | undefined; resolveDns?: ((hostname: string, type: string) => Promise<string[]>) | undefined }) {
    this.client = new CloudflareClient(options);
    this.resolveDns = options.resolveDns ?? (async (hostname, type) => {
      const response = await (options.fetchImpl ?? fetch)(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${encodeURIComponent(type)}`, { headers: { accept: 'application/dns-json' } });
      if (!response.ok) return [];
      const body = record(await response.json());
      const answers = Array.isArray(body.Answer) ? body.Answer : [];
      return answers.map((answer) => record(answer).data).filter((value): value is string => typeof value === 'string');
    });
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return { provider: 'cloudflare', adapterVersion: 'dns-rest-v1', fields: { 'dns.record.content': { read: true, create: true, update: true, delete: true, requiresRedeploy: false, destructiveWhenChanged: false }, 'dns.record.proxied': { read: true, create: true, update: true, delete: true, requiresRedeploy: false, destructiveWhenChanged: false } }, features: { authoritativeVerification: true, proxyMode: true }, snapshotHash: 'cloudflare-dns-rest-v1' };
  }

  async observeZone(zoneRef: string, ctx: ProviderContext): Promise<ZoneObservation> {
    const name = zoneRef.replace(/^config:\/\/cloudflare\//, '');
    const response = await this.client.request<unknown>(`/zones?name=${encodeURIComponent(name)}&status=active`, { correlationId: ctx.correlationId });
    const results = record(response).result;
    const result = Array.isArray(results) ? results[0] : undefined;
    const zone = record(result) as unknown as ZoneResponse;
    if (!zone.id || !zone.name) throw new ProviderRequestError({ code: 'LP-CLOUDFLARE-ZONE-MISSING', class: 'NOT_FOUND', provider: 'cloudflare', message: `Cloudflare zone '${name}' was not found.`, retryable: false });
    return { provider: 'cloudflare', zoneId: zone.id, name: zone.name, nameservers: zone.name_servers ?? [], status: zone.status ?? 'unknown' };
  }

  async observeRecord(zoneId: string, hostname: string, ctx: ProviderContext): Promise<DnsRecordObservation | null> {
    const response = await this.client.request<unknown>(`/zones/${encodeURIComponent(zoneId)}/dns_records?name=${encodeURIComponent(hostname)}`, { correlationId: ctx.correlationId });
    const results = record(response).result;
    const result = Array.isArray(results) ? results[0] : undefined;
    if (!result) return null;
    const data = result as unknown as RecordResponse;
    return { provider: 'cloudflare', id: data.id, zoneId, name: data.name, type: data.type, content: data.content, ttl: data.ttl, proxied: data.proxied === true, ownershipFingerprint: ownershipFromComment(data.comment) };
  }

  async ensureRecord(zoneId: string, required: RequiredDnsRecord, ownershipFingerprint: string, ctx: ProviderContext): Promise<MutationResult<DnsRecordObservation>> {
    const current = await this.observeRecord(zoneId, required.hostname, ctx);
    if (current && current.ownershipFingerprint !== ownershipFingerprint) throw new ProviderRequestError({ code: 'LP-DNS-CONFLICT-UNOWNED', class: 'CONFLICT', provider: 'cloudflare', message: `DNS record '${required.hostname}' is not owned by this Launchpad application.`, retryable: false });
    const body = { type: required.type, name: required.hostname, content: required.value, ttl: required.ttl === 'auto' ? 1 : required.ttl, proxied: false, comment: `launchpad:${ownershipFingerprint}` };
    const endpoint = current ? `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(current.id)}` : `/zones/${encodeURIComponent(zoneId)}/dns_records`;
    const response = await this.client.request<unknown>(endpoint, { method: current ? 'PUT' : 'POST', body: JSON.stringify(body), correlationId: ctx.correlationId, idempotencyKey: idempotencyKey('cloudflare-dns', zoneId, required.hostname, ownershipFingerprint) });
    const data = record(response).result as unknown as RecordResponse;
    const next: DnsRecordObservation = { provider: 'cloudflare', id: data.id ?? current?.id ?? '', zoneId, name: data.name ?? required.hostname, type: data.type ?? required.type, content: data.content ?? required.value, ttl: data.ttl ?? body.ttl, proxied: data.proxied === true, ownershipFingerprint: ownershipFromComment(data.comment) ?? ownershipFingerprint };
    return { resource: next, changed: current === null || canonicalJson(current) !== canonicalJson(next), operationId: idempotencyKey('cloudflare-dns-operation', zoneId, required.hostname, ownershipFingerprint) };
  }

  async verifyAuthoritative(hostname: string, required: RequiredDnsRecord, _ctx: ProviderContext): Promise<boolean> {
    const values = await this.resolveDns(hostname, required.type);
    return values.some((value) => value.replace(/\.$/, '') === required.value.replace(/\.$/, ''));
  }

  async deleteRecord(zoneId: string, recordId: string, ctx: ProviderContext): Promise<void> {
    await this.client.request(`/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`, { method: 'DELETE', correlationId: ctx.correlationId, idempotencyKey: idempotencyKey('cloudflare-dns-delete', zoneId, recordId) });
  }
}
