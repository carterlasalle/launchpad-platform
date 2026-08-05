import { redactText } from './logging.js';

/** Hard cap for primary control-repo sticky comments (GitHub allows 65,536 chars for issue comments). */
export const MAX_STICKY_COMMENT_CHARS = 60_000;

const TRUNCATION_MARKER = '\n\n…[truncated]';

/**
 * Bounds a sticky PR comment body to at most MAX_STICKY_COMMENT_CHARS
 * characters. Redaction is applied before truncation so credential-shaped
 * text never survives the cut; the body head — which carries the sticky
 * marker — is preserved; an explicit truncation marker (with an optional
 * link to the full report) is appended. Never throws and never exceeds the
 * cap: the marker length is subtracted from the head budget.
 */
export function boundStickyCommentBody(body: string, reportUrl?: string | null): string {
  const redacted = redactText(body);
  if (redacted.length <= MAX_STICKY_COMMENT_CHARS) return redacted;
  const link = reportUrl ? ` — full report: ${reportUrl}` : '';
  const marker = `${TRUNCATION_MARKER}${link}`;
  const headChars = Math.max(0, MAX_STICKY_COMMENT_CHARS - marker.length);
  return `${redacted.slice(0, headChars)}${marker}`;
}
