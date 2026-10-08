import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { loadConfig, buildRuntime, redactConfig } from '../src/server/config/load.js';
import { Store } from '../src/server/persistence/store.js';
import { Orchestrator } from '../src/server/core/orchestration/orchestrator.js';
import { createApp } from '../src/server/api/routes.js';
import { NoResearchProvider } from '../src/server/research/interface.js';
import { systemClock } from '../src/server/util/clock.js';
import type { ChatEvent } from '../src/shared/chat.js';
import type { StoredProposal } from '../src/shared/schemas/proposal.js';
import type { IdeaCase, VersionRecord } from '../src/shared/schemas/ideaCase.js';

/**
 * END-TO-END TEST — the MVP workflow from the specification (§34), executed
 * against the REAL HTTP stack (express app, SSE streaming, persistence,
 * validation, versioning) using the scripted DEMO provider.
 *
 * IMPORTANT verification honesty note: the demo provider is a deterministic
 * scripted component, NOT an AI model. This test verifies the PIPELINE
 * (proposal → validation → review → apply → version → updated context), not
 * the quality of any real model's reasoning. Real-model behavior is not
 * verified here.
 */

let server: Server;
let baseUrl: string;
let dataDir: string;
let orchestrator: Orchestrator;

async function chat(message: string): Promise<{ status: number; events: ChatEvent[] }> {
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) {
    // Rejected before the stream started (e.g. empty message) — classified JSON error.
    const body = (await res.json()) as { code: string };
    return {
      status: res.status,
      events: [{ type: 'error', error: { code: body.code as never, message: '', recoverable: true } }],
    };
  }
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const text = await res.text();
  const events: ChatEvent[] = [];
  for (const block of text.split('\n\n')) {
    for (const line of block.split('\n')) {
      if (line.startsWith('data:')) {
        events.push(JSON.parse(line.slice(5).trim()) as ChatEvent);
      }
    }
  }
  return { status: res.status, events };
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`);
  expect(res.ok).toBe(true);
  return (await res.json()) as T;
}

async function post<T>(path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as T };
}

function lastProposal(events: ChatEvent[]): StoredProposal | undefined {
  for (const ev of [...events].reverse()) {
    if (ev.type === 'proposal') return ev.proposal;
  }
  return undefined;
}

async function acceptProposalOf(events: ChatEvent[]): Promise<{ case: IdeaCase; version: VersionRecord }> {
  const proposal = lastProposal(events);
  expect(proposal).toBeDefined();
  const { status, json } = await post<{ case: IdeaCase; version: VersionRecord }>(
    `/api/proposals/${proposal!.id}/accept`,
  );
  expect(status).toBe(200);
  return json;
}

async function currentCase(): Promise<IdeaCase> {
  return (await getJson<{ case: IdeaCase }>('/api/case')).case;
}

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ideno-e2e-'));
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ideno-e2e-cfg-'));
  const configFile = path.join(configDir, 'ideno.config.json');
  await fs.writeFile(
    configFile,
    JSON.stringify({
      data_dir: dataDir,
      privacy_mode: 'CLOUD_ALLOWED',
      providers: { demo: { type: 'demo', display_name: 'Scripted demo (not AI)', privacy: 'local', model: 'scripted-demo-v0' } },
      routing: { conversation: { provider: 'demo', fallbacks: [] } },
    }),
    'utf8',
  );
  const { config } = await loadConfig({ IDENO_CONFIG: configFile });
  const runtime = buildRuntime(config, {});
  const store = new Store(dataDir, systemClock);
  orchestrator = new Orchestrator(store, runtime, systemClock, config, new NoResearchProvider());
  await orchestrator.init();
  const app = createApp({
    orchestrator,
    runtime,
    baseConfig: config,
    redactedConfig: redactConfig(config),
    startupNotes: [],
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.on('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (dataDir) await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
});

describe('MVP success workflow (§34) — greenhouse scenario', () => {
  it('health endpoint reports the demo provider', async () => {
    const health = await getJson<{
      server: string;
      providers: Array<{ id: string; is_demo: boolean; health: { ok: boolean } }>;
    }>('/api/health');
    expect(health.server).toBe('ok');
    expect(health.providers[0]?.id).toBe('demo');
    expect(health.providers[0]?.is_demo).toBe(true);
    expect(health.providers[0]?.health.ok).toBe(true);
  });

  let events1: ChatEvent[];

  it('turn 1: structures the original idea and streams a reply', async () => {
    events1 = (await chat('I want to build a small autonomous greenhouse.')).events;
    const types = events1.map((e) => e.type);
    expect(types).toContain('status');
    expect(types).toContain('reply');
    expect(types).toContain('proposal');
    expect(types[types.length - 1]).toBe('done');

    const reply = events1.find((e) => e.type === 'reply');
    expect(reply && reply.type === 'reply' && reply.text).toContain('scripted demo provider');

    const proposal = lastProposal(events1)!;
    expect(proposal.status).toBe('pending');
    expect(proposal.proposal.original_idea).toBe('I want to build a small autonomous greenhouse.');
    expect(proposal.proposal.changes.goals.added.length).toBe(1);
    expect(proposal.proposal.questions.length).toBeGreaterThan(0);

    // State was NOT modified before acceptance (human authority).
    const c = await currentCase();
    expect(c.version).toBe(0);
    expect(c.goals).toHaveLength(0);
    expect(c.original_idea).toBe('');
  });

  it('accepting turn 1 creates v1 with the structured idea', async () => {
    const { version } = await acceptProposalOf(events1);
    expect(version.number).toBe(1);
    const c = await currentCase();
    expect(c.title).toBe('Build a small autonomous greenhouse');
    expect(c.original_idea).toContain('autonomous greenhouse');
    expect(c.goals).toHaveLength(1);
    expect(c.goals[0]?.knowledge_class).toBe('USER_PROVIDED');
    expect(c.assumptions).toHaveLength(2);
    expect(c.unknowns.length).toBeGreaterThanOrEqual(2);
  });

  let events2: ChatEvent[];

  it('turn 2: adds the balcony constraint with impact analysis', async () => {
    events2 = (await chat('It has to fit on a balcony.')).events;
    const proposal = lastProposal(events2)!;
    expect(proposal.proposal.changes.constraints.added.length).toBe(1);
    expect(proposal.proposal.changes.constraints.added[0]?.knowledge_class).toBe('USER_PROVIDED');
    expect(proposal.proposal.impact_analysis.length).toBeGreaterThan(0);
    expect(proposal.proposal.impact_analysis.map((i) => i.area)).toContain('Physical footprint');
    await acceptProposalOf(events2);
    const c = await currentCase();
    expect(c.version).toBe(2);
    expect(c.constraints).toHaveLength(1);
    expect(c.constraints[0]?.hard).toBe(true);
  });

  let events3: ChatEvent[];

  it('turn 3: the no-cloud constraint invalidates the cloud assumption (impact propagation)', async () => {
    events3 = (await chat("I don't want cloud connectivity.")).events;
    const proposal = lastProposal(events3)!;
    expect(proposal.proposal.changes.constraints.added.length).toBe(1);
    const invalidations = proposal.proposal.changes.assumptions.modified;
    expect(invalidations.length).toBe(1);
    expect(invalidations[0]?.id).toBe('asm2'); // "Cloud services ... are available"
    expect(invalidations[0]?.status).toBe('invalidated');
    expect(proposal.proposal.impact_analysis.map((i) => i.area)).toContain('Network architecture');

    await acceptProposalOf(events3);
    const c = await currentCase();
    expect(c.version).toBe(3);
    expect(c.constraints).toHaveLength(2);
    expect(c.assumptions.find((a) => a.id === 'asm2')?.status).toBe('invalidated');
    expect(c.assumptions.find((a) => a.id === 'asm1')?.status).toBe('active');
  });

  let events4: ChatEvent[];

  it('turn 4: generates alternatives', async () => {
    events4 = (await chat('Show me alternative architectures.')).events;
    const proposal = lastProposal(events4)!;
    const alts = proposal.proposal.changes.alternatives.added;
    expect(alts.length).toBe(3);
    expect(alts.every((a) => a.advantages.length > 0 && a.disadvantages.length > 0)).toBe(true);

    await acceptProposalOf(events4);
    const c = await currentCase();
    expect(c.alternatives).toHaveLength(3);
    expect(c.alternatives.every((a) => a.status === 'candidate')).toBe(true);
    expect(c.version).toBe(4);
  });

  let events5: ChatEvent[];

  it('turn 5: records the user decision and preserves rejected alternatives', async () => {
    events5 = (await chat("Let's use the second one.")).events;
    const proposal = lastProposal(events5)!;
    const decisions = proposal.proposal.changes.decisions.added ?? [];
    expect(decisions.length).toBe(1);
    expect(decisions[0]?.decision_maker).toBe('user');
    expect(decisions[0]?.basis).toBe('user_message');
    expect((decisions[0]?.alternatives_considered ?? []).length).toBe(3);

    await acceptProposalOf(events5);
    const c = await currentCase();
    expect(c.version).toBe(5);

    // The second alternative (B) is accepted; A and C are superseded but preserved.
    expect(c.alternatives.find((a) => a.name.startsWith('B'))?.status).toBe('accepted');
    expect(c.alternatives.find((a) => a.name.startsWith('A'))?.status).toBe('superseded');
    expect(c.alternatives.find((a) => a.name.startsWith('C'))?.status).toBe('superseded');
    expect(c.alternatives).toHaveLength(3);

    // Decision recorded with USER_DECIDED epistemic class.
    expect(c.decisions).toHaveLength(1);
    expect(c.decisions[0]?.knowledge_class).toBe('USER_DECIDED');
    expect(c.decisions[0]?.decision_maker).toBe('user');

    // Superseded alternatives are mirrored into rejected_approaches (never deleted).
    expect(c.rejected_approaches.length).toBe(2);
  });

  it('versions are inspectable with diffs', async () => {
    const versions = (await getJson<{ versions: Array<{ number: number; counts: { added: number } }> }>('/api/case')).versions;
    expect(versions.map((v) => v.number)).toEqual([0, 1, 2, 3, 4, 5]);
    const v5 = await getJson<{ version: VersionRecord }>('/api/versions/5');
    expect(v5.version.trigger.kind).toBe('user_acceptance');
    expect(v5.version.diff.collections.alternatives?.modified.length).toBe(3);
    expect(v5.version.diff.collections.decisions?.added.length).toBe(1);
    expect(v5.version.diff.collections.rejected_approaches?.added.length).toBe(2);
    // Snapshots enable future branching:
    expect(v5.version.snapshot.version).toBe(5);
  });

  it('rejection leaves state untouched and is recorded', async () => {
    const events = (await chat('It has to be cheap.')).events;
    const proposal = lastProposal(events)!;
    const before = await currentCase();
    const { status } = await post(`/api/proposals/${proposal.id}/reject`, { reason: 'not now' });
    expect(status).toBe(200);
    const after = await currentCase();
    expect(after.version).toBe(before.version);
    expect(after.constraints).toHaveLength(before.constraints.length);
    // Double-accept is a conflict:
    const again = await post(`/api/proposals/${proposal.id}/accept`);
    expect(again.status).toBeGreaterThanOrEqual(400);
  });

  it('empty messages are rejected with a classified error', async () => {
    const { status, events } = await chat('   ');
    expect(status).toBe(400);
    expect(events.some((e) => e.type === 'error' && e.error.code === 'BAD_REQUEST')).toBe(true);
  });

  it('messages and proposals survive a full reload (persistence round-trip)', async () => {
    const state = await getJson<{
      case: IdeaCase;
      messages: Array<{ role: string }>;
      proposals: StoredProposal[];
    }>('/api/case');
    expect(state.case.version).toBe(5);
    expect(state.messages.filter((m) => m.role === 'user').length).toBe(6);
    expect(state.proposals.length).toBe(6);
  });

  it('redacted config never contains secrets and flags demo mode', async () => {
    const config = await getJson<{ privacy_mode: string; providers: Array<{ is_demo: boolean }>; research_provider_configured: boolean }>('/api/config');
    expect(config.privacy_mode).toBe('CLOUD_ALLOWED');
    expect(config.providers[0]?.is_demo).toBe(true);
    expect(config.research_provider_configured).toBe(false);
    expect(JSON.stringify(config)).not.toContain('api_key');
  });

  it('research fails explicitly while no research provider is configured', async () => {
    const { status, json } = await post<{ code: string; message: string }>('/api/research', {
      question: 'What pump power do small greenhouses need?',
    });
    expect(status).toBe(502);
    expect(json.code).toBe('RESEARCH_UNAVAILABLE');
    expect(json.message).toContain('No research provider');
  });

  it('reset archives the case and starts fresh', async () => {
    const { status, json } = await post<{ case: IdeaCase }>('/api/case/reset');
    expect(status).toBe(200);
    expect(json.case.version).toBe(0);
    expect(json.case.title).toBe('Untitled idea');
    // Archive exists on disk.
    const archiveDir = path.join(dataDir, 'archive');
    const stamps = await fs.readdir(archiveDir);
    expect(stamps.length).toBeGreaterThan(0);
  });
});
