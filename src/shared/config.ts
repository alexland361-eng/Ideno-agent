import { z } from 'zod';

/**
 * Configuration types (§10, §12).
 *
 * Provider configuration is externalized to config/ideno.config.json (never
 * committed) with env-var overrides for secrets. The UI only ever receives
 * the *redacted* view defined at the bottom of this file.
 */

export const PRIVACY_MODES = ['LOCAL_ONLY', 'PREFERRED_LOCAL', 'CLOUD_ALLOWED', 'CLOUD_ONLY'] as const;
export const PrivacyMode = z.enum(PRIVACY_MODES);
export type PrivacyMode = z.infer<typeof PrivacyMode>;

/** How strictly a provider can produce structured (JSON) output. */
export const StructuredOutputMode = z.enum(['json_schema', 'json_object', 'none']);
export type StructuredOutputMode = z.infer<typeof StructuredOutputMode>;

export const ProviderConfigBase = z.object({
  /** Display name shown in the UI. */
  display_name: z.string().min(1).optional(),
  /** 'local' providers never leave the user's machine. */
  privacy: z.enum(['local', 'cloud']).default('cloud'),
  /** Default model for this provider. */
  model: z.string().min(1),
  /** Extra models selectable for routing ( informational; routing picks by provider id). */
  structured_output: StructuredOutputMode.optional(),
  streaming: z.boolean().optional(),
  /** Request timeout in ms. */
  timeout_ms: z.number().int().min(1000).max(600000).optional(),
  /** Env var name holding the API key (preferred over api_key in file). */
  api_key_env: z.string().optional(),
  /** Fallback: key in config file. Discouraged; never sent to the browser. */
  api_key: z.string().optional(),
});

export const OpenAICompatibleProviderConfig = ProviderConfigBase.extend({
  type: z.literal('openai_compatible'),
  base_url: z.string().url(),
  /** Set false if the endpoint rejects stream_options: {include_usage}. */
  include_usage_in_stream: z.boolean().optional(),
});

export const DemoProviderConfig = ProviderConfigBase.extend({
  type: z.literal('demo'),
});

export const ProviderConfig = z.discriminatedUnion('type', [
  OpenAICompatibleProviderConfig,
  DemoProviderConfig,
]);
export type ProviderConfig = z.infer<typeof ProviderConfig>;
export type OpenAICompatibleProviderConfig = z.infer<typeof OpenAICompatibleProviderConfig>;
export type DemoProviderConfig = z.infer<typeof DemoProviderConfig>;

/**
 * Task routing (§11). v0.1 has a single task ('conversation'), but routing is
 * already a table so per-task model selection can be added without touching
 * the core.
 */
export const TaskRoute = z.object({
  provider: z.string().min(1),
  fallbacks: z.array(z.string().min(1)).default([]),
});
export type TaskRoute = z.infer<typeof TaskRoute>;

export const AI_TASKS = ['conversation', 'critique'] as const;
export type AITask = (typeof AI_TASKS)[number];

export const RoutingConfig = z.record(z.string(), TaskRoute);

/**
 * Research providers (§17). Separate from LLM providers: research returns
 * SOURCED results; the model may summarize them but never invents sources.
 * Secrets are env-var only (api_key_env); base_url can be overridden to point
 * at a self-hosted mirror (e.g. a local SearXNG instance).
 */
export const TavilyResearchConfig = z.object({
  type: z.literal('tavily'),
  base_url: z.string().url().optional(),
  api_key_env: z.string().default('TAVILY_API_KEY'),
  timeout_ms: z.number().int().min(1000).max(60000).optional(),
});
export const BraveResearchConfig = z.object({
  type: z.literal('brave'),
  base_url: z.string().url().optional(),
  api_key_env: z.string().default('BRAVE_API_KEY'),
  timeout_ms: z.number().int().min(1000).max(60000).optional(),
});
export const SearXNGResearchConfig = z.object({
  type: z.literal('searxng'),
  /** Self-hosted SearXNG instance — no API key, stays on your network. */
  base_url: z.string().url(),
  timeout_ms: z.number().int().min(1000).max(60000).optional(),
});
export const ResearchProviderConfig = z.discriminatedUnion('type', [
  TavilyResearchConfig,
  BraveResearchConfig,
  SearXNGResearchConfig,
]);
export type ResearchProviderConfig = z.infer<typeof ResearchProviderConfig>;

export const IdenoConfig = z.object({
  server: z
    .object({
      host: z.string().default('0.0.0.0'),
      port: z.number().int().min(1).max(65535).default(8787),
      /**
       * Origins allowed to call the API cross-origin (CORS) — for static UI
       * deployments such as GitHub Pages. Default ['*'] is permissive but
       * safe for typical use: the API exposes no secrets and uses no
       * credentials. Restrict it when the server is publicly reachable.
       */
      allowed_origins: z.array(z.string().min(1)).default(['*']),
    })
    .prefault({}),
  data_dir: z.string().default('data'),
  privacy_mode: PrivacyMode.default('CLOUD_ALLOWED'),
  providers: z.record(z.string(), ProviderConfig),
  routing: RoutingConfig.default({}),
  /** How many recent conversation messages are included as context. */
  context: z
    .object({
      recent_messages: z.number().int().min(2).max(50).default(10),
    })
    .prefault({}),
  /** Optional research provider (§17). Absent = research explicitly unavailable. */
  research: ResearchProviderConfig.optional(),
});
export type IdenoConfig = z.infer<typeof IdenoConfig>;

// ---------------------------------------------------------------------------
// Redacted view (the ONLY config representation that reaches the browser)
// ---------------------------------------------------------------------------

export interface RedactedProviderInfo {
  id: string;
  type: string;
  display_name: string;
  model: string;
  privacy: 'local' | 'cloud';
  is_demo: boolean;
  /** Origin only — full URLs can embed credentials and are never exposed. */
  base_url_origin?: string;
  capabilities: {
    structured_output: StructuredOutputMode;
    streaming: boolean;
  };
}

export interface RedactedResearchInfo {
  id: string;
  type: 'tavily' | 'brave' | 'searxng';
  display_name: string;
  /** Origin only — full URLs never reach the browser. */
  base_url_origin?: string;
  /** true when the provider runs on the user's own network. */
  local: boolean;
}

export interface RedactedConfig {
  privacy_mode: PrivacyMode;
  providers: RedactedProviderInfo[];
  routing: Record<string, { provider: string; fallbacks: string[] }>;
  research_provider_configured: boolean;
  research?: RedactedResearchInfo;
}
