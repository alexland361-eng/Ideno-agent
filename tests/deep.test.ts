import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { loadConfig, buildRuntime } from '../src/server/config/load.js';
import { Store } from '../src/server/persistence/store.js';
import { Orchestrator } from '../src/server/core/orchestration/orchestrator.js';
import { createApp } from '../src/server/api/routes.js';
import { buildResearchProvider } from '../src/server/research/httpProvider.js';
import { systemClock } from '../src/server/util/clock.js';
import type { ChatEvent } from '../src/shared/chat.js';

/**
 * Deep-analysis (adversarial critique pass) tests, run against the real
 * orchestrator + demo provider. The demo critique is a deterministic
 * template — these tests verify the PIPELINE (second structured pass,
 * phase event, warning merge, StoredProposal.critique), not real critique
 * quality (no AI model is involved).
 */

let server: Server;
let baseUrl: string;
let orchestrator: Orchestrator;

async function chat(message: string, deep: boolean): Promise<ChatEvent[]> {
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, deep }),
  });
  expect(res.ok).toBe(true);
  const text = await res.text();
  const events: ChatEvent[] = [];
  for (const block of text.split('\n\n')) {
    for (const line of block.split('\n')) {
      if (line.startsWith('data:')) events.push(JSON.parse(line.slice(5).trim()) as ChatEvent);
    }
  }
  return events;
}

beforeAll(async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ideno-deep-'));
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ideno-deep-cfg-'));
  await fs.writeFile(
    path.join(configDir, 'ideno.config.json'),
    JSON.stringify({
      data_dir: dataDir,
      providers: { demo: { type: 'demo', model: 'scripted-demo-v0', privacy: 'local' } },
      routing: { conversation: { provider: 'demo' } },
    }),
  );
  process.env.IDENO_CONFIG = path.join(configDir, 'ideno.config.json');
  const { config } = await loadConfig();
  const runtime = buildRuntime(config);
  const store = new Store(dataDir, systemClock);
  orchestrator = new Orchestrator(store, runtime, systemClock, config, buildResearchProvider(config.research));
  await orchestrator.init();
  const app = createApp({
    orchestrator,
    runtime,
    redactedConfig: {
      privacy_mode: config.privacy_mode,
      providers: [],
      routing: {},
      research_provider_configured: false,
    },
    startupNotes: [],
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.IDENO_CONFIG;
});

describe('deep analysis mode', () => {
  it('runs a critique pass: critiquing phase, critique on the proposal, merged warnings', async () => {
    const events = await chat('I want to build a small balcony greenhouse for herbs.', true);
    const proposal = [...events].reverse().find((e) => e.type === 'proposal');
    expect(proposal).toBeDefined();
    if (proposal?.type !== 'proposal') return;

    expect(events.some((e) => e.type === 'status' && e.phase === 'critiquing')).toBe(true);
    expect(proposal.proposal.critique).toBeDefined();
    expect(proposal.proposal.critique!.issues.length).toBeGreaterThan(0);
    expect(proposal.proposal.critique!.summary).toContain('Scripted demo');
    // Critique findings are merged into the review-card warnings.
    expect(proposal.proposal.warnings.some((w) => w.startsWith('Critique ('))).toBe(true);
  });

  it('does not run the critique pass in normal mode', async () => {
    const events = await chat('It must fit on a balcony.', false);
    expect(events.some((e) => e.type === 'status' && e.phase === 'critiquing')).toBe(false);
    const proposal = [...events].reverse().find((e) => e.type === 'proposal');
    if (proposal?.type === 'proposal') {
      expect(proposal.proposal.critique).toBeUndefined();
      expect(proposal.proposal.warnings.every((w) => !w.startsWith('Critique'))).toBe(true);
    }
  });
});
