/**
 * OFFLINE DEMO BACKEND (browser-only, clearly labeled everywhere).
 *
 * When the UI is deployed statically (e.g. GitHub Pages) there is no Ideno
 * server to talk to. Instead of showing a dead error screen — and instead of
 * FAKING a server — this module runs the REAL core state machine in the
 * browser: the same semanticValidation and applyProposal the server uses
 * (both are pure modules, imported from src/server/core/state). Chat replies
 * come from a compact scripted demo (like the server's demo provider, NOT an
 * AI model) and are labeled as such.
 *
 * Honesty contract (§57):
 *  - The UI shows an OFFLINE DEMO banner: no server, nothing persisted,
 *    everything resets on reload.
 *  - Health/config report a demo provider with is_demo: true.
 *  - Research throws the same RESEARCH_UNAVAILABLE error as the server
 *    (research is NEVER faked).
 *  - Acceptance still runs validation + versioning — the demo pipeline is
 *    the real pipeline.
 */

import { emptyCase, nextItemId } from '../shared/schemas/ideaCase.js';
import type { IdeaCase, VersionRecord } from '../shared/schemas/ideaCase.js';
import type { StoredProposal, Proposal, OrchestratorEnvelope, CritiqueResult } from '../shared/schemas/proposal.js';
import type { ChatMessage, ChatEvent } from '../shared/chat.js';
import { validateProposal } from '../server/core/state/semanticValidation.js';
import { applyProposal } from '../server/core/state/stateManager.js';
import { prefixedId } from '../server/util/ids.js';
import type { CaseStateResponse, HealthResponse, ResearchResponse } from './api.js';
import type { RedactedConfig } from '../shared/config.js';

const DEMO_BANNER = '(scripted offline demo — not an AI model, no server)';

interface DemoState {
  caseData: IdeaCase;
  versions: VersionRecord[];
  proposals: StoredProposal[];
  messages: ChatMessage[];
}

function freshState(): DemoState {
  const caseData = emptyCase('demo', new Date().toISOString());
  const v0: VersionRecord = {
    number: 0,
    id: 'ver_demo0',
    parent_version: null,
    created_at: new Date().toISOString(),
    trigger: { kind: 'initialization' },
    summary: 'Initial empty state.',
    diff: { collections: {}, warnings: [] },
    snapshot: caseData,
  };
  return { caseData, versions: [v0], proposals: [], messages: [] };
}

let state: DemoState = freshState();

function nowIso(): string {
  return new Date().toISOString();
}

function systemNotice(content: string): ChatMessage {
  return { id: prefixedId('msg'), role: 'system', content, created_at: nowIso() };
}

function emptyChanges(): Proposal['changes'] {
  const e = () => ({ added: [], modified: [] });
  return {
    goals: e(), requirements: e(), assumptions: e(), constraints: e(), unknowns: e(),
    risks: e(), dependencies: e(), evidence: e(), research_items: e(), alternatives: e(),
    decisions: e(), rejected_approaches: e(), open_questions: e(),
  } as unknown as Proposal['changes'];
}

/* ---------------------------------------------------------------------------
   Scripted demo envelopes (compact port of the server demo provider)
   ------------------------------------------------------------------------- */

function titleFromIdea(message: string): string {
  const words = message.replace(/\s+/g, ' ').trim().split(' ');
  const title = words.slice(0, 8).join(' ').replace(/[.!,]+$/, '');
  return title || 'New idea';
}

function initialEnvelope(userMessage: string): OrchestratorEnvelope {
  const title = titleFromIdea(userMessage);
  const changes = emptyChanges();
  changes.goals.added.push({
    text: `Deliver: ${title.toLowerCase()}`,
    knowledge_class: 'USER_PROVIDED',
    success_criteria: 'The user considers the idea well-defined enough to start building.',
  });
  changes.assumptions.added.push({
    text: 'The idea is at an early exploration stage; scope is still fluid.',
    knowledge_class: 'ASSUMED',
  });
  changes.unknowns.added.push({
    text: 'What does the user consider the first concrete milestone?',
    knowledge_class: 'UNKNOWN',
    priority: 'medium',
  });
  changes.open_questions.added.push({ text: 'What is the smallest first version that would be useful?', asked_to: 'user' });
  const proposal: Proposal = {
    title,
    original_idea: userMessage,
    current_intent: userMessage.trim(),
    changes,
    impact_analysis: [{ area: 'Structure', effect: 'Creates the initial idea structure.', reason: 'First message.' }],
    conflicts: [],
    questions: ['What does the first useful version look like to you?'],
    reasoning_summary: 'Scripted offline demo rules (deterministic template, not AI reasoning).',
    confidence: { overall: 0.75 },
  };
  return {
    reply: `${DEMO_BANNER}\nI've captured the idea and drafted the initial structure: a goal, one assumption, and the first unknown. Review the proposal — accepting it creates version 1 of your Idea State.`,
    proposal,
  };
}

function constraintEnvelope(userMessage: string): OrchestratorEnvelope {
  const m = /(must|should|has to|needs to|cannot|can't|only)\b[^.;]{2,70}/i.exec(userMessage);
  const text = (m ? m[0] : userMessage.slice(0, 80)).replace(/\s+/g, ' ').trim();
  const changes = emptyChanges();
  changes.constraints.added.push({ text, knowledge_class: 'USER_PROVIDED', hard: true });
  const proposal: Proposal = {
    changes,
    impact_analysis: [{ area: 'Feasibility', effect: 'This constraint narrows the solution space.', reason: 'New hard constraint from the user.' }],
    conflicts: [],
    questions: [],
    reasoning_summary: 'Scripted offline demo rules (deterministic template, not AI reasoning).',
    confidence: { overall: 0.8 },
  };
  return {
    reply: `${DEMO_BANNER}\nRecorded as a hard constraint: “${text}”. Review it in the proposal card.`,
    proposal,
  };
}

function alternativesEnvelope(userMessage: string): OrchestratorEnvelope {
  const changes = emptyChanges();
  changes.alternatives.added.push({
    name: 'Option A — simplest possible version',
    description: 'Cut scope to the minimum that still delivers the core goal.',
    advantages: ['Fastest to a working result'],
    disadvantages: ['May require rework later'],
    requirements: [],
    risks: [],
    dependencies: [],
  });
  changes.alternatives.added.push({
    name: 'Option B — modular version',
    description: 'Build the core first, with extension points for the rest later.',
    advantages: ['Grows with the idea'],
    disadvantages: ['More upfront design'],
    requirements: [],
    risks: [],
    dependencies: [],
  });
  const proposal: Proposal = {
    changes,
    impact_analysis: [{ area: 'Planning', effect: 'Two alternatives to compare before deciding.', reason: 'User asked for options.' }],
    conflicts: [],
    questions: ['Which direction fits your constraints better?'],
    reasoning_summary: 'Scripted offline demo rules (deterministic template, not AI reasoning).',
    confidence: { overall: 0.7 },
  };
  return {
    reply: `${DEMO_BANNER}\nHere are two scripted alternatives. Accepting the proposal adds them to the state as alternatives to compare.`,
    proposal,
  };
}

function selectionEnvelope(userMessage: string): OrchestratorEnvelope {
  const changes = emptyChanges();
  changes.decisions.added.push({
    decision: titleFromIdea(userMessage),
    reason: 'Selected by the user in conversation.',
    basis: 'user_message',
    decision_maker: 'user',
    affected_ids: [],
  });
  const proposal: Proposal = {
    changes,
    impact_analysis: [{ area: 'Direction', effect: 'Records the user decision in the state.', reason: 'Explicit selection.' }],
    conflicts: [],
    questions: [],
    reasoning_summary: 'Scripted offline demo rules (deterministic template, not AI reasoning).',
    confidence: { overall: 0.85 },
  };
  return {
    reply: `${DEMO_BANNER}\nRecorded as your decision (maker: user). Review and accept to version it.`,
    proposal,
  };
}

function genericEnvelope(): OrchestratorEnvelope {
  return {
    reply: `${DEMO_BANNER}\nNoted. The offline demo only scripts a few flows — describe a new idea, state a constraint ("it must …"), ask for alternatives, or make a selection. Everything else needs a real model behind a running Ideno server.`,
  };
}

function demoCritique(userMessage: string): CritiqueResult {
  return {
    issues: [
      {
        severity: 'low',
        area: 'offline demo',
        description:
          'The offline demo cannot adversarially review anything — this critique is a labeled placeholder. A real deep-analysis pass requires a running server with a model.',
      },
    ],
    missing_considerations: [],
    questions: [`Demo: double-check this change related to "${userMessage.slice(0, 50)}" yourself.`],
    summary: 'Scripted offline demo critique (deterministic template, not AI reasoning).',
  };
}

/* ---------------------------------------------------------------------------
   Demo API surface (mirrors the server routes)
   ------------------------------------------------------------------------- */

export const demoBackend = {
  getConfig(): RedactedConfig & { startup_notes: string[] } {
    return {
      privacy_mode: 'LOCAL_ONLY',
      providers: [
        {
          id: 'offline-demo',
          type: 'demo',
          display_name: 'OFFLINE DEMO — scripted, runs in your browser',
          model: 'browser-demo-v0',
          privacy: 'local',
          is_demo: true,
          capabilities: { structured_output: 'json_schema', streaming: true },
        },
      ],
      routing: { conversation: { provider: 'offline-demo', fallbacks: [] } },
      research_provider_configured: false,
      startup_notes: [
        'Offline demo: no server connected. The state machine runs in your browser tab; nothing is persisted and everything resets on reload.',
      ],
    };
  },

  getHealth(): HealthResponse {
    return {
      server: 'ok',
      providers: [
        {
          id: 'offline-demo',
          display_name: 'OFFLINE DEMO — scripted (not AI): browser',
          model: 'browser-demo-v0',
          privacy: 'local',
          is_demo: true,
          health: { ok: true, detail: 'Offline demo provider (scripted, in-browser). No server, no persistence.' },
        },
      ],
      routing: [{ providerId: 'offline-demo', eligible: true, reasons: [] }],
    };
  },

  getCaseState(): CaseStateResponse {
    return {
      case: state.caseData,
      versions: state.versions.map(summaryOf),
      proposals: state.proposals,
      messages: state.messages,
      load_warnings: [],
    };
  },

  getVersion(n: number): { version: VersionRecord } {
    const version = state.versions.find((v) => v.number === n);
    if (!version) {
      throw { code: 'NOT_FOUND', message: `Version ${n} does not exist in the offline demo state.` };
    }
    return { version };
  },

  async acceptProposal(id: string): Promise<{ case: IdeaCase; version: VersionRecord }> {
    const stored = state.proposals.find((p) => p.id === id);
    if (!stored) throw { code: 'NOT_FOUND', message: `Proposal '${id}' not found.` };
    if (stored.status !== 'pending') {
      throw { code: 'STATE_CONFLICT', message: `Proposal '${id}' was already ${stored.status}.`, recoverable: true };
    }
    const validation = validateProposal(state.caseData, stored.proposal);
    if (validation.errors.length > 0) {
      throw { code: 'PROPOSAL_INVALID', message: 'The proposal no longer applies to the current state.', detail: validation.errors };
    }
    const { nextCase, version } = applyProposal(state.caseData, stored, validation, {
      now: nowIso(),
      providerLabel: stored.provider,
    });
    state.versions.push(version);
    state.caseData = nextCase;
    stored.status = 'accepted';
    stored.resolved_at = nowIso();
    stored.resulting_version = version.number;
    state.messages.push(systemNotice(`Change proposal accepted → version v${version.number}. ${version.summary}`));
    return { case: nextCase, version };
  },

  async rejectProposal(id: string, reason?: string): Promise<StoredProposal> {
    const stored = state.proposals.find((p) => p.id === id);
    if (!stored) throw { code: 'NOT_FOUND', message: `Proposal '${id}' not found.` };
    if (stored.status === 'pending') {
      stored.status = 'rejected';
      stored.resolved_at = nowIso();
      stored.rejection_reason = reason;
      state.messages.push(systemNotice('Change proposal rejected — state unchanged.'));
    }
    return stored;
  },

  resetCase(): CaseStateResponse {
    state = freshState();
    return demoBackend.getCaseState();
  },

  async researchSearch(): Promise<ResearchResponse> {
    // Research is NEVER faked — same classified error the server returns.
    throw {
      code: 'RESEARCH_UNAVAILABLE',
      message: 'Research is unavailable: the offline demo has no research provider.',
      detail: ['Connect to a running Ideno server with a configured research provider for sourced evidence.'],
      recoverable: false,
    };
  },

  async proposeResearch(): Promise<never> {
    throw {
      code: 'RESEARCH_UNAVAILABLE',
      message: 'Research is unavailable: the offline demo has no research provider.',
      detail: ['Connect to a running Ideno server with a configured research provider for sourced evidence.'],
      recoverable: false,
    };
  },

  /** POST /api/chat equivalent: yields SSE-like events with small delays. */
  async chat(
    message: string,
    deep: boolean,
    onEvent: (event: ChatEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const trimmed = message.trim();
    if (!trimmed) {
      onEvent({ type: 'error', error: { code: 'BAD_REQUEST', message: 'Message is empty.', recoverable: true } });
      return;
    }
    state.messages.push({ id: prefixedId('msg'), role: 'user', content: trimmed, created_at: nowIso() });

    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const aborted = () => signal?.aborted === true;

    onEvent({ type: 'status', phase: 'routing' });
    await sleep(160);
    if (aborted()) return;

    let envelope: OrchestratorEnvelope;
    if (!state.caseData.original_idea) {
      envelope = initialEnvelope(trimmed);
    } else if (/\b(alternatives?|options?|compare)\b/i.test(trimmed) && /\b(show|list|give|what|generate|compare)\b/i.test(trimmed)) {
      envelope = alternativesEnvelope(trimmed);
    } else if (/\b(go with|select|choose|pick|i prefer)\b/i.test(trimmed)) {
      envelope = selectionEnvelope(trimmed);
    } else if (/\b(must|should|has to|needs to|cannot|can't|only)\b/i.test(trimmed)) {
      envelope = constraintEnvelope(trimmed);
    } else {
      envelope = genericEnvelope();
    }

    onEvent({ type: 'status', phase: 'generating' });
    for (let i = 0; i < envelope.reply.length; i += 24) {
      if (aborted()) return;
      onEvent({ type: 'token', text: envelope.reply.slice(i, i + 24) });
      await sleep(18);
    }
    if (aborted()) return;
    onEvent({ type: 'reply', text: envelope.reply });
    await sleep(120);

    if (envelope.proposal) {
      onEvent({ type: 'status', phase: 'validating' });
      await sleep(140);
      const validation = validateProposal(state.caseData, envelope.proposal);
      if (validation.errors.length > 0) {
        onEvent({
          type: 'proposal_invalid',
          errors: validation.errors,
          reasoning_summary: envelope.proposal.reasoning_summary,
        });
        const assistant: ChatMessage = { id: prefixedId('msg'), role: 'assistant', content: envelope.reply, created_at: nowIso() };
        state.messages.push(assistant, systemNotice(`A proposed state change was rejected automatically: ${validation.errors[0] ?? 'unknown'}`));
        onEvent({ type: 'done', message_id: assistant.id });
        return;
      }

      let critique: CritiqueResult | undefined;
      if (deep) {
        onEvent({ type: 'status', phase: 'critiquing' });
        await sleep(200);
        if (aborted()) return;
        critique = demoCritique(trimmed);
      }

      const stored: StoredProposal = {
        id: prefixedId('prop'),
        status: 'pending',
        created_at: nowIso(),
        user_message: trimmed,
        proposal: envelope.proposal,
        provider: 'offline-demo/browser-demo-v0',
        warnings: [
          ...validation.warnings,
          ...(critique ? critique.issues.map((i) => `Critique (${i.severity}) — ${i.area}: ${i.description}`) : []),
        ],
        ...(critique ? { critique } : {}),
      };
      state.proposals.push(stored);
      const assistant: ChatMessage = {
        id: prefixedId('msg'),
        role: 'assistant',
        content: envelope.reply,
        created_at: nowIso(),
        proposal_id: stored.id,
      };
      state.messages.push(assistant);
      onEvent({ type: 'proposal', proposal: stored });
      onEvent({ type: 'done', message_id: assistant.id, proposal_id: stored.id });
      return;
    }

    const assistant: ChatMessage = { id: prefixedId('msg'), role: 'assistant', content: envelope.reply, created_at: nowIso() };
    state.messages.push(assistant);
    onEvent({ type: 'done', message_id: assistant.id });
  },

  /** Test hook: reset the in-memory demo state. */
  __reset(): void {
    state = freshState();
  },
};

function summaryOf(v: VersionRecord): CaseStateResponse['versions'][number] {
  let added = 0;
  let modified = 0;
  for (const c of Object.values(v.diff.collections)) {
    added += (c.added ?? []).length;
    modified += (c.modified ?? []).length;
  }
  return { number: v.number, id: v.id, created_at: v.created_at, summary: v.summary, trigger: v.trigger, counts: { added, modified } };
}
