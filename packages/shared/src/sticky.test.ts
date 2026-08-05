import { describe, expect, it } from 'vitest';
import { MAX_STICKY_COMMENT_CHARS, boundStickyCommentBody } from './index.js';

const marker = '<!-- launchpad:plan -->';

describe('boundStickyCommentBody', () => {
  it('keeps bodies under the cap unchanged', () => {
    const body = `${marker}\n\nReport body`;
    expect(boundStickyCommentBody(body)).toBe(body);
  });

  it('bounds oversized bodies at the cap preserving the marker and appending a clear truncation marker', () => {
    const body = `${marker}\n\n${'a'.repeat(100_000)}`;
    const bounded = boundStickyCommentBody(body);
    expect(bounded.length).toBeLessThanOrEqual(MAX_STICKY_COMMENT_CHARS);
    expect(bounded.startsWith(marker)).toBe(true);
    expect(bounded).toContain('…[truncated]');
  });

  it('redacts credential-shaped text before truncation so secrets never survive', () => {
    const body = `${marker}\ntoken=canary-secret\n${'a'.repeat(100_000)}`;
    const bounded = boundStickyCommentBody(body);
    expect(bounded.length).toBeLessThanOrEqual(MAX_STICKY_COMMENT_CHARS);
    expect(bounded).toContain('token=[REDACTED]');
    expect(bounded).not.toContain('canary-secret');
  });

  it('appends a full-report link when a report URL is provided', () => {
    const bounded = boundStickyCommentBody(`${marker}\n${'a'.repeat(100_000)}`, 'https://github.test/acme/app/actions/runs/42');
    expect(bounded.length).toBeLessThanOrEqual(MAX_STICKY_COMMENT_CHARS);
    expect(bounded).toContain('…[truncated]');
    expect(bounded).toContain('https://github.test/acme/app/actions/runs/42');
  });
});
