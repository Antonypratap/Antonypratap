import { useSyncExternalStore } from 'react';
import { ApiSessionSchema, CSRF_HEADER, type ApiSession, type Permission } from '@veyra/shared';

/**
 * The browser's view of the sign-in (Phase 6C). The server decides everything: the session lives
 * in an HttpOnly cookie this code cannot read, and every permission is enforced by the API. Kept
 * here, in memory only (never localStorage, sessionStorage or the URL): the CSRF token the API
 * asks state-changing requests to echo, and which parts of the product to show.
 */
export type SignedIn = Extract<ApiSession, { authenticated: true }>;
export type SessionState =
  | { status: 'loading' }
  | { status: 'signedOut'; demoSignIn: boolean; notice: string | null }
  | { status: 'signedIn'; session: SignedIn };

let state: SessionState = { status: 'loading' };
const listeners = new Set<() => void>();

function set(next: SessionState): void {
  state = next;
  for (const l of listeners) l();
}

export function sessionState(): SessionState {
  return state;
}

export function useSession(): SessionState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => state,
  );
}

/** The CSRF header for a state-changing request (none when signed out). */
export function csrfHeaders(): Record<string, string> {
  return state.status === 'signedIn' ? { [CSRF_HEADER]: state.session.csrfToken } : {};
}

/** Whether the signed-in role may do something (to hide what it cannot; the server decides). */
export function allowed(permission: Permission): boolean {
  return state.status === 'signedIn' && state.session.permissions.includes(permission);
}

export function useAllowed(permission: Permission): boolean {
  const s = useSession();
  return s.status === 'signedIn' && s.session.permissions.includes(permission);
}

/** The API answered 401: the session ended (expired, signed out elsewhere, user disabled). */
export function sessionEnded(): void {
  if (state.status !== 'signedIn') return;
  set({
    status: 'signedOut',
    demoSignIn: state.session.demoSignIn,
    notice: 'Your session has ended. Sign in again to continue.',
  });
}

export class SignInError extends Error {}

const BASE = '/api/v1/auth';

async function call(path: string, init?: RequestInit): Promise<ApiSession> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { credentials: 'same-origin', ...init });
  } catch {
    throw new SignInError('Veyra could not be reached. Try again in a moment.');
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: { message?: unknown } }).error.message ?? '')
        : '';
    throw new SignInError(message || 'Sign-in did not work. Try again.');
  }
  return ApiSessionSchema.parse(body);
}

function apply(session: ApiSession): void {
  set(
    session.authenticated
      ? { status: 'signedIn', session }
      : { status: 'signedOut', demoSignIn: session.demoSignIn, notice: null },
  );
}

/** Asks the server who is signed in (the cookie goes along; this code never sees it). */
export async function loadSession(): Promise<void> {
  try {
    apply(await call('/session'));
  } catch {
    set({ status: 'signedOut', demoSignIn: false, notice: 'Veyra could not be reached.' });
  }
}

const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...csrfHeaders() },
  body: JSON.stringify(body),
});

export async function signIn(email: string, password: string): Promise<void> {
  apply(await call('/login', post({ email, password })));
}

/** Demo environments only: the demo PIN, checked by the server. */
export async function demoSignIn(pin: string): Promise<void> {
  apply(await call('/demo', post({ pin })));
}

export async function signOut(): Promise<void> {
  const demo = state.status === 'signedIn' && state.session.demoSignIn;
  await fetch(`${BASE}/logout`, { ...post({}), credentials: 'same-origin' }).catch(() => null);
  set({ status: 'signedOut', demoSignIn: demo, notice: 'You have signed out.' });
}
