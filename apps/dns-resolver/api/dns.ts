import type { IncomingMessage, ServerResponse } from 'node:http';

import { createDnsHttpHandler } from '../src/http.js';
import { createNodeDnsDependencies } from '../src/node-dns.js';

/**
 * Vercel Node function at `/api/dns`.
 *
 * Accepts only POST with a JSON body of the exact shape
 * `{ hostname, type, nameservers }`, resolves the record only against the
 * supplied authoritative nameservers (hostnames restricted to the
 * `carterlasalle.com` zone and `.ns.cloudflare.com` nameservers), and
 * answers with `{ answers, nameservers }` where `nameservers` echoes the
 * request verbatim. All failures are safe, non-2xx responses without raw
 * DNS or provider detail.
 */
const handler = createDnsHttpHandler(createNodeDnsDependencies());

export default function dns(request: IncomingMessage, response: ServerResponse): void {
  handler(request, response);
}
