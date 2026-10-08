// @vitest-environment happy-dom
/**
 * UI TESTS — Ideno Liquid Glass interface (§60 of the UI spec).
 *
 * TEST DOUBLES: every network call is served by an in-memory mock of the
 * Ideno API defined at the bottom of this file (mockFetch). The SSE stream
 * is a hand-rolled Response-like object. These are explicitly mocks — passing
 * these tests verifies UI BEHAVIOR against the documented API contract, not
 * any real backend integration (which is covered separately by the node
 * end-to-end suite in tests/orchestrator.e2e.test.ts).
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from '../src/web/App';
import { resetApiModeCache } from '../src/web/api';
import { emptyCase, nextItemId } from '../src/shared/schemas/ideaCase.js';
import type { IdeaCase } from '../src/shared/schemas/ideaCase.js';
import type { StoredProposal } from '../src/shared/schemas/proposal.js';
import type { ChatEvent, ChatMessage } from '../src/shared/chat.js';
import type { CaseStateResponse, HealthResponse } from '../src/web/api';

/* ---------------------------------------------------------------------------
   Mock API state (mutable; tests drive it through the handlers below)
   ------------------------------------------------------------------------- */

let caseData: IdeaCase;
let versions: CaseStateResponse['versions'];
let proposals: StoredProposal[];
let messages: ChatMessage[];
let chatEvents: ChatEvent[] | null;
let acceptCalls: string[] = [];
let rejectCalls: string[] = [];

function freshState() {
  caseData = emptyCase('primary', '2026-10-08T00:00:00Z');
  caseData.title = 'Untitled idea';
  versions = [{ number: 0, id: 'ver0', created_at: '2026-10-08T00:00:00Z', summary: 'Initial empty state.', trigger: { kind: 'initialization' }, counts: { added: 0, modified: 0 } }];
  proposals = [];
  messages = [];
  chatEvents = null;
  acceptCalls = [];
  rejectCalls = [];
}

function populatedState() {
  freshState();
  caseData.title = 'Balcony greenhouse';
  caseData.original_idea = 'I want to build a small autonomous greenhouse.';
  caseData.version = 1;
  caseData.constraints.push({
    id: nextItemId(caseData, 'constraints'),
    text: 'Must fit on a balcony',
    knowledge_class: 'USER_PROVIDED',
    status: 'active',
    created_at: '2026-10-08T01:00:00Z',
    updated_at: '2026-10-08T01:00:00Z',
    provenance: { source: 'user' },
    hard: true,
  });
  caseData.decisions.push({
    id: nextItemId(caseData, 'decisions'),
    decision: 'Use solar power',
    reason: 'user picked it',
    basis: 'user_message',
    decision_maker: 'user',
    affected_ids: ['cst1'],
    alternatives_considered: [],
    evidence_ids: [],
    knowledge_class: 'USER_DECIDED',
    status: 'active',
    created_at: '2026-10-08T01:00:00Z',
    updated_at: '2026-10-08T01:00:00Z',
    provenance: { source: 'user' },
  });
  versions.push({
    number: 1,
    id: 'ver1',
    created_at: '2026-10-08T01:00:00Z',
    summary: 'Added balcony constraint.',
    trigger: { kind: 'user_acceptance', user_message: 'It has to fit on a balcony.' },
    counts: { added: 1, modified: 0 },
  });
}

const HEALTH: HealthResponse = {
  server: 'ok',
  providers: [
    {
      id: 'demo',
      display_name: 'DEMO — scripted (not AI): demo',
      model: 'scripted-demo-v0',
      privacy: 'local',
      is_demo: true,
      health: { ok: true, detail: 'Scripted demo provider is always available.' },
    },
  ],
  routing: [{ providerId: 'demo', eligible: true, reasons: [] }],
};

const CONFIG = {
  privacy_mode: 'CLOUD_ALLOWED',
  providers: [
    {
      id: 'demo',
      type: 'demo',
      display_name: 'Scripted demo (not AI)',
      model: 'scripted-demo-v0',
      privacy: 'local' as const,
      is_demo: true,
      capabilities: { structured_output: 'json_schema' as const, streaming: true },
    },
  ],
  routing: { conversation: { provider: 'demo', fallbacks: [] } },
  research_provider_configured: false,
  startup_notes: [],
};

const jsonBody = (data: unknown) => ({
  ok: true,
  status: 200,
  headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? 'application/json' : null) },
  json: async () => data,
});

function sseBody(events: ChatEvent[]) {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  const encoder = new TextEncoder();
  let sent = false;
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'text/event-stream' : null) },
    body: {
      getReader() {
        return {
          read: async () => {
            if (sent) return { done: true as const, value: undefined };
            sent = true;
            return { done: false as const, value: encoder.encode(text) };
          },
        };
      },
    },
  };
}

const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input.toString();
  const method = init?.method ?? 'GET';

  if (url === '/api/case' && method === 'GET') {
    return jsonBody({ case: caseData, versions, proposals, messages, load_warnings: [] });
  }
  if (url === '/api/config') return jsonBody(CONFIG);
  if (url === '/api/health') return jsonBody(HEALTH);
  if (url.startsWith('/api/versions/')) {
    return jsonBody({
      version: {
        number: 1,
        id: 'ver1',
        parent_version: 0,
        created_at: '2026-10-08T01:00:00Z',
        trigger: { kind: 'user_acceptance', user_message: 'It has to fit on a balcony.' },
        summary: 'Added balcony constraint.',
        diff: {
          collections: {
            constraints: { added: [{ id: 'cst1', text: 'Must fit on a balcony' }], modified: [] },
          },
          warnings: [],
        },
        snapshot: caseData,
      },
    });
  }
  if (url === '/api/chat' && method === 'POST') {
    const body = JSON.parse(String(init?.body ?? '{}')) as { message: string };
    // The mock advances the conversation like the real backend would — unless
    // the test pre-loaded a custom event script (e.g. the error-path test).
    messages = [
      ...messages,
      { id: `msg-u${messages.length}`, role: 'user', content: body.message, created_at: '2026-10-08T02:00:00Z' },
    ];
    if (chatEvents) return sseBody(chatEvents);
    const emptySet = { added: [] as never[], modified: [] as never[] };
    const proposal: StoredProposal = {
      id: 'prop_test1',
      status: 'pending',
      created_at: '2026-10-08T02:00:00Z',
      user_message: body.message,
      provider: 'demo/scripted-demo-v0',
      warnings: [],
      proposal: {
        changes: {
          goals: emptySet,
          requirements: emptySet,
          assumptions: emptySet,
          constraints: { added: [{ text: 'Must fit on a balcony', knowledge_class: 'USER_PROVIDED', hard: true }], modified: [] },
          unknowns: emptySet,
          risks: emptySet,
          dependencies: emptySet,
          evidence: emptySet,
          research_items: emptySet,
          alternatives: emptySet,
          decisions: emptySet,
          rejected_approaches: emptySet,
          open_questions: emptySet,
        },
        impact_analysis: [{ area: 'Physical footprint', effect: 'Must be reconsidered.', reason: 'Balcony.' }],
        conflicts: [],
        questions: [],
        reasoning_summary: 'test summary',
      },
    };
    proposals = [...proposals, proposal];
    messages = [
      ...messages,
      { id: `msg-a${messages.length}`, role: 'assistant', content: 'Understood — I recorded that as a constraint.', created_at: '2026-10-08T02:00:01Z', proposal_id: proposal.id },
    ];
    return sseBody([
      { type: 'status', phase: 'routing' },
      { type: 'token', text: 'Understood' },
      { type: 'reply', text: 'Understood — I recorded that as a constraint.' },
      { type: 'proposal', proposal },
      { type: 'done', message_id: 'msg-a1', proposal_id: proposal.id },
    ]);
  }
  const acceptMatch = /^\/api\/proposals\/([\w-]+)\/accept$/.exec(url);
  if (acceptMatch && method === 'POST') {
    acceptCalls.push(acceptMatch[1]!);
    const stored = proposals.find((p) => p.id === acceptMatch[1]);
    if (stored) {
      stored.status = 'accepted';
      stored.resulting_version = caseData.version + 1;
      caseData.version += 1;
      for (const add of stored.proposal.changes.constraints?.added ?? []) {
        caseData.constraints.push({
          id: nextItemId(caseData, 'constraints'),
          text: add.text,
          knowledge_class: 'USER_PROVIDED',
          status: 'active',
          created_at: '2026-10-08T02:00:02Z',
          updated_at: '2026-10-08T02:00:02Z',
          provenance: { source: 'model' },
          hard: true,
        });
      }
    }
    return jsonBody({ case: caseData, version: { number: caseData.version, summary: 'test', created_at: '2026-10-08T02:00:02Z' } });
  }
  const rejectMatch = /^\/api\/proposals\/([\w-]+)\/reject$/.exec(url);
  if (rejectMatch && method === 'POST') {
    rejectCalls.push(rejectMatch[1]!);
    const stored = proposals.find((p) => p.id === rejectMatch[1]);
    if (stored) stored.status = 'rejected';
    return jsonBody(stored);
  }
  if (url === '/api/research' && method === 'POST') {
    return jsonBody({
      query: { question: JSON.parse(String(init?.body ?? '{}')).question },
      sources: [
        {
          title: 'Balcony greenhouse light requirements',
          url: 'https://docs.example.org/herbs/light',
          source_type: 'documentation',
          excerpt: 'Most culinary herbs need 6+ hours of direct light.',
          publication_date: '2024-11-01',
        },
      ],
      retrieved_at: '2026-10-08T10:00:00Z',
    });
  }
  if (url === '/api/research/propose' && method === 'POST') {
    return jsonBody({ message: { id: 'msg-r1', role: 'assistant', content: 'research', created_at: 't' }, proposal: proposals[0] ?? null });
  }
  if (url === '/api/case/reset' && method === 'POST') {
    freshState();
    return jsonBody({ case: caseData, versions, proposals, messages, load_warnings: [] });
  }
  return jsonBody({ code: 'BAD_REQUEST', message: `Unhandled: ${method} ${url}` });
});

/**
 * happy-dom's viewport is 1024px wide, which would trip the ≤1180px
 * narrow-mode recomposition and hide the state pane behind its overlay.
 * These tests exercise the desktop spatial layout (§33); the narrow-mode
 * overlay is covered by the recomposition logic itself.
 */
function stubDesktopMedia() {
  vi.stubGlobal('matchMedia', (query: string) => ({
    media: query,
    matches: false,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
}

beforeEach(() => {
  freshState();
  localStorage.clear();
  resetApiModeCache();
  stubDesktopMedia();
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/* ---------------------------------------------------------------------------
   Tests
   ------------------------------------------------------------------------- */

describe('Ideno UI', () => {
  it('renders the workspace empty state and demo runtime status', async () => {
    render(<App />);
    // Empty state (§38)
    expect(await screen.findByText('No idea yet.')).toBeDefined();
    expect(screen.getByText('Start anywhere.')).toBeDefined();
    // Runtime status is real data from /api/health (demo provider labeled)
    expect(await screen.findByText('DEMO')).toBeDefined();
    // Demo banner is honest about the scripted provider
    expect(screen.getByText(/not an AI model/i)).toBeDefined();
  });

  it('navigates between views with the rail', async () => {
    populatedState();
    render(<App />);
    await screen.findByText('Balcony greenhouse', { selector: '.topbar-title' });
    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    expect(await screen.findByText('Evolution')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(await screen.findByText('Appearance')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Research' }));
    expect(await screen.findByText(/No research provider is configured/i)).toBeDefined();
  });

  it('submits a message, streams the reply, and shows the proposal for review', async () => {
    render(<App />);
    await screen.findByText('No idea yet.');
    const composer = screen.getByRole('textbox', { name: 'Message to Ideno' });
    fireEvent.change(composer, { target: { value: 'It has to fit on a balcony.' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    // The streamed reply renders.
    expect(await screen.findByText(/recorded that as a constraint/i)).toBeDefined();
    // The proposal card appears with pending status and review actions.
    expect(await screen.findByText('Proposed changes')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Accept' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeDefined();
    // /api/chat was called with the message body.
    const chatCall = mockFetch.mock.calls.find((c) => String(c[0]) === '/api/chat');
    expect(chatCall).toBeDefined();
    expect(String(chatCall![1]?.body)).toContain('It has to fit on a balcony.');
  });

  it('accepting a proposal updates the Idea State and records the version', async () => {
    render(<App />);
    await screen.findByText('No idea yet.');
    const composer = screen.getByRole('textbox', { name: 'Message to Ideno' });
    fireEvent.change(composer, { target: { value: 'It has to fit on a balcony.' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    await screen.findByText('Proposed changes');
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));

    await waitFor(() => expect(acceptCalls).toContain('prop_test1'));
    // State panel reflects the new constraint (the proposal card shows the
    // same text, so scope to the state panel's item rows).
    expect(await screen.findByText('Must fit on a balcony', { selector: '.sp-item-text' })).toBeDefined();
    // Both the topbar chip and the Idea State chip advance to v1.
    expect((await screen.findAllByText('v1', { selector: '.version-chip' })).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/Accepted — version 1/)).toBeDefined();
  });

  it('rejecting a proposal leaves the state untouched and marks the card', async () => {
    render(<App />);
    await screen.findByText('No idea yet.');
    const composer = screen.getByRole('textbox', { name: 'Message to Ideno' });
    fireEvent.change(composer, { target: { value: 'It has to fit on a balcony.' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    await screen.findByText('Proposed changes');
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));

    await waitFor(() => expect(rejectCalls).toContain('prop_test1'));
    await waitFor(() =>
      expect(screen.getByText(/Rejected — state unchanged|Change rejected/i)).toBeDefined(),
    );
    // No constraint was added.
    expect(screen.queryByText('Must fit on a balcony', { selector: '.sp-item-text' })).toBeNull();
    expect(screen.queryByText('v1')).toBeNull();
  });

  it('renders Idea State sections and opens the item detail sheet', async () => {
    populatedState();
    render(<App />);
    // Sections with counts (§12)
    expect(await screen.findByText('Constraints')).toBeDefined();
    expect(screen.getByText('Decisions')).toBeDefined();
    // Clicking an item opens the inspector sheet (§47)
    fireEvent.click(screen.getByText('Must fit on a balcony'));
    expect(await screen.findByText('Knowledge class')).toBeDefined();
    expect(screen.getAllByText('user', { selector: '.kbadge' }).length).toBeGreaterThanOrEqual(1);
    // Related decision is linked from the sheet (not just the state pane copy).
    expect(screen.getAllByText('Use solar power', { selector: '.related-text' }).length).toBe(1);
  });

  it('shows the version timeline and reveals the diff', async () => {
    populatedState();
    render(<App />);
    await screen.findByText('Balcony greenhouse', { selector: '.topbar-title' });
    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    expect(await screen.findByText('v1', { selector: '.tl-version' })).toBeDefined();
    expect(screen.getByText('v0', { selector: '.tl-version' })).toBeDefined();
    fireEvent.click(screen.getByText('Added balcony constraint.'));
    expect(await screen.findByText(/component(s)? affected/)).toBeDefined();
    expect(screen.getByText('Must fit on a balcony', { selector: '.diff-line *, .diff-line' })).toBeDefined();
  });

  it('opens the command palette with ⌘K and navigates via keyboard', async () => {
    populatedState();
    render(<App />);
    await screen.findByText('Balcony greenhouse', { selector: '.topbar-title' });
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    const input = await screen.findByRole('combobox', { name: /command palette input/i });
    fireEvent.change(input, { target: { value: 'history' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByText('Evolution')).toBeDefined();
  });

  it('searches the Idea State from the palette and opens the detail sheet', async () => {
    populatedState();
    render(<App />);
    await screen.findByText('Balcony greenhouse', { selector: '.topbar-title' });
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    const input = await screen.findByRole('combobox', { name: /command palette input/i });
    fireEvent.change(input, { target: { value: 'balcony' } });
    const option = await screen.findByRole('option', { name: /must fit on a balcony/i });
    fireEvent.click(option);
    expect(await screen.findByText('Knowledge class')).toBeDefined();
  });

  it('cycles appearance and updates the document theme', async () => {
    render(<App />);
    await screen.findByText('No idea yet.');
    const toggle = screen.getByRole('button', { name: /Appearance: system/i });
    // Stored default is 'system'; the cycle is light → dark → system.
    fireEvent.click(toggle);
    await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('light'));
    fireEvent.click(screen.getByRole('button', { name: /Appearance: light/i }));
    await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('dark'));
    expect(localStorage.getItem('ideno.appearance')).toBe('dark');
  });

  it('renders a classified error card when the turn fails', async () => {
    chatEvents = [
      { type: 'status', phase: 'routing' } as ChatEvent,
      {
        type: 'error',
        error: {
          code: 'PROVIDER_UNAVAILABLE',
          message: 'Could not reach provider demo.',
          detail: ['Check that the endpoint is running.'],
          recoverable: true,
        },
      },
    ] as ChatEvent[];
    render(<App />);
    await screen.findByText('No idea yet.');
    const composer = screen.getByRole('textbox', { name: 'Message to Ideno' });
    fireEvent.change(composer, { target: { value: 'hello' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    expect(await screen.findByText('provider unavailable')).toBeDefined();
    expect(screen.getByText(/Could not reach provider demo/i)).toBeDefined();
    expect(screen.getByText(/try sending the message again/i)).toBeDefined();
  });

  it('sends the deep-analysis flag when the Deep toggle is on', async () => {
    render(<App />);
    await screen.findByText('No idea yet.');
    fireEvent.click(screen.getByRole('button', { name: /deep analysis|deep/i }));
    const composer = screen.getByRole('textbox', { name: 'Message to Ideno' });
    fireEvent.change(composer, { target: { value: 'hello' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    await waitFor(() => {
      const chatCall = mockFetch.mock.calls.find((c) => String(c[0]) === '/api/chat');
      expect(chatCall).toBeDefined();
      expect(String(chatCall![1]?.body)).toContain('"deep":true');
    });
  });

  it('renders the constellation view with an interactive canvas', async () => {
    populatedState();
    render(<App />);
    await screen.findByText('Balcony greenhouse', { selector: '.topbar-title' });
    fireEvent.click(screen.getByRole('button', { name: 'Map' }));
    const canvas = await screen.findByRole('application');
    expect(canvas.getAttribute('aria-label')).toContain('2 items');
    expect(canvas.getAttribute('aria-label')).toContain('1 relations');
  });

  it('research view: configured provider shows sourced results and propose action', async () => {
    (CONFIG as { research_provider_configured: boolean }).research_provider_configured = true;
    render(<App />);
    await screen.findByText('No idea yet.');
    fireEvent.click(screen.getByRole('button', { name: 'Research' }));
    const input = screen.getByRole('textbox', { name: 'Research question' });
    fireEvent.change(input, { target: { value: 'How much light do herbs need?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('Balcony greenhouse light requirements')).toBeDefined();
    expect(
      screen.getByRole('link', { name: 'Balcony greenhouse light requirements' }).getAttribute('href'),
    ).toBe('https://docs.example.org/herbs/light');
    expect(screen.getByRole('button', { name: /Propose recording in Idea State/i })).toBeDefined();
    expect(screen.getByText(/A research provider is configured/i)).toBeDefined();
    (CONFIG as { research_provider_configured: boolean }).research_provider_configured = false;
  });

  it('boots into the labeled offline demo when no server is reachable', async () => {
    // Everything 404s: static hosting (GitHub Pages) with no backend.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404, json: async () => null }) as unknown as Response),
    );
    render(<App />);
    // Honest offline banner + the demo's empty state — no fetches succeed.
    expect(await screen.findByTestId('offline-banner')).toBeDefined();
    expect(screen.getByText(/Offline demo/i)).toBeDefined();
    expect(screen.getByText('No idea yet.')).toBeDefined();
    // Settings shows the connection card.
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(await screen.findByTestId('connection-card')).toBeDefined();
    expect(screen.getByText(/Offline demo \(no server\)/i)).toBeDefined();
  });

  it('rejects SPA-fallback hosts: 200 + HTML is not a backend (offline demo boots)', async () => {
    // Netlify/Cloudflare-style SPA fallback: every path returns 200 with index.html.
    const htmlBody = '<!doctype html><html><body>fallback</body></html>';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? 'text/html' : null) },
        json: async () => { throw new Error('not JSON'); },
        text: async () => htmlBody,
      }) as unknown as Response),
    );
    render(<App />);
    expect(await screen.findByTestId('offline-banner')).toBeDefined();
    expect(screen.getByText('No idea yet.')).toBeDefined();
  });

  it('confirms before starting a new idea and resets the state', async () => {
    populatedState();
    render(<App />);
    await screen.findByText('Balcony greenhouse', { selector: '.topbar-title' });
    fireEvent.click(screen.getByRole('button', { name: 'New idea' }));
    // Confirmation sheet (§37) — not an immediate destructive action.
    expect(await screen.findByText('Start a new idea?')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Start new idea' }));
    await waitFor(() => expect(mockFetch.mock.calls.some((c) => String(c[0]) === '/api/case/reset')).toBe(true));
    expect(await screen.findByText('No idea yet.')).toBeDefined();
  });
});
