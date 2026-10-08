import type { AIRuntime } from '../ai/runtime.js';
import { buildRuntime } from '../config/load.js';
import { IdenoConfig } from '../../shared/config.js';
import type { IdenoConfig as ConfigType } from '../../shared/config.js';
import { AppError } from '../../shared/errors.js';
import type { UserSettings } from './client.js';

/**
 * Per-user AI runtime construction (server-side only).
 *
 * When a signed-in user has provider settings stored in Supabase, the chat
 * endpoint builds an AIRuntime from THOSE providers (their keys are consumed
 * here, on the server — they never cross to the browser). Users without
 * stored providers use the server's own configured runtime.
 *
 * Runtimes are cached per user and invalidated when settings change.
 */

export interface StoredProvider {
  id: string;
  record: Record<string, unknown>;
}

const runtimeCache = new Map<string, { runtime: AIRuntime; fingerprint: string }>();

function fingerprint(settings: UserSettings): string {
  return JSON.stringify(settings);
}

/** Build (or fetch from cache) the per-user runtime. */
export function runtimeForUser(
  userId: string,
  settings: UserSettings,
  baseConfig: ConfigType,
): AIRuntime {
  if (settings.providers.length === 0) {
    throw new AppError('BAD_REQUEST', 'User has no providers configured.');
  }
  const fp = fingerprint(settings);
  const cached = runtimeCache.get(userId);
  if (cached && cached.fingerprint === fp) return cached.runtime;

  const providers: Record<string, Record<string, unknown>> = {};
  for (const p of settings.providers) {
    const { id, ...rest } = p;
    providers[id] = { ...rest };
  }
  const firstId = settings.routing?.conversation?.provider ?? settings.providers[0]!.id;
  const parsed = IdenoConfig.safeParse({
    // The server's privacy mode governs user providers too (§12): a
    // LOCAL_ONLY server refuses cloud providers even if a user adds one.
    privacy_mode: baseConfig.privacy_mode,
    providers,
    routing: { conversation: { provider: providers[firstId] ? firstId : settings.providers[0]!.id, fallbacks: [] } },
  });
  if (!parsed.success) {
    throw new AppError('CONFIG_INVALID', 'Stored provider settings are invalid.', {
      detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }
  const runtime = buildRuntime(parsed.data as ConfigType);
  runtimeCache.set(userId, { runtime, fingerprint: fp });
  return runtime;
}

/** Drop the cached runtime for a user (call after settings updates). */
export function invalidateUserRuntime(userId: string): void {
  runtimeCache.delete(userId);
}

/** Test hook. */
export function clearRuntimeCache(): void {
  runtimeCache.clear();
}
