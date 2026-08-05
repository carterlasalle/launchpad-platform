// Operator session token storage. The token is kept in sessionStorage so it
// never survives the browser tab, and the in-memory ApiClient copy is the
// source of truth while the tab is open.

const SESSION_TOKEN_KEY = 'launchpad.dashboard.sessionToken';

export function readSessionToken(): string | null {
  try {
    return sessionStorage.getItem(SESSION_TOKEN_KEY);
  } catch {
    // Storage unavailable (e.g. private browsing): no persisted session.
    return null;
  }
}

export function writeSessionToken(token: string | null): void {
  try {
    if (token === null) sessionStorage.removeItem(SESSION_TOKEN_KEY);
    else sessionStorage.setItem(SESSION_TOKEN_KEY, token);
  } catch {
    // Storage unavailable: the in-memory session on the client still applies.
  }
}
