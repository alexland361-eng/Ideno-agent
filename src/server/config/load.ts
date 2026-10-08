import { promises as fs } from 'node:fs';
import path from 'node:path';
import { IdenoConfig } from '../../shared/config.js';
import type { IdenoConfig as ConfigType, RedactedConfig, RedactedProviderInfo } from '../../shared/config.js';
import { ConfigurationError } from '../ai/errors.js';
import { buildProviders } from '../ai/providers/index.js';

export { buildProviders };
import { AIRuntime } from '../ai/runtime.js';

/**
 * Configuration loading (§10 Provider Configuration).
 *
 * - config/ideno.config.json is the source (gitignored; auto-created from a
 *   safe default on first run so a fresh clone boots).
 * - IDENO_CONFIG points at an alternative file.
 * - Secrets come from env vars (api_key_env) — preferred — or the config file.
 * - Privacy mode and server settings can be overridden by env for operators.
 *
 * The ONLY representation that ever leaves the server is `redact()` — the
 * browser never sees keys, full URLs, or file contents.
 */

export const DEFAULT_CONFIG_PATH = path.resolve('config/ideno.config.json');

/** Safe first-run default: the clearly-labeled scripted demo provider. */
export const DEFAULT_CONFIG: unknown = {
  server: { host: '0.0.0.0', port: 8787 },
  data_dir: 'data',
  privacy_mode: 'CLOUD_ALLOWED',
  providers: {
    demo: {
      type: 'demo',
      display_name: 'Scripted demo (not AI)',
      privacy: 'local',
      model: 'scripted-demo-v0',
    },
  },
  routing: {
    conversation: { provider: 'demo', fallbacks: [] },
  },
};

export interface LoadedConfig {
  config: ConfigType;
  configPath: string;
  /** Non-fatal notes (e.g. "created default config"). */
  notes: string[];
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<LoadedConfig> {
  const notes: string[] = [];
  const configPath = env.IDENO_CONFIG ? path.resolve(env.IDENO_CONFIG) : DEFAULT_CONFIG_PATH;

  let raw: string;
  try {
    raw = await fs.readFile(configPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new ConfigurationError(`Could not read config file ${configPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, 'utf8');
    notes.push(`Created default config at ${configPath} (scripted demo provider). Edit it to configure a real model — see config/ideno.config.example.json.`);
    raw = JSON.stringify(DEFAULT_CONFIG);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (err) {
    throw new ConfigurationError(`Config file ${configPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  // `providers` and `routing` are Zod records (every value must be a provider
  // or route object), so "$note"/"$comment" annotation keys inside them would
  // fail validation. Strip `$`-prefixed keys from those two records before
  // parsing — annotations elsewhere are already tolerated (objects strip
  // unknown keys). Discovered when the example config itself tripped on this.
  stripDollarKeys(parsedJson, ['providers', 'routing']);

  const parsed = IdenoConfig.safeParse(parsedJson);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`);
    throw new ConfigurationError(`Config file ${configPath} is invalid.`, detail);
  }
  const config = parsed.data;

  // --- env overrides (operators, not secrets) ---
  if (env.IDENO_PRIVACY_MODE) {
    if (!['LOCAL_ONLY', 'PREFERRED_LOCAL', 'CLOUD_ALLOWED', 'CLOUD_ONLY'].includes(env.IDENO_PRIVACY_MODE)) {
      throw new ConfigurationError(`IDENO_PRIVACY_MODE must be one of LOCAL_ONLY, PREFERRED_LOCAL, CLOUD_ALLOWED, CLOUD_ONLY (got '${env.IDENO_PRIVACY_MODE}').`);
    }
    config.privacy_mode = env.IDENO_PRIVACY_MODE as ConfigType['privacy_mode'];
    notes.push(`Privacy mode overridden by env: ${config.privacy_mode}`);
  }
  if (env.PORT) {
    const port = parseInt(env.PORT, 10);
    if (Number.isNaN(port) || port < 1 || port > 65535) {
      throw new ConfigurationError(`PORT must be an integer between 1 and 65535 (got '${env.PORT}').`);
    }
    config.server.port = port;
  }
  if (env.IDENO_HOST) config.server.host = env.IDENO_HOST;
  if (env.IDENO_DATA_DIR) config.data_dir = env.IDENO_DATA_DIR;

  // --- structural sanity: routing references must exist ---
  const problems: string[] = [];
  for (const [task, route] of Object.entries(config.routing)) {
    if (!config.providers[route.provider]) {
      problems.push(`routing.${task}.provider '${route.provider}' is not defined in providers.`);
    }
    for (const fb of route.fallbacks) {
      if (!config.providers[fb]) problems.push(`routing.${task}.fallbacks '${fb}' is not defined in providers.`);
    }
  }
  if (Object.keys(config.providers).length === 0) {
    problems.push('No providers configured. Add one in config/ideno.config.json (see the example file).');
  }
  if (problems.length > 0) {
    throw new ConfigurationError('Configuration references unknown providers.', problems);
  }

  return { config, configPath, notes };
}

/**
 * Build the runtime from config. Env is passed explicitly (never read from
 * process.env deep inside providers) so tests can inject values.
 */
export function buildRuntime(config: ConfigType, env: NodeJS.ProcessEnv = process.env): AIRuntime {
  const providers = buildProviders(config, env);
  return new AIRuntime(providers, { privacy_mode: config.privacy_mode, routing: config.routing });
}

/** The only config view that is ever sent to the browser. */
export function redactConfig(config: ConfigType): RedactedConfig {
  const providers: RedactedProviderInfo[] = Object.entries(config.providers).map(([id, p]) => {
    let origin: string | undefined;
    if (p.type === 'openai_compatible') {
      try {
        origin = new URL(p.base_url).origin;
      } catch {
        origin = '<invalid url>';
      }
    }
    return {
      id,
      type: p.type,
      display_name: p.display_name ?? id,
      model: p.model,
      privacy: p.privacy,
      is_demo: p.type === 'demo',
      base_url_origin: origin,
      capabilities: {
        structured_output: p.structured_output ?? (p.type === 'demo' ? 'json_schema' : 'json_schema'),
        streaming: p.streaming ?? true,
      },
    };
  });
  return {
    privacy_mode: config.privacy_mode,
    providers,
    routing: config.routing,
    research_provider_configured: false,
  };
}

function stripDollarKeys(value: unknown, keys: string[]): void {
  if (value === null || typeof value !== 'object') return;
  const obj = value as Record<string, unknown>;
  for (const key of keys) {
    const child = obj[key];
    if (child !== null && typeof child === 'object' && !Array.isArray(child)) {
      for (const subKey of Object.keys(child as object)) {
        if (subKey.startsWith('$')) {
          delete (child as Record<string, unknown>)[subKey];
        }
      }
    }
  }
}
