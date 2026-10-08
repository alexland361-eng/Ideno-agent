import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HttpResearchProvider, buildResearchProvider } from '../src/server/research/httpProvider.js';
import { NoResearchProvider } from '../src/server/research/interface.js';
import type { StoredProposal } from '../src/shared/schemas/proposal.js';

/**
 * Research provider tests. The HTTP round trip is REAL — a local node HTTP
 * server stands in for the external service (the sandbox cannot reach
 * api.tavily.com etc.). This verifies the provider's request/response
 * handling, source mapping, and error classification against the documented
 * API shapes; the external services themselves are NOT verified here.
 */

let mockServer: http.Server;
let mockUrl: string;

const TAVILY_BODY = {
  results: [
    {
      title: 'Balcony greenhouse solar sizing',
      url: 'https://example.com/solar-sizing',
      content: 'A 1 m² balcony greenhouse needs roughly 30–60 W of solar input depending on season and latitude; winter weeks are the binding constraint.',
      score: 0.93,
      published_date: '2025-04-02',
    },
    {
      title: 'No URL — must be dropped',
      url: 'not-a-url',
      content: 'irrelevant',
    },
    {
      title: 'Forum thread on winter yields',
      url: 'https://forum.example.com/t/42',
      content: 'Growers report usable winter yields with insulated glazing.',
    },
  ],
};

const SEARXNG_BODY = {
  results: [
    { title: 'Herb light requirements (documentation)', url: 'https://docs.example.org/herbs/light', content: 'Most culinary herbs need 6+ hours of direct light.', publishedDate: '2024-11-01' },
    { title: 'arXiv: urban agriculture survey', url: 'https://arxiv.org/abs/2401.00001', content: 'A survey of 120 balcony-growing studies.' },
  ],
};

beforeAll(async () => {
  mockServer = http.createServer((req, res) => {
    const url = req.url ?? '';
    if (url.startsWith('/tavily/search')) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = JSON.parse(body) as { api_key?: string; query?: string };
        if (parsed.api_key !== 'test-key') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end('{"detail":"invalid key"}');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(TAVILY_BODY));
      });
      return;
    }
    if (url.startsWith('/searxng/search')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(SEARXNG_BODY));
      return;
    }
    if (url.startsWith('/fail/search')) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end('{"detail":"upstream down"}');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  mockUrl = `http://127.0.0.1:${(mockServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => mockServer.close(() => resolve()));
});

describe('HttpResearchProvider', () => {
  it('maps Tavily responses to sourced results and drops unusable ones', async () => {
    process.env.TAVILY_TEST_KEY = 'test-key';
    const provider = new HttpResearchProvider({
      type: 'tavily',
      base_url: `${mockUrl}/tavily`,
      api_key_env: 'TAVILY_TEST_KEY',
    });
    const result = await provider.search({ question: 'solar sizing for balcony greenhouse', max_results: 5 });
    expect(result.sources).toHaveLength(2);
    const first = result.sources[0]!;
    expect(first.url).toBe('https://example.com/solar-sizing');
    expect(first.publication_date).toBe('2025-04-02');
    expect(first.excerpt).toContain('1 m²');
    expect(['web', 'documentation', 'paper', 'forum', 'other']).toContain(first.source_type);
    expect(result.sources.some((s) => s.url === 'not-a-url')).toBe(false);
    delete process.env.TAVILY_TEST_KEY;
  });

  it('maps SearXNG responses and classifies papers', async () => {
    const provider = new HttpResearchProvider({ type: 'searxng', base_url: `${mockUrl}/searxng` });
    const result = await provider.search({ question: 'herb light requirements' });
    expect(result.sources).toHaveLength(2);
    expect(result.sources.find((s) => s.url.includes('arxiv'))?.source_type).toBe('paper');
    expect(result.sources.find((s) => s.url.includes('docs.example'))?.source_type).toBe('documentation');
    expect(result.retrieved_at).toBeTruthy();
  });

  it('classifies provider errors as PROVIDER_UNAVAILABLE (recoverable)', async () => {
    const provider = new HttpResearchProvider({ type: 'searxng', base_url: `${mockUrl}/fail` });
    await expect(provider.search({ question: 'x' })).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      recoverable: true,
    });
  });

  it('fails with CONFIG_INVALID when the env key is missing', async () => {
    delete process.env.IDENO_MISSING_KEY_TEST;
    const provider = new HttpResearchProvider({
      type: 'tavily',
      base_url: `${mockUrl}/tavily`,
      api_key_env: 'IDENO_MISSING_KEY_TEST',
    });
    await expect(provider.search({ question: 'x' })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  it('buildResearchProvider falls back to the explicit NoResearchProvider', async () => {
    const p = buildResearchProvider(undefined);
    expect(p).toBeInstanceOf(NoResearchProvider);
    await expect(p.search({ question: 'x' })).rejects.toMatchObject({ code: 'RESEARCH_UNAVAILABLE' });
  });
});

describe('research → proposal flow (§17 + §27)', () => {
  it('creates a pending proposal recording the question; acceptance versions it', async () => {
    // Import lazily to reuse the app-construction style of the e2e suite.
    const { loadConfig, buildRuntime } = await import('../src/server/config/load.js');
    const { Store } = await import('../src/server/persistence/store.js');
    const { Orchestrator } = await import('../src/server/core/orchestration/orchestrator.js');
    const { systemClock } = await import('../src/server/util/clock.js');

    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ideno-research-'));
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ideno-research-cfg-'));
    await fs.writeFile(
      path.join(configDir, 'ideno.config.json'),
      JSON.stringify({
        data_dir: dataDir,
        providers: { demo: { type: 'demo', model: 'scripted-demo-v0', privacy: 'local' } },
        routing: { conversation: { provider: 'demo' } },
        research: { type: 'searxng', base_url: `${mockUrl}/searxng` },
      }),
    );
    process.env.IDENO_CONFIG = path.join(configDir, 'ideno.config.json');
    const { config } = await loadConfig();
    const runtime = buildRuntime(config);
    const store = new Store(dataDir, systemClock);
    const orchestrator = new Orchestrator(store, runtime, systemClock, config, buildResearchProvider(config.research));
    await orchestrator.init();

    const out = await orchestrator.proposeResearchFindings('How much light do herbs need?');
    const stored: StoredProposal = out.proposal;
    expect(stored.status).toBe('pending');
    expect(stored.provider).toBe('research-searxng');
    expect(stored.proposal.changes.research_items.added).toHaveLength(1);
    expect(stored.proposal.changes.research_items.added[0]!.question).toContain('light do herbs');
    // The reply lists the REAL sources (from the provider, not the model).
    expect(out.message.content).toContain('https://docs.example.org/herbs/light');
    expect(out.message.content).toContain('arxiv.org');

    // Acceptance versions the state — same channel as model proposals.
    const { caseData } = await orchestrator.acceptProposal(stored.id);
    expect(caseData.research_items).toHaveLength(1);
    expect(caseData.version).toBeGreaterThan(0);
    delete process.env.IDENO_CONFIG;
  });
});
