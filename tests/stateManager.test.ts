import { describe, expect, it } from 'vitest';
import { emptyCase, nextItemId } from '../src/shared/schemas/ideaCase.js';
import type { IdeaCase } from '../src/shared/schemas/ideaCase.js';
import type { StoredProposal, Proposal } from '../src/shared/schemas/proposal.js';
import { applyProposal } from '../src/server/core/state/stateManager.js';
import { validateProposal } from '../src/server/core/state/semanticValidation.js';

const NOW = '2026-10-08T12:00:00.000Z';
const OPTS = { now: NOW, providerLabel: 'mock-provider/model-x' };

function storedWith(proposal: Proposal): StoredProposal {
  return {
    id: 'prop_test1',
    status: 'pending',
    created_at: NOW,
    user_message: 'user says',
    proposal,
    provider: 'mock-provider/model-x',
    warnings: [],
  };
}

function makeProposal(changes: unknown, extra: Partial<Proposal> = {}): Proposal {
  return {
    changes: changes as Proposal['changes'],
    impact_analysis: [],
    conflicts: [],
    questions: [],
    reasoning_summary: 'test',
    ...extra,
  };
}

function seedCase(): IdeaCase {
  const c = emptyCase('c1', NOW);
  c.original_idea = 'greenhouse';
  return c;
}

describe('applyProposal', () => {
  it('adds items with server-generated ids, timestamps, and provenance', () => {
    const c = seedCase();
    const p = makeProposal({
      requirements: { added: [{ text: 'Must be autonomous', knowledge_class: 'USER_PROVIDED', priority: 'must' }] },
    });
    const { nextCase, version } = applyProposal(c, storedWith(p), validateProposal(c, p), OPTS);

    expect(nextCase.requirements).toHaveLength(1);
    const req = nextCase.requirements[0]!;
    expect(req.id).toBe('req1');
    expect(req.priority).toBe('must');
    expect(req.knowledge_class).toBe('USER_PROVIDED');
    expect(req.status).toBe('active');
    expect(req.created_at).toBe(NOW);
    expect(req.provenance.source).toBe('model');
    expect(req.provenance.note).toContain('prop_test1');

    // Version bookkeeping
    expect(version.number).toBe(1);
    expect(version.parent_version).toBe(0);
    expect(nextCase.version).toBe(1);
    expect(version.trigger.kind).toBe('user_acceptance');
    expect(version.diff.collections.requirements?.added[0]?.id).toBe('req1');
  });

  it('never mutates the input case (atomicity of the pure apply)', () => {
    const c = seedCase();
    const p = makeProposal({
      goals: { added: [{ text: 'Grow food', knowledge_class: 'USER_PROVIDED' }] },
    });
    applyProposal(c, storedWith(p), validateProposal(c, p), OPTS);
    expect(c.goals).toHaveLength(0);
    expect(c.version).toBe(0);
  });

  it('applies modifications and records field-level diffs', () => {
    const c = seedCase();
    c.unknowns.push({
      id: nextItemId(c, 'unknowns'),
      text: 'What power source?',
      knowledge_class: 'UNKNOWN',
      status: 'active',
      priority: 'medium',
      created_at: 't0',
      updated_at: 't0',
      provenance: { source: 'model' },
    });
    const p = makeProposal({
      unknowns: { modified: [{ id: 'unk1', reason: 'user clarified', priority: 'high' }] },
    });
    const { nextCase, version } = applyProposal(c, storedWith(p), validateProposal(c, p), OPTS);
    expect(nextCase.unknowns[0]?.priority).toBe('high');
    expect(nextCase.unknowns[0]?.last_change_reason).toBe('user clarified');
    const mod = version.diff.collections.unknowns?.modified[0];
    expect(mod?.changes[0]?.field).toBe('priority');
    expect(mod?.changes[0]?.from).toBe('medium');
    expect(mod?.changes[0]?.to).toBe('high');
  });

  it('invalidates assumptions and records the status change', () => {
    const c = seedCase();
    c.assumptions.push({
      id: nextItemId(c, 'assumptions'),
      text: 'Mains electricity is available',
      knowledge_class: 'ASSUMED',
      status: 'active',
      created_at: 't0',
      updated_at: 't0',
      provenance: { source: 'model' },
    });
    const p = makeProposal({
      assumptions: { modified: [{ id: 'asm1', reason: 'offline constraint', status: 'invalidated' }] },
    });
    const { nextCase } = applyProposal(c, storedWith(p), validateProposal(c, p), OPTS);
    expect(nextCase.assumptions[0]?.status).toBe('invalidated');
    expect(nextCase.assumptions[0]?.last_change_reason).toBe('offline constraint');
  });

  it('overwrites evidence sources server-side (model cannot fabricate sources)', () => {
    const c = seedCase();
    const p = makeProposal({
      evidence: {
        added: [
          { claim: 'Pumps draw ~3W', source_type: 'model_knowledge', confidence: 0.9, relevance: 'high' },
          { claim: 'User has a balcony', source_type: 'user' },
        ],
      },
    });
    const { nextCase } = applyProposal(c, storedWith(p), validateProposal(c, p), OPTS);
    expect(nextCase.evidence[0]?.source).toContain('mock-provider/model-x');
    expect(nextCase.evidence[0]?.source).toContain('unverified');
    expect(nextCase.evidence[0]?.knowledge_class).toBe('MODEL_SUGGESTED');
    expect(nextCase.evidence[1]?.source).toBe('User statement (conversation)');
    expect(nextCase.evidence[1]?.knowledge_class).toBe('USER_PROVIDED');
  });

  it('assigns USER_DECIDED to user decisions and MODEL_SUGGESTED to model decisions', () => {
    const c = seedCase();
    const p = makeProposal({
      decisions: {
        added: [
          { decision: 'Use solar', reason: 'user said', basis: 'user_message', decision_maker: 'user' },
          { decision: 'Prefer drip irrigation', reason: 'efficiency', basis: 'model_recommendation', decision_maker: 'model' },
        ],
      },
    });
    const { nextCase } = applyProposal(c, storedWith(p), validateProposal(c, p), OPTS);
    expect(nextCase.decisions[0]?.knowledge_class).toBe('USER_DECIDED');
    expect(nextCase.decisions[0]?.provenance.source).toBe('user');
    expect(nextCase.decisions[1]?.knowledge_class).toBe('MODEL_SUGGESTED');
    expect(nextCase.decisions[1]?.provenance.source).toBe('model');
  });

  it('mirrors rejected/superseded alternatives into rejected_approaches and never deletes them', () => {
    const c = seedCase();
    for (const name of ['A', 'B', 'C']) {
      c.alternatives.push({
        id: nextItemId(c, 'alternatives'),
        name,
        description: `${name} approach`,
        advantages: [],
        disadvantages: [],
        requirements: [],
        risks: [],
        dependencies: [],
        evidence_ids: [],
        status: 'candidate',
        knowledge_class: 'MODEL_SUGGESTED',
        created_at: 't0',
        updated_at: 't0',
        provenance: { source: 'model' },
      });
    }
    const p = makeProposal({
      alternatives: {
        modified: [
          { id: 'alt2', reason: 'user selected it', status: 'accepted' },
          { id: 'alt1', reason: 'not selected', status: 'superseded' },
          { id: 'alt3', reason: 'not selected', status: 'rejected' },
        ],
      },
    });
    const { nextCase } = applyProposal(c, storedWith(p), validateProposal(c, p), OPTS);

    expect(nextCase.alternatives).toHaveLength(3); // nothing deleted
    expect(nextCase.alternatives.find((a) => a.id === 'alt2')?.status).toBe('accepted');
    expect(nextCase.alternatives.find((a) => a.id === 'alt1')?.status).toBe('superseded');
    expect(nextCase.rejected_approaches).toHaveLength(2);
    expect(nextCase.rejected_approaches.map((r) => r.related_alternative_id).sort()).toEqual(['alt1', 'alt3']);
    expect(nextCase.rejected_approaches[0]?.knowledge_class).toBe('REJECTED');
    expect(nextCase.rejected_approaches[0]?.provenance.source).toBe('system');
  });

  it('skips duplicate adds per the validation plan and surfaces warnings in the diff', () => {
    const c = seedCase();
    c.constraints.push({
      id: nextItemId(c, 'constraints'),
      text: 'Must fit on a balcony',
      knowledge_class: 'USER_PROVIDED',
      status: 'active',
      created_at: 't0',
      updated_at: 't0',
      provenance: { source: 'user' },
      hard: true,
    });
    const p = makeProposal({
      constraints: { added: [{ text: 'must fit on a balcony', knowledge_class: 'USER_PROVIDED' }] },
    });
    const validation = validateProposal(c, p);
    expect(validation.skipAdd.constraints?.has(0)).toBe(true);
    const { nextCase, version } = applyProposal(c, storedWith(p), validation, OPTS);
    expect(nextCase.constraints).toHaveLength(1);
    expect(version.diff.warnings.length).toBe(1);
    expect(version.diff.collections.constraints).toBeUndefined();
  });

  it('records scalar changes (title, intent, confidence, original idea once)', () => {
    const c = emptyCase('c1', NOW);
    const p = makeProposal(
      {},
      {
        title: 'Balcony greenhouse',
        current_intent: 'Build a small autonomous greenhouse for a balcony',
        original_idea: 'I want to build a small autonomous greenhouse.',
        confidence: { overall: 0.3, note: 'early' },
      },
    );
    const { nextCase, version } = applyProposal(c, storedWith(p), validateProposal(c, p), OPTS);
    expect(nextCase.title).toBe('Balcony greenhouse');
    expect(nextCase.original_idea).toBe('I want to build a small autonomous greenhouse.');
    expect(nextCase.confidence.overall).toBe(0.3);
    expect(version.diff.title?.to).toBe('Balcony greenhouse');
    expect(version.diff.original_idea_set).toContain('greenhouse');
  });

  it('numbers ids per collection across multiple proposals', () => {
    const c = seedCase();
    const p1 = makeProposal({ goals: { added: [{ text: 'g1', knowledge_class: 'USER_PROVIDED' }] } });
    const step1 = applyProposal(c, storedWith(p1), validateProposal(c, p1), OPTS);
    const p2 = makeProposal({ goals: { added: [{ text: 'g2', knowledge_class: 'USER_PROVIDED' }] } });
    const step2 = applyProposal(step1.nextCase, storedWith(p2), validateProposal(step1.nextCase, p2), OPTS);
    expect(step2.nextCase.goals.map((g) => g.id)).toEqual(['goal1', 'goal2']);
    expect(step2.nextCase.version).toBe(2);
  });
});
