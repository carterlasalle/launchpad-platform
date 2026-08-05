// Credential metadata page — reads GET /v1/credentials from the control
// plane and renders metadata only. Secret values are never displayed: the
// API exposes keyed fingerprints and expiry status, and the page renders
// exactly those fields through the safe DOM helpers.

import { requireArrayField } from '../api.js';
import { append, el, setText, shortId, statusBadge, timestamp } from '../dom.js';
import type { PageContext, PageView } from '../router.js';
import type { CredentialView } from '../types.js';
import { createPageHost, dataTable, handlePageError, pageHeading, row } from './common.js';

export async function renderCredentialsPage(context: PageContext): Promise<PageView> {
  const host = createPageHost();
  host.show({ kind: 'loading', title: 'Reading credential metadata', message: 'Loading credential metadata from the control plane…' });
  try {
    const payload = await context.client.get<Record<string, unknown>>('/v1/credentials');
    const credentials = requireArrayField(payload, 'credentials', 'credential metadata list') as unknown as CredentialView[];
    const content = el('div', 'page__content');
    append(content, pageHeading('OPERATIONS / CREDENTIAL METADATA', 'Credentials', `${credentials.length} credential${credentials.length === 1 ? '' : 's'} tracked`));
    if (credentials.length === 0) {
      const empty = el('p', 'notice');
      setText(empty, 'The control plane has not recorded credential metadata.');
      append(content, empty);
    } else {
      const rows = credentials.map((credential) => {
        const fingerprint = el('code', 'mono');
        setText(fingerprint, credential.valueFingerprint === null || credential.valueFingerprint === '' ? '—' : shortId(credential.valueFingerprint, 16));
        return row([credential.provider, credential.purpose, statusBadge('credential', credential.status), timestamp(credential.expiresAt), timestamp(credential.lastCheckedAt), fingerprint]);
      });
      append(content, dataTable(['PROVIDER', 'PURPOSE', 'STATUS', 'EXPIRES', 'LAST CHECKED', 'VALUE FINGERPRINT'], rows));
    }
    const note = el('p', 'notice');
    setText(note, 'Secret values are never displayed; only keyed fingerprints and expiry metadata are exposed.');
    append(content, note);
    host.fill(content);
  } catch (error) {
    handlePageError(host, context, error);
  }
  return { title: 'Credentials', element: host.root };
}
