import type { AIProvider } from './types.js';
import { CapabilityError } from './errors.js';
import type { AITask, PrivacyMode } from '../../shared/config.js';
import { unmetRequirements } from './capabilities.js';

/**
 * Model routing (§11) with privacy filtering (§12).
 *
 * v0.1 routing is a configuration table (task → provider + fallbacks), not
 * intelligent selection — but the indirection means smarter routing can be
 * added later without touching the core. Privacy modes are enforced here:
 * LOCAL_ONLY never routes to cloud providers, CLOUD_ONLY never routes to
 * local ones.
 */

export interface RouteResolution {
  provider: AIProvider;
  /** Providers that were considered and why they were skipped. */
  skipped: Array<{ providerId: string; reason: string }>;
}

export function privacyAllows(mode: PrivacyMode, provider: AIProvider): boolean {
  const isLocal = provider.capabilities.privacy === 'local';
  switch (mode) {
    case 'LOCAL_ONLY':
      return isLocal;
    case 'CLOUD_ONLY':
      return !isLocal;
    case 'PREFERRED_LOCAL':
    case 'CLOUD_ALLOWED':
      return true;
  }
}

export function resolveRoute(
  task: AITask,
  mode: PrivacyMode,
  providers: Map<string, AIProvider>,
  routing: Record<string, { provider: string; fallbacks: string[] }>,
): RouteResolution {
  const skipped: Array<{ providerId: string; reason: string }> = [];
  const route = routing[task];

  // Candidate order: configured route first (primary + fallbacks), then, for
  // PREFERRED_LOCAL, any local provider, then any provider at all.
  const candidateIds: string[] = [];
  if (route) candidateIds.push(route.provider, ...route.fallbacks);
  if (mode === 'PREFERRED_LOCAL') {
    for (const id of providers.keys()) if (!candidateIds.includes(id)) candidateIds.push(id);
  }
  for (const id of providers.keys()) if (!candidateIds.includes(id)) candidateIds.push(id);

  for (const id of candidateIds) {
    const provider = providers.get(id);
    if (!provider) {
      if (route && (route.provider === id || route.fallbacks.includes(id))) {
        skipped.push({ providerId: id, reason: 'Configured in routing but not defined in providers.' });
      }
      continue;
    }
    if (!privacyAllows(mode, provider)) {
      skipped.push({
        providerId: id,
        reason: `Excluded by privacy mode ${mode} (provider privacy: ${provider.capabilities.privacy}).`,
      });
      continue;
    }
    const unmet = unmetRequirements(task, provider);
    if (unmet.length > 0) {
      skipped.push({ providerId: id, reason: unmet.join(' ') });
      continue;
    }
    return { provider, skipped };
  }

  const detail = [
    ...skipped.map((s) => `${s.providerId}: ${s.reason}`),
    mode === 'LOCAL_ONLY'
      ? 'LOCAL_ONLY mode requires a local provider (privacy: local) — none is configured or all were excluded.'
      : '',
  ].filter(Boolean);
  throw new CapabilityError(`No provider available for task '${task}' under privacy mode ${mode}.`, detail);
}
