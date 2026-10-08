import { AppError } from '../../shared/errors.js';

/**
 * Supabase REST client (zero dependencies — plain fetch).
 *
 * Supabase is used for TWO things, both mediated by THIS SERVER so that no
 * Supabase secrets and no provider API keys ever reach the browser:
 *
 *  1. AUTH ("remember the user"): the web client calls /api/auth/* on the
 *     Ideno backend; this client talks to Supabase's auth endpoints and
 *     returns session tokens to the browser (the user's own credentials).
 *  2. PER-USER SETTINGS (including provider API keys): stored in the
 *     `ideno_user_settings` table, accessible ONLY with the service role
 *     (the table has no client policies — see supabase/migrations). The
 *     browser receives exclusively redacted views (key hints, origins).
 *
 * Endpoint shapes follow Supabase's documented REST API (auth/v1 + rest/v1).
 */

export interface SupabaseUser {
  id: string;
  email: string | null;
}

export interface SupabaseSession {
  access_token: string;
  refresh_token: string;
  expires_at: number | null;
  user: SupabaseUser;
}

export interface UserSettings {
  /** Provider configs keyed by id (values validated by ProviderConfig). */
  providers: Array<Record<string, unknown> & { id: string }>;
  routing?: { conversation?: { provider?: string } };
}

const DEFAULT_TIMEOUT_MS = 10_000;

export class SupabaseClient {
  constructor(
    private readonly url: string,
    private readonly anonKey: string,
    private readonly serviceKey: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  get configured(): boolean {
    return true;
  }

  /* ------------------------------------------------------------------ auth */

  private async authFetch(path: string, init: RequestInit, token?: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        apikey: this.anonKey,
        ...((init.headers as Record<string, string>) ?? {}),
      };
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await this.fetchFn(`${this.url}/auth/v1${path}`, {
        ...init,
        headers,
        signal: controller.signal,
      });
      const text = await res.text();
      const body: unknown = text ? JSON.parse(text) : null;
      if (!res.ok) {
        const msg =
          (body as { msg?: string; message?: string; error_description?: string } | null)?.msg ??
          (body as { message?: string } | null)?.message ??
          (body as { error_description?: string } | null)?.error_description ??
          `Supabase auth error (HTTP ${res.status}).`;
        throw new AppError('AUTH_INVALID', msg, { recoverable: true, status: res.status });
      }
      return body;
    } catch (err) {
      if (err instanceof AppError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new AppError('TIMEOUT', `Supabase auth request timed out.`, { recoverable: true });
      }
      throw new AppError('PROVIDER_UNAVAILABLE', `Could not reach Supabase: ${err instanceof Error ? err.message : String(err)}.`, {
        recoverable: true,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async signUp(email: string, password: string): Promise<SupabaseUser> {
    const body = (await this.authFetch('/signup', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    })) as { id?: string; email?: string } | null;
    if (!body?.id) {
      // Supabase may require email confirmation — surface that honestly.
      throw new AppError('AUTH_INVALID', 'Sign-up succeeded but needs email confirmation before signing in.', {
        recoverable: true,
      });
    }
    return { id: body.id, email: body.email ?? email };
  }

  async signInWithPassword(email: string, password: string): Promise<SupabaseSession> {
    const body = (await this.authFetch('/token?grant_type=password', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    })) as {
      access_token: string;
      refresh_token: string;
      expires_in?: number;
      user?: { id: string; email?: string | null };
    } | null;
    if (!body?.access_token || !body.user?.id) {
      throw new AppError('AUTH_INVALID', 'Supabase returned an incomplete session.', { recoverable: false });
    }
    return {
      access_token: body.access_token,
      refresh_token: body.refresh_token,
      expires_at: body.expires_in ? Math.floor(Date.now() / 1000) + body.expires_in : null,
      user: { id: body.user.id, email: body.user.email ?? email },
    };
  }

  async refreshSession(refreshToken: string): Promise<SupabaseSession> {
    const body = (await this.authFetch('/token?grant_type=refresh_token', {
      method: 'POST',
      body: JSON.stringify({ refresh_token: refreshToken }),
    })) as {
      access_token: string;
      refresh_token: string;
      expires_in?: number;
      user?: { id: string; email?: string | null };
    } | null;
    if (!body?.access_token || !body.user?.id) {
      throw new AppError('AUTH_INVALID', 'Session could not be refreshed. Sign in again.', { recoverable: true });
    }
    return {
      access_token: body.access_token,
      refresh_token: body.refresh_token,
      expires_at: body.expires_in ? Math.floor(Date.now() / 1000) + body.expires_in : null,
      user: { id: body.user.id, email: body.user.email ?? null },
    };
  }

  async signOut(accessToken: string): Promise<void> {
    await this.authFetch('/logout', { method: 'POST' }, accessToken).catch(() => undefined);
  }

  /** Verify a user token and return the user. Throws AUTH_INVALID when bad. */
  async verifyUserToken(token: string): Promise<SupabaseUser> {
    const body = (await this.authFetch('/user', { method: 'GET' }, token)) as
      | { id?: string; email?: string | null }
      | null;
    if (!body?.id) throw new AppError('AUTH_INVALID', 'Invalid session token.', { recoverable: true, status: 401 });
    return { id: body.id, email: body.email ?? null };
  }

  /* --------------------------------------------------------------- settings */

  private async restFetch(path: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        apikey: this.serviceKey,
        Authorization: `Bearer ${this.serviceKey}`,
        ...((init.headers as Record<string, string>) ?? {}),
      };
      const res = await this.fetchFn(`${this.url}/rest/v1${path}`, {
        ...init,
        headers,
        signal: controller.signal,
      });
      const text = await res.text();
      const body: unknown = text ? JSON.parse(text) : null;
      if (!res.ok) {
        const msg = (body as { message?: string } | null)?.message ?? `Supabase REST error (HTTP ${res.status}).`;
        throw new AppError('PROVIDER_UNAVAILABLE', msg, {
          recoverable: true,
          detail: res.status === 404
            ? ['The ideno_user_settings table does not exist. Run supabase/migrations/0001_user_settings.sql in the Supabase SQL editor.']
            : undefined,
        });
      }
      return body;
    } catch (err) {
      if (err instanceof AppError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new AppError('TIMEOUT', 'Supabase settings request timed out.', { recoverable: true });
      }
      throw new AppError('PROVIDER_UNAVAILABLE', `Could not reach Supabase: ${err instanceof Error ? err.message : String(err)}.`, {
        recoverable: true,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async getUserSettings(userId: string): Promise<UserSettings> {
    const rows = (await this.restFetch(
      `/ideno_user_settings?user_id=eq.${encodeURIComponent(userId)}&select=settings`,
      { method: 'GET' },
    )) as Array<{ settings?: UserSettings }>;
    const settings = rows[0]?.settings;
    return settings ?? { providers: [] };
  }

  async upsertUserSettings(userId: string, settings: UserSettings): Promise<void> {
    await this.restFetch('/ideno_user_settings', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ user_id: userId, settings, updated_at: new Date().toISOString() }),
    });
  }
}

/** Build the client from config when the supabase section is present. */
export function buildSupabaseClient(
  cfg: { url: string; anon_key_env: string; service_key_env: string } | undefined,
  env: NodeJS.ProcessEnv = process.env,
  fetchFn?: typeof fetch,
): SupabaseClient | null {
  if (!cfg) return null;
  const anon = env[cfg.anon_key_env];
  const service = env[cfg.service_key_env];
  if (!anon || !service) {
    throw new AppError('CONFIG_INVALID', 'Supabase is configured but its env keys are missing.', {
      detail: [
        `Set ${cfg.anon_key_env} and ${cfg.service_key_env} in the environment (keys are env-only; never in config files).`,
      ],
    });
  }
  return new SupabaseClient(cfg.url, anon, service, fetchFn);
}
