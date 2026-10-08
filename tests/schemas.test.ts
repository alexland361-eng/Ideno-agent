import { describe, expect, it } from 'vitest';
import {
  IdeaCase,
  emptyCase,
  nextItemId,
  COLLECTIONS,
} from '../src/shared/schemas/ideaCase.js';
import { OrchestratorEnvelope, Proposal } from '../src/shared/schemas/proposal.js';
import { buildEnvelopeWireSchema, normalizeNulls } from '../src/server/ai/wireSchema.js';

describe('IdeaCase schema', () => {
  it('accepts an empty case constructed by emptyCase and fills defaults', () => {
    const parsed = IdeaCase.parse(emptyCase('c1', '2026-10-08T00:00:00Z'));
    expect(parsed.id).toBe('c1');
    expect(parsed.version).toBe(0);
    for (const collection of COLLECTIONS) {
      expect(parsed[collection]).toEqual([]);
    }
  });

  it('generates sequential stable ids per collection', () => {
    const c = emptyCase('c1', '2026-10-08T00:00:00Z');
    expect(nextItemId(c, 'goals')).toBe('goal1');
    expect(nextItemId(c, 'goals')).toBe('goal2');
    expect(nextItemId(c, 'requirements')).toBe('req1');
  });

  it('rejects malformed items (missing id, bad knowledge class)', () => {
    const base = emptyCase('c1', '2026-10-08T00:00:00Z');
    const bad = JSON.parse(JSON.stringify(base));
    bad.goals.push({ id: 'goal1', text: 'x', knowledge_class: 'NOT_A_CLASS', status: 'active', created_at: 't', updated_at: 't', provenance: { source: 'user' } });
    expect(IdeaCase.safeParse(bad).success).toBe(false);
    const bad2 = JSON.parse(JSON.stringify(base));
    bad2.goals.push({ text: 'no id', knowledge_class: 'USER_PROVIDED', status: 'active', created_at: 't', updated_at: 't', provenance: { source: 'user' } });
    expect(IdeaCase.safeParse(bad2).success).toBe(false);
  });

  it('round-trips through JSON (persistence compatibility)', () => {
    const c = emptyCase('c1', '2026-10-08T00:00:00Z');
    const json = JSON.parse(JSON.stringify(c));
    expect(IdeaCase.parse(json).id).toBe('c1');
  });
});

describe('OrchestratorEnvelope schema', () => {
  it('accepts a reply-only envelope', () => {
    const r = OrchestratorEnvelope.safeParse({ reply: 'hello' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.proposal).toBeUndefined();
  });

  it('applies defaults to a full proposal (all collections default to empty)', () => {
    const r = OrchestratorEnvelope.parse({
      reply: 'hi',
      proposal: {
        changes: {
          constraints: { added: [{ text: 'No cloud', knowledge_class: 'USER_PROVIDED' }] },
        },
        reasoning_summary: 'why',
      },
    });
    expect(r.proposal?.changes.constraints.added.length).toBe(1);
    expect(r.proposal?.changes.goals.added.length).toBe(0);
    expect(r.proposal?.changes.constraints.added[0]?.hard).toBeUndefined(); // applied at state level
  });

  it('rejects system-only knowledge classes from model output', () => {
    const bad = {
      reply: 'hi',
      proposal: {
        changes: {
          goals: { added: [{ text: 'x', knowledge_class: 'USER_DECIDED' }] },
        },
      },
    };
    expect(OrchestratorEnvelope.safeParse(bad).success).toBe(false);
  });

  it('rejects external evidence from model output (only user | model_knowledge allowed)', () => {
    const bad = {
      reply: 'hi',
      proposal: {
        changes: {
          evidence: { added: [{ claim: 'x', source_type: 'external' }] },
        },
      },
    };
    expect(OrchestratorEnvelope.safeParse(bad).success).toBe(false);
  });

  it('rejects decisions claiming user authority without citing the user message', () => {
    const bad = {
      reply: 'hi',
      proposal: {
        changes: {
          decisions: {
            added: [{ decision: 'chose X', reason: '', basis: 'model_recommendation', decision_maker: 'user' }],
          },
        },
      },
    };
    expect(Proposal.safeParse(bad.proposal).success).toBe(false);
  });

  it('caps questions at 2', () => {
    const bad = {
      reply: 'hi',
      proposal: { changes: {}, questions: ['a', 'b', 'c'] },
    };
    const r = OrchestratorEnvelope.safeParse(bad);
    // questions has .default([]) + .max(2): 3 items must fail
    expect(r.success).toBe(false);
  });
});

describe('wire schema (OpenAI strict compatibility)', () => {
  const wire = buildEnvelopeWireSchema();

  it('contains no "default" keywords anywhere', () => {
    expect(JSON.stringify(wire)).not.toContain('"default"');
  });

  it('lists every property as required in every object', () => {
    const walk = (node: unknown) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node === null || typeof node !== 'object') return;
      const obj = node as Record<string, unknown>;
      if (obj.type === 'object' && obj.properties) {
        const props = Object.keys(obj.properties as object);
        const required = (obj.required as string[]) ?? [];
        expect(new Set(required)).toEqual(new Set(props));
        expect(obj.additionalProperties).toBe(false);
        for (const child of Object.values(obj.properties as object)) walk(child);
      }
      if (obj.type === 'array' && obj.items) walk(obj.items);
    };
    walk(wire);
  });

  it('makes optional properties nullable', () => {
    const root = wire as {
      properties: { reply: unknown; proposal: unknown };
      required: string[];
    };
    expect(root.required).toContain('proposal');
    const proposal = root.properties.proposal as { type: string[] | string };
    expect(proposal.type).toContain('null');
  });

  it('is deterministic between calls', () => {
    expect(JSON.stringify(buildEnvelopeWireSchema())).toBe(JSON.stringify(wire));
  });
});

describe('normalizeNulls', () => {
  it('strips null-valued keys recursively so Zod optionals apply', () => {
    const input = { a: null, b: { c: null, d: 'x' }, e: [1, null, 2] };
    const out = normalizeNulls(input) as Record<string, unknown>;
    expect('a' in out).toBe(false);
    const b = out.b as Record<string, unknown>;
    expect('c' in b).toBe(false);
    expect(b.d).toBe('x');
    // Nulls INSIDE arrays are preserved (only object keys are stripped) —
    // dropping array data would be a silent mutation.
    expect(out.e).toEqual([1, null, 2]);
  });
});
