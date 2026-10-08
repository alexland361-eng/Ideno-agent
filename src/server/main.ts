import path from 'node:path';
import { readFileSync } from 'node:fs';
import { loadConfig, buildRuntime, redactConfig } from './config/load.js';
import { Store } from './persistence/store.js';
import { Orchestrator } from './core/orchestration/orchestrator.js';
import { createApp } from './api/routes.js';
import { systemClock } from './util/clock.js';
import { buildResearchProvider } from './research/httpProvider.js';
import { buildSupabaseClient } from './supabase/client.js';

/**
 * Ideno server entry point.
 *
 * Boot order: load + validate config → build runtime (providers from config)
 * → open persistence → initialize orchestrator (loads/repairs state) → serve
 * API + built UI. The research provider is intentionally absent in v0.1; the
 * system reports research as unavailable rather than faking it.
 */

/** Version from package.json (cwd when started via npm start / node dist). */
function serverVersion(): string {
  try {
    return JSON.parse(readFileSync('package.json', 'utf8')).version as string;
  } catch {
    return 'unknown';
  }
}

async function main() {
  const { config, notes } = await loadConfig();
  const runtime = buildRuntime(config);
  // Accounts + per-user settings. Missing env keys are a hard config error
  // when the supabase section is present — the server must not silently
  // pretend accounts exist. Null when the section is absent.
  const supabase = buildSupabaseClient(config.supabase);

  const dataDir = path.resolve(config.data_dir);
  const store = new Store(dataDir, systemClock);
  // Research is a separate concern from LLM inference (§17). When configured,
  // a real HTTP research provider serves sourced results; otherwise the
  // NoResearchProvider fails explicitly rather than faking research.
  const research = buildResearchProvider(config.research);
  const orchestrator = new Orchestrator(store, runtime, systemClock, config, research);
  const loadWarnings = await orchestrator.init();

  const webDistDir = await resolveWebDist();
  const app = createApp({
    orchestrator,
    runtime,
    redactedConfig: redactConfig(config),
    webDistDir,
    startupNotes: notes,
    allowedOrigins: config.server.allowed_origins,
    supabase,
    baseConfig: config,
  });

  const server = app.listen(config.server.port, config.server.host, () => {
    console.log(`Ideno v${serverVersion()} listening on http://${config.server.host}:${config.server.port}`);
    console.log(`Data directory: ${dataDir}`);
    console.log(`Privacy mode: ${config.privacy_mode}`);
    for (const note of notes) console.log(`Note: ${note}`);
    for (const warning of loadWarnings) console.log(`Warning: ${warning}`);
    const demoActive = Object.values(config.providers).some((p) => p.type === 'demo');
    if (demoActive) {
      console.log(
        '⚠ DEMO MODE: the scripted demo provider is active. It is NOT an AI model — configure a real provider in config/ideno.config.json (see config/ideno.config.example.json).',
      );
    }
  });

  const shutdown = (signal: string) => {
    console.log(`\n${signal} received; shutting down.`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

async function resolveWebDist(): Promise<string | undefined> {
  const candidates = [path.resolve('dist/web'), path.resolve('../dist/web')];
  for (const dir of candidates) {
    try {
      await fsAccess(path.join(dir, 'index.html'));
      return dir;
    } catch {
      // try next
    }
  }
  return undefined;
}

async function fsAccess(file: string): Promise<void> {
  const { access } = await import('node:fs/promises');
  await access(file);
}

main().catch((err) => {
  console.error('Ideno failed to start:', err instanceof Error ? `${err.name}: ${err.message}` : err);
  if (err && typeof err === 'object' && 'detail' in err && Array.isArray((err as { detail: unknown }).detail)) {
    for (const line of (err as { detail: string[] }).detail) console.error(`  - ${line}`);
  }
  process.exit(1);
});
