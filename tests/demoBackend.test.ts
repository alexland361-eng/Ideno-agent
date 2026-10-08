import { beforeEach, describe, expect, it } from 'vitest';
import { demoBackend } from '../src/web/demoBackend.js';
import type { ChatEvent } from '../src/shared/chat.js';

/**
 * Offline demo backend tests. The demo runs the REAL core state machine
 * (semanticValidation + applyProposal) in the browser — these tests verify
 * that pipeline honestly: proposals validate, acceptance versions, diffs
 * are real, research is never faked. The scripted chat envelopes are
 * deterministic templates, not AI output (labeled as such in the payloads).
 */

async function chat(message: string, deep = false): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  await demoBackend.chat(message, deep, (e) => events.push(e), undefined);
  return events;
}

beforeEach(() => {
  demoBackend.__reset();
});

describe('offline demo backend', () => {
  it('boots with an empty case and honest demo config/health', () => {
    const state = demoBackend.getCaseState();
    expect(state.case.version).toBe(0);
    expect(state.case.goals).toHaveLength(0);
    expect(state.versions[0]!.trigger.kind).toBe('initialization');

    const config = demoBackend.getConfig();
    expect(config.research_provider_configured).toBe(false);
    expect(config.providers[0]!.is_demo).toBe(true);
    expect(config.startup_notes[0]).toContain('Offline demo');

    const health = demoBackend.getHealth();
    expect(health.providers[0]!.is_demo).toBe(true);
    expect(health.providers[0]!.display_name).toContain('OFFLINE DEMO');
  });

  it('streams a scripted initial proposal; accepting runs the REAL apply pipeline', async () => {
    const events = await chat('I want to build a small balcony greenhouse for herbs.');
    expect(events.some((e) => e.type === 'status' && e.phase === 'routing')).toBe(true);
    const proposal = events.find((e) => e.type === 'proposal');
    expect(proposal).toBeDefined();
    const done = events.find((e) => e.type === 'done');
    expect(done).toBeDefined();

    const id = (proposal as { proposal: { id: string } }).proposal.id;
    const { version, case: next } = await demoBackend.acceptProposal(id);
    expect(version.number).toBe(1);
    expect(next.version).toBe(1);
    expect(next.goals).toHaveLength(1);
    expect(next.original_idea).toContain('greenhouse');

    // Real diff + snapshot from the real state machine.
    const { version: detail } = demoBackend.getVersion(1);
    expect(detail.diff.collections.goals?.added.length).toBe(1);
    expect(detail.snapshot.version).toBe(1);

    // Case state reflects it.
    const state = demoBackend.getCaseState();
    expect(state.versions.map((v) => v.number)).toEqual([0, 1]);
    expect(state.versions[1]!.counts.added).toBeGreaterThan(0);
  });

  it('reject leaves the state untouched and versions nothing', async () => {
    const events = await chat('I want to build a tiny workshop.');
    const id = (events.find((e) => e.type === 'proposal') as { proposal: { id: string } }).proposal.id;
    const stored = await demoBackend.rejectProposal(id);
    expect(stored.status).toBe('rejected');
    expect(demoBackend.getCaseState().case.version).toBe(0);
    expect(demoBackend.getCaseState().versions).toHaveLength(1);
  });

  it('deep mode attaches a labeled demo critique and merges warnings', async () => {
    const events = await chat('I want to build a notes app.', true);
    expect(events.some((e) => e.type === 'status' && e.phase === 'critiquing')).toBe(true);
    const proposal = events.find((e) => e.type === 'proposal') as { proposal: { critique?: { summary: string }; warnings: string[] } };
    expect(proposal.proposal.critique).toBeDefined();
    expect(proposal.proposal.critique!.summary).toContain('offline demo');
    expect(proposal.proposal.warnings.some((w) => w.startsWith('Critique ('))).toBe(true);
  });

  it('constraint and alternatives flows produce the right collections', async () => {
    await chat('I want to build a cargo bike.');
    const first = demoBackend.getCaseState().proposals[0]!;
    await demoBackend.acceptProposal(first.id);

    await chat('It must fit in a bike lane.');
    const constraint = demoBackend.getCaseState().proposals[1]!;
    expect(constraint.proposal.changes.constraints.added.length).toBe(1);

    await chat('Show me alternatives for the frame.');
    const alts = demoBackend.getCaseState().proposals[2]!;
    expect(alts.proposal.changes.alternatives.added.length).toBe(2);
  });

  it('research is NEVER faked: same classified error as the server', async () => {
    await expect(demoBackend.researchSearch()).rejects.toMatchObject({ code: 'RESEARCH_UNAVAILABLE' });
    await expect(demoBackend.proposeResearch()).rejects.toMatchObject({ code: 'RESEARCH_UNAVAILABLE' });
  });

  it('reset restores the empty state', async () => {
    const events = await chat('I want to build a treehouse.');
    const id = (events.find((e) => e.type === 'proposal') as { proposal: { id: string } }).proposal.id;
    await demoBackend.acceptProposal(id);
    const state = demoBackend.resetCase();
    expect(state.case.version).toBe(0);
    expect(state.case.goals).toHaveLength(0);
    expect(state.messages).toHaveLength(0);
  });
});
