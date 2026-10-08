import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, redactConfig, buildProviders } from '../src/server/config/load.js';
import { ConfigurationError } from '../src/server/ai/errors.js';
import { resolveRoute } from '../src/server/ai/routing.js';
import { CapabilityError } from '../src/server/ai/errors.js';

let dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ideno-cfg-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => undefined)));
  dirs = [];
});

describe('loadConfig', () => {
  it('creates a safe default config (demo provider) on first run', async () => {
    const dir = await tempDir();
    const env = { IDENO_CONFIG: path.join(dir, 'ideno.config.json') };
    const { config, notes } = await loadConfig(env);
    expect(config.providers.demo?.type).toBe('demo');
    expect(notes.length).toBeGreaterThan(0);
    // File was actually written.
    const raw = JSON.parse(await fs.readFile(env.IDENO_CONFIG!, 'utf8'));
    expect(raw.providers.demo.type).toBe('demo');
  });

  it('loads a real openai_compatible config', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'config.json');
    await fs.writeFile(
      file,
      JSON.stringify({
        providers: {
          ollama: { type: 'openai_compatible', base_url: 'http://localhost:11434/v1', model: 'llama3.1', api_key_env: 'OLLAMA_KEY', privacy: 'local' },
        },
        routing: { conversation: { provider: 'ollama' } },
      }),
      'utf8',
    );
    const { config } = await loadConfig({ IDENO_CONFIG: file, OLLAMA_KEY: 'secret-value' });
    expect(config.providers.ollama?.type).toBe('openai_compatible');
    expect(config.privacy_mode).toBe('CLOUD_ALLOWED'); // default
  });

  it('rejects invalid configs with useful detail', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'config.json');
    await fs.writeFile(file, JSON.stringify({ providers: { bad: { type: 'openai_compatible', base_url: 'not-a-url', model: '' } } }), 'utf8');
    await expect(loadConfig({ IDENO_CONFIG: file })).rejects.toThrow(ConfigurationError);
  });

  it('rejects routing that references unknown providers', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'config.json');
    await fs.writeFile(
      file,
      JSON.stringify({ providers: { demo: { type: 'demo', model: 'x' } }, routing: { conversation: { provider: 'ghost' } } }),
      'utf8',
    );
    await expect(loadConfig({ IDENO_CONFIG: file })).rejects.toThrow(ConfigurationError);
    try {
      await loadConfig({ IDENO_CONFIG: file });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigurationError);
      expect((err as ConfigurationError).detail.join(' ')).toContain('not defined in providers');
    }
  });

  it('tolerates $-prefixed annotation keys inside providers and routing', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'config.json');
    await fs.writeFile(
      file,
      JSON.stringify({
        providers: { demo: { type: 'demo', model: 'x' }, $note: 'annotations are fine' },
        routing: {
          conversation: { provider: 'demo', fallbacks: [] },
          $note: 'per-task routing notes are fine too',
        },
      }),
      'utf8',
    );
    const { config } = await loadConfig({ IDENO_CONFIG: file });
    expect(config.routing.conversation?.provider).toBe('demo');
  });

  it('applies env overrides for privacy mode and port', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'config.json');
    await fs.writeFile(file, JSON.stringify({ providers: { demo: { type: 'demo', model: 'x' } } }), 'utf8');
    const { config } = await loadConfig({ IDENO_CONFIG: file, IDENO_PRIVACY_MODE: 'LOCAL_ONLY', PORT: '9999' });
    expect(config.privacy_mode).toBe('LOCAL_ONLY');
    expect(config.server.port).toBe(9999);
  });
});

describe('redactConfig', () => {
  it('never exposes api keys or full URLs', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'config.json');
    await fs.writeFile(
      file,
      JSON.stringify({
        providers: {
          main: { type: 'openai_compatible', base_url: 'https://api.example.com/v1', model: 'gpt-4o-mini', api_key: 'sk-super-secret' },
        },
      }),
      'utf8',
    );
    const { config } = await loadConfig({ IDENO_CONFIG: file });
    const redacted = redactConfig(config);
    const json = JSON.stringify(redacted);
    expect(json).not.toContain('sk-super-secret');
    expect(json).not.toContain('api.example.com/v1');
    expect(redacted.providers[0]?.base_url_origin).toBe('https://api.example.com');
    expect(redacted.research_provider_configured).toBe(false);
  });
});

describe('privacy routing', () => {
  it('LOCAL_ONLY excludes cloud providers and errors clearly when only cloud exists', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'config.json');
    await fs.writeFile(
      file,
      JSON.stringify({
        privacy_mode: 'LOCAL_ONLY',
        providers: { cloudy: { type: 'openai_compatible', base_url: 'https://api.example.com/v1', model: 'm', privacy: 'cloud' } },
      }),
      'utf8',
    );
    const { config } = await loadConfig({ IDENO_CONFIG: file });
    const providers = buildProviders(config, {});
    expect(() => resolveRoute('conversation', 'LOCAL_ONLY', providers, config.routing)).toThrow(CapabilityError);

    // With a local provider present, LOCAL_ONLY routes to it.
    const file2 = path.join(dir, 'config2.json');
    await fs.writeFile(
      file2,
      JSON.stringify({
        privacy_mode: 'LOCAL_ONLY',
        providers: {
          cloudy: { type: 'openai_compatible', base_url: 'https://api.example.com/v1', model: 'm', privacy: 'cloud' },
          local: { type: 'openai_compatible', base_url: 'http://localhost:11434/v1', model: 'llama3.1', privacy: 'local' },
        },
      }),
      'utf8',
    );
    const config2 = (await loadConfig({ IDENO_CONFIG: file2 })).config;
    const providers2 = buildProviders(config2, {});
    const route = resolveRoute('conversation', 'LOCAL_ONLY', providers2, config2.routing);
    expect(route.provider.id).toBe('local');
  });
});
