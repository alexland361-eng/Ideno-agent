/**
 * Session management for the web client ("remember the user").
 *
 * The browser holds ONLY the user's own Supabase session tokens (access +
 * refresh). Provider API keys are NEVER stored in the browser — they are
 * sent once through the connected Ideno server (over HTTPS) and live in
 * Supabase, server-side. Reads return redacted hints only.
 *
 * All auth calls go through the Ideno backend (/api/auth/*), so no Supabase
 * keys (not even the anon key) ever appear in the browser.
 */

import type { ApiMode } from './api';

const SESSION_KEY = 'ideno.session';

export interface SessionUser {
  id: string;
  email: string | null;
}

export interface Session {
  access_token: string;
  refresh_token: string;
  expires_at: number | null;
  user: SessionUser;
}

export function readSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Session;
    if (!s?.access_token || !s?.refresh_token || !s.user?.id) return null;
    return s;
  } catch {
    return null;
  }
}

export function writeSession(session: Session): void {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // storage unavailable — session just won't persist
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    // ignore
  }
}

/** Authorization header for authenticated API calls (or undefined). */
export function authHeader(): Record<string, string> {
  const s = readSession();
  return s ? { Authorization: `Bearer ${s.access_token}` } : {};
}

async function apiBase(): Promise<string> {
  const { getApiMode } = await import('./api.js');
  const mode = await getApiMode();
  if (mode === 'demo') {
    throw Object.assign(new Error('Accounts require a connected Ideno server — the offline demo has no accounts.'), {
      code: 'AUTH_UNAVAILABLE',
    });
  }
  const { readApiBase } = await import('./api.js');
  return readApiBase();
}

async function post<T>(path: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
  const base = await apiBase();
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as (T & { code?: string; message?: string }) | null;
  if (!res.ok) {
    throw Object.assign(new Error(data?.message ?? `Request failed (HTTP ${res.status})`), { code: data?.code });
  }
  return data as T;
}

export async function signUp(email: string, password: string): Promise<{ user: SessionUser }> {
  return post<{ user: SessionUser }>('/api/auth/signup', { email, password });
}

export async function signIn(email: string, password: string): Promise<Session> {
  const session = await post<Session>('/api/auth/login', { email, password });
  writeSession(session);
  return session;
}

export async function signOut(): Promise<void> {
  try {
    await post('/api/auth/logout', {}, authHeader());
  } catch {
    // best-effort; clear locally regardless
  }
  clearSession();
}

export async function refreshSession(): Promise<Session | null> {
  const current = readSession();
  if (!current) return null;
  try {
    const session = await post<Session>('/api/auth/refresh', { refresh_token: current.refresh_token });
    writeSession(session);
    return session;
  } catch {
    clearSession();
    return null;
  }
}

/**
 * Silent boot check ("remember the user"): if a stored session is expired or
 * about to expire, refresh it; verify it still works. Returns the live user
 * or null. Never throws.
 */
export async function ensureSession(mode: ApiMode): Promise<SessionUser | null> {
  if (mode === 'demo') return null;
  const current = readSession();
  if (!current) return null;
  const nowSec = Math.floor(Date.now() / 1000);
  if (current.expires_at === null || current.expires_at - nowSec < 60) {
    const refreshed = await refreshSession();
    return refreshed?.user ?? null;
  }
  return current.user;
}
