import type { AIProvider } from '../types.js';
import { ConfigurationError } from '../errors.js';
import type { IdenoConfig, ProviderConfig } from '../../../shared/config.js';
import { OpenAICompatibleProvider } from './openaiCompatible.js';
import { DemoProvider } from './demo.js';

/**
 * Provider registry — the ONLY place provider implementations are wired in.
 * Adding a new adapter class (native vendor APIs, other transports) means
 * adding one case here; Ideno Core stays untouched.
 */

export function createProvider(
  id: string,
  config: ProviderConfig,
  env: Record<string, string | undefined>,
): AIProvider {
  switch (config.type) {
    case 'openai_compatible':
      return new OpenAICompatibleProvider(id, config, env);
    case 'demo':
      return new DemoProvider(id, config);
    default: {
      // Exhaustiveness guard: if a new provider type is added to the config
      // schema without an adapter, this fails loudly at startup.
      const unreachable: never = config;
      throw new ConfigurationError(`No adapter implemented for provider type '${(unreachable as ProviderConfig).type}'`);
    }
  }
}

export function buildProviders(config: IdenoConfig, env: Record<string, string | undefined>): Map<string, AIProvider> {
  const providers = new Map<string, AIProvider>();
  for (const [id, providerConfig] of Object.entries(config.providers)) {
    providers.set(id, createProvider(id, providerConfig, env));
  }
  return providers;
}
