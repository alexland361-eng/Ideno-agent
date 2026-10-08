import { describe, expect, it } from 'vitest';
import { emptyCase, nextItemId } from '../src/shared/schemas/ideaCase.js';
import type { IdeaCase } from '../src/shared/schemas/ideaCase.js';
import type { Proposal } from '../src/shared/schemas/proposal.js';
import { validateProposal } from '../src/server/core/state/semanticValidation.js';

function baseCase(): IdeaCase {
  const c = emptyCase('c1', '2026-10-08T00:00:00Z');
  c.original_idea = 'original';
  c.constraints.push({
    id: nextItemId(c, 'constraints'),
    text: 'Must fit on a balcony',
    knowledge_class: 'USER_PROVIDED',
    status: 'active',
    created_at: 't',
    updated_at: 't',
    provenance: { source: 'user' },
    hard: true,
  });
  c.assumptions.push({
    id: nextItemId(c, 'assumptions'),
    text: 'Mains electricity is available',
    knowledge_class: 'ASSUMED',
    status: 'active',
    created_at: 't',
    updated_at: 't',
    provenance: { source: 'model' },
  });
  return c;
}

function proposalOf(changes: unknown): Proposal {
  return {
    changes: changes as Proposal['changes'],
    impact_analysis: [],
    conflicts: [],
    questions: [],
    reasoning_summary: '',
  };
}

describe('semantic validation', () => {
  it('rejects modifications of nonexistent items', () => {
    const c = baseCase();
    const p = proposalOf({ requirements: { modified: [{ id: 'req999', reason: 'x', text: 'new' }] } });
    const out = validateProposal(c, p);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toContain('req999');
  });

  it('rejects double modification of the same item', () => {
    const c = baseCase();
    const p = proposalOf({
      constraints: {
        modified: [
          { id: 'cst1', reason: 'a', text: 'one' },
          { id: 'cst1', reason: 'b', text: 'two' },
        ],
      },
    });
    expect(validateProposal(c, p).errors[0]).toContain('more than once');
  });

  it('rejects empty modifications (no fields to change)', () => {
    const c = baseCase();
    const p = proposalOf({ constraints: { modified: [{ id: 'cst1', reason: 'no-op' }] } });
    expect(validateProposal(c, p).errors[0]).toContain('no fields');
  });

  it('rejects setting original_idea when it is already set', () => {
    const c = baseCase();
    const p = proposalOf({});
    (p as { original_idea?: string }).original_idea = 'rewriting history';
    expect(validateProposal(c, p).errors[0]).toContain('original_idea');
  });

  it('skips duplicate adds with a warning (never silently)', () => {
    const c = baseCase();
    const p = proposalOf({
      constraints: { added: [{ text: 'Must fit on a balcony', knowledge_class: 'USER_PROVIDED' }] },
    });
    const out = validateProposal(c, p);
    expect(out.errors).toHaveLength(0);
    expect(out.warnings).toHaveLength(1);
    expect(out.skipAdd.constraints?.has(0)).toBe(true);
  });

  it('skips duplicates within the same proposal', () => {
    const c = baseCase();
    const p = proposalOf({
      risks: { added: [{ text: 'same risk' }, { text: 'Same risk!' }] },
    });
    const out = validateProposal(c, p);
    expect(out.errors).toHaveLength(0);
    expect(out.skipAdd.risks?.has(1)).toBe(true);
  });

  it('rejects a user-attributed decision that does not cite the user message', () => {
    const c = baseCase();
    const p = proposalOf({
      decisions: {
        added: [{ decision: 'Use X', reason: '', basis: 'evidence', decision_maker: 'user' }],
      },
    });
    expect(validateProposal(c, p).errors[0]).toContain('user_message');
  });

  it('warns (for the human) about decisions attributed to the user', () => {
    const c = baseCase();
    const p = proposalOf({
      decisions: {
        added: [{ decision: 'Use X', reason: 'they said so', basis: 'user_message', decision_maker: 'user' }],
      },
    });
    const out = validateProposal(c, p);
    expect(out.errors).toHaveLength(0);
    expect(out.warnings.some((w) => w.includes('attributed to YOU'))).toBe(true);
  });

  it('rejects decision references to unknown alternatives', () => {
    const c = baseCase();
    const p = proposalOf({
      decisions: {
        added: [
          { decision: 'pick', reason: '', basis: 'user_message', decision_maker: 'user', alternatives_considered: ['alt42'] },
        ],
      },
    });
    expect(validateProposal(c, p).errors[0]).toContain('alt42');
  });

  it('accepts decision references to alternatives added in the same proposal', () => {
    const c = baseCase();
    const p = proposalOf({
      alternatives: {
        added: [{ name: 'A', description: '', key: 'a' }],
      },
      decisions: {
        added: [
          { decision: 'pick A', reason: '', basis: 'user_message', decision_maker: 'user', alternatives_considered: ['a'] },
        ],
      },
    });
    expect(validateProposal(c, p).errors).toHaveLength(0);
  });

  it('rejects marking research items answered without a research provider', () => {
    const c = baseCase();
    c.research_items.push({
      id: nextItemId(c, 'research_items'),
      question: 'q?',
      priority: 'medium',
      status: 'pending',
      evidence_ids: [],
      knowledge_class: 'UNKNOWN',
      created_at: 't',
      updated_at: 't',
      provenance: { source: 'model' },
    });
    const p = proposalOf({ research_items: { modified: [{ id: 'res1', reason: 'done', status: 'answered' }] } });
    expect(validateProposal(c, p).errors[0]).toContain('answered');
  });

  it('rejects conflicts referencing unknown ids', () => {
    const c = baseCase();
    const p = proposalOf({});
    p.conflicts.push({ description: 'clash', affected_ids: ['nope1'], suggested_resolutions: [] });
    expect(validateProposal(c, p).errors[0]).toContain('nope1');
  });

  it('rejects modification of a field outside the allowed set', () => {
    const c = baseCase();
    const p = proposalOf({
      constraints: { modified: [{ id: 'cst1', reason: 'hack', provenance: { source: 'user' } } as never] },
    });
    expect(validateProposal(c, p).errors[0]).toContain('cannot be modified');
  });
});
