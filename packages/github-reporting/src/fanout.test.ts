import { describe, expect, it } from 'vitest';
import { fanOutFailure, postCommitStatus, renderActionsSummary, splitRepository, upsertStickyComment, type FanOutTargets } from './index.js';

const canary = 'launchpad-canary-2b91';

function mockFetch(handler: (url: string, init: RequestInit) => Promise<{ status: number; body: unknown }>): { fetchImpl: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const outcome = await handler(url, init ?? {});
    return new Response(typeof outcome.body === 'string' ? outcome.body : JSON.stringify(outcome.body), { status: outcome.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function targets(overrides: Partial<FanOutTargets> = {}): FanOutTargets {
  return { repository: 'acme/web-app', pullRequestNumber: 42, sourceCommit: 'a'.repeat(40), ...overrides };
}

describe('renderActionsSummary', () => {
  it('renders a bounded, escaped failure summary', () => {
    const summary = renderActionsSummary({ plans: [], providerError: { code: 'LP-VERCEL-TIMEOUT', message: 'upstream <timeout> for project demo', operationId: 'op-1', retryable: false } });
    expect(summary).toContain('LP-VERCEL-TIMEOUT');
    expect(summary).toContain('&lt;timeout&gt;');
    expect(summary).not.toContain('<timeout>');
  });

  it('does not fabricate plan evidence when no plan exists', () => {
    const summary = renderActionsSummary({ plans: [] });
    expect(summary).toContain('not available');
    expect(summary).not.toContain('READY');
  });
});

describe('splitRepository', () => {
  it('parses owner/repo and rejects malformed values', () => {
    expect(splitRepository('acme/web-app')).toEqual({ owner: 'acme', repo: 'web-app' });
    expect(splitRepository('not-a-repo')).toBeNull();
  });
});

describe('upsertStickyComment', () => {
  it('updates the existing sticky comment instead of creating a second one', async () => {
    const { fetchImpl, calls } = mockFetch(async (url, init) => {
      if (init.method === 'GET' || init.method === undefined) return { status: 200, body: [{ id: 7, body: '<!-- launchpad:plan -->\nold' }] };
      if (init.method === 'PATCH') return { status: 200, body: { id: 7 } };
      return { status: 200, body: { id: 8 } };
    });
    const result = await upsertStickyComment({ owner: 'acme', repo: 'web-app', pullRequestNumber: 42, token: 'ghp-x', fetchImpl }, '<!-- launchpad:plan -->\nnew');
    expect(result).toEqual({ delivered: true, error: null });
    expect(calls.map((call) => `${call.init.method ?? 'GET'} ${call.url}`)).toEqual([
      'GET https://api.github.com/repos/acme/web-app/issues/42/comments?per_page=100',
      'PATCH https://api.github.com/repos/acme/web-app/issues/comments/7',
    ]);
  });

  it('creates a new comment when no sticky comment exists yet', async () => {
    const { fetchImpl, calls } = mockFetch(async (url, init) => {
      if (init.method === 'GET' || init.method === undefined) return { status: 200, body: [{ id: 1, body: 'other' }] };
      return { status: 200, body: { id: 9 } };
    });
    const result = await upsertStickyComment({ owner: 'acme', repo: 'web-app', pullRequestNumber: 42, token: 'ghp-x', fetchImpl }, '<!-- launchpad:plan -->\nnew');
    expect(result).toEqual({ delivered: true, error: null });
    expect(calls.at(-1)?.init.method).toBe('POST');
    expect(calls.at(-1)?.url).toBe('https://api.github.com/repos/acme/web-app/issues/42/comments');
  });

  it('returns a visible delivery failure instead of throwing', async () => {
    const { fetchImpl } = mockFetch(async () => ({ status: 500, body: { message: 'boom' } }));
    const result = await upsertStickyComment({ owner: 'acme', repo: 'web-app', pullRequestNumber: 42, token: 'ghp-x', fetchImpl }, 'body');
    expect(result.delivered).toBe(false);
    expect(result.error).toContain('LP-GITHUB-COMMENT');
  });

  it('bounds oversized bodies at 60,000 chars preserving the marker and redaction', async () => {
    const { fetchImpl, calls } = mockFetch(async (url, init) => {
      if (init.method === 'GET' || init.method === undefined) return { status: 200, body: [{ id: 7, body: '<!-- launchpad:plan -->\nold' }] };
      return { status: 200, body: { id: 7 } };
    });
    const oversized = `<!-- launchpad:plan -->\ntoken=canary-secret\n${'a'.repeat(80_000)}`;
    const result = await upsertStickyComment({ owner: 'acme', repo: 'web-app', pullRequestNumber: 42, token: 'ghp-x', fetchImpl }, oversized);
    expect(result).toEqual({ delivered: true, error: null });
    const patch = calls.find((call) => call.init.method === 'PATCH');
    const posted = JSON.parse(String(patch?.init.body)) as { body: string };
    expect(posted.body.length).toBeLessThanOrEqual(60_000);
    expect(posted.body.startsWith('<!-- launchpad:plan -->')).toBe(true);
    expect(posted.body).toContain('…[truncated]');
    expect(posted.body).toContain('token=[REDACTED]');
    expect(posted.body).not.toContain('canary-secret');
  });
});

describe('postCommitStatus', () => {
  it('posts the failure status for the exact source commit', async () => {
    const { fetchImpl, calls } = mockFetch(async () => ({ status: 201, body: { id: 1 } }));
    const result = await postCommitStatus({ owner: 'acme', repo: 'web-app', sourceCommit: 'a'.repeat(40), workflow: 'apply', token: 'ghp-x', fetchImpl }, 'failure', 'Build failed');
    expect(result).toEqual({ delivered: true, error: null });
    expect(calls[0]!.url).toBe(`https://api.github.com/repos/acme/web-app/statuses/${'a'.repeat(40)}`);
    const body = JSON.parse(String(calls[0]!.init.body)) as { state: string; context: string };
    expect(body).toEqual({ state: 'failure', context: 'launchpad/apply', description: 'Build failed' });
  });
});

describe('fanOutFailure', () => {
  it('fans out to the sticky comment, commit status, and actions summary when context exists', async () => {
    const { fetchImpl, calls } = mockFetch(async (url, init) => {
      if (init.method === 'GET' || init.method === undefined) return { status: 200, body: [] };
      return { status: 200, body: { id: 1 } };
    });
    const result = await fanOutFailure({ targets: targets(), report: { plans: [], providerError: { code: 'LP-VERCEL-TIMEOUT', message: 'timed out', operationId: 'op-1', retryable: false } }, options: { token: 'ghp-x', fetchImpl } });
    expect(result.comment).toEqual({ delivered: true, error: null });
    expect(result.commitStatus).toEqual({ delivered: true, error: null });
    expect(result.actionsSummary).toContain('LP-VERCEL-TIMEOUT');
    expect(calls.some((call) => call.url.includes('/statuses/'))).toBe(true);
  });

  it('skips GitHub surfaces when no context or token exists, keeping the summary', async () => {
    const result = await fanOutFailure({ targets: { repository: null, pullRequestNumber: null, sourceCommit: null }, report: { plans: [], providerError: { code: 'LP-X', message: 'boom', operationId: null, retryable: false } }, options: {} });
    expect(result.comment).toBeNull();
    expect(result.commitStatus).toBeNull();
    expect(result.actionsSummary.length).toBeGreaterThan(0);
  });

  it('never leaks canary secrets through any fan-out surface', async () => {
    const { fetchImpl } = mockFetch(async (url, init) => {
      if (init.method === 'GET' || init.method === undefined) return { status: 200, body: [] };
      return { status: 200, body: { id: 1 } };
    });
    const result = await fanOutFailure({
      targets: targets(),
      report: { plans: [], providerError: { code: 'LP-CANARY', message: `token=${canary}`, operationId: 'op-1', retryable: false } },
      options: { token: 'ghp-x', fetchImpl },
    });
    const surfaces = [result.actionsSummary, result.comment?.delivered, result.commitStatus?.delivered];
    expect(JSON.stringify(surfaces)).not.toContain(canary);
  });
});
