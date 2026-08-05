// External URL validation. External links rendered by the dashboard MUST pass
// safeExternalUrl: only absolute https URLs (or http to loopback, when
// explicitly allowed) survive. Anything else renders as inert text so
// attacker-controlled values can never become clickable navigation.

import { el, setText } from './dom.js';

const LOOPBACK_HOSTS: Record<string, true> = { localhost: true, '127.0.0.1': true, '[::1]': true };

export function safeExternalUrl(value: string | null | undefined, options?: { allowHttp?: boolean }): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  // Scheme-less values (e.g. "example.com") are treated as https URLs.
  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value) ? value : `https://${value}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.username !== '' || url.password !== '') return null;
  if (url.protocol === 'https:') return url.href;
  if (options?.allowHttp === true && url.protocol === 'http:' && LOOPBACK_HOSTS[url.hostname] === true) return url.href;
  return null;
}

/**
 * Renders `value` as an external link only when it passes safeExternalUrl.
 * Invalid values produce a plain <span> — never an anchor — so untrusted
 * input cannot become navigation.
 */
export function externalLink(value: string | null | undefined, label?: string): HTMLElement {
  const safe = safeExternalUrl(value);
  if (safe === null) {
    const placeholder = el('span', 'external-link external-link--invalid');
    setText(placeholder, label ?? value ?? 'invalid link');
    return placeholder;
  }
  const anchor = el('a', 'external-link');
  anchor.href = safe;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  setText(anchor, label ?? value ?? safe);
  return anchor;
}
