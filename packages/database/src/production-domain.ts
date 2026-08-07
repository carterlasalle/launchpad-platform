/**
 * Resolves the canonical production hostname from a stored observation
 * payload: the observed resources carry the vercel.domain configuration
 * ({ hostname, environment, canonical }). Returns null when no canonical
 * production domain is recorded, so callers fall back to the deployment URL.
 */
export function productionDomainFromObservation(payloadJson: string | null | undefined): string | null {
  if (!payloadJson) return null;
  try {
    const observed = JSON.parse(payloadJson) as { resources?: Array<{ resourceType?: string; configuration?: Record<string, unknown> }> };
    for (const resource of observed.resources ?? []) {
      const configuration = resource.configuration;
      if ((resource.resourceType === 'vercel.domain' || resource.resourceType === 'project-domain') && configuration !== null && configuration !== undefined && configuration.environment === 'production' && configuration.canonical === true && typeof configuration.hostname === 'string' && configuration.hostname.length > 0) {
        return configuration.hostname;
      }
    }
  } catch {
    return null;
  }
  return null;
}
