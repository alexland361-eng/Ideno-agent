import { describe, expect, it } from 'vitest';
import { buildGraph, simulate, project, pickNode, kineticEnergy, DEFAULT_CAMERA } from '../src/web/graph/graph3d.js';
import { emptyCase, nextItemId } from '../src/shared/schemas/ideaCase.js';
import type { IdeaCase } from '../src/shared/schemas/ideaCase.js';

/** Constellation math: derivation from REAL relations, deterministic layout, projection. */

function seeded(): IdeaCase {
  const c = emptyCase('primary', '2026-10-08T00:00:00Z');
  c.goals.push({
    id: 'goal1', text: 'Balcony greenhouse', knowledge_class: 'USER_PROVIDED', status: 'active',
    created_at: 't', updated_at: 't', provenance: { source: 'user' }, success_criteria: 'x',
  });
  c.decisions.push({
    id: 'dec1', decision: 'Use solar power', reason: 'r', basis: 'user_message', decision_maker: 'user',
    affected_ids: ['goal1'], alternatives_considered: [], evidence_ids: [], knowledge_class: 'USER_DECIDED',
    status: 'active', created_at: 't', updated_at: 't', provenance: { source: 'user' },
  });
  c.evidence.push({
    id: 'ev1', claim: 'Solar works in winter', source: 'docs', url: 'https://x', source_type: 'external',
    relevance: 'high', confidence: 0.8, supports: ['dec1'], contradicts: [], retrieved_at: 't',
    knowledge_class: 'KNOWN', status: 'active', created_at: 't', updated_at: 't', provenance: { source: 'user' },
  });
  c.evidence.push({
    id: 'ev2', claim: 'Winter light is insufficient', source: 'paper', url: 'https://y', source_type: 'external',
    relevance: 'high', confidence: 0.6, supports: [], contradicts: ['dec1'], retrieved_at: 't',
    knowledge_class: 'KNOWN', status: 'active', created_at: 't', updated_at: 't', provenance: { source: 'user' },
  });
  // An inactive item must not appear.
  c.constraints.push({
    id: 'cst_old', text: 'dropped', knowledge_class: 'ASSUMED', status: 'superseded', hard: true,
    created_at: 't', updated_at: 't', provenance: { source: 'user' },
  });
  // An evidence edge to a nonexistent id must be dropped.
  c.evidence[1]!.contradicts = ['does-not-exist'];
  return c;
}

describe('buildGraph', () => {
  it('derives nodes from active items only', () => {
    const g = buildGraph(seeded());
    const ids = g.nodes.map((n) => n.id).sort();
    expect(ids).toEqual(['dec1', 'ev1', 'ev2', 'goal1']);
    expect(g.nodes.find((n) => n.id === 'goal1')!.collection).toBe('goals');
  });

  it('creates edges only from real relations and drops dangling targets', () => {
    const g = buildGraph(seeded());
    const kinds = g.edges.map((e) => `${e.kind}:${e.from}->${e.to}`).sort();
    expect(kinds).toEqual(['decision:dec1->goal1', 'supports:ev1->dec1']);
    // ev2's contradicts edge pointed at a nonexistent id — dropped (no fake edges).
    expect(g.edges.some((e) => e.from === 'ev2')).toBe(false);
  });

  it('is deterministic: same case → same positions', () => {
    const a = buildGraph(seeded());
    const b = buildGraph(seeded());
    expect(a.nodes.map((n) => [n.id, n.x, n.y, n.z])).toEqual(b.nodes.map((n) => [n.id, n.x, n.y, n.z]));
  });
});

describe('simulate', () => {
  it('settles: kinetic energy decreases and nodes stay in a bounded radius', () => {
    const g = simulate(buildGraph(seeded()), 90);
    const e = kineticEnergy(g);
    expect(e).toBeLessThan(1e-3 * g.nodes.length + 5);
    for (const n of g.nodes) {
      expect(Math.hypot(n.x, n.y, n.z)).toBeLessThan(400);
    }
  });
});

describe('project + pickNode', () => {
  it('projects the origin to the screen center; nearer objects are larger', () => {
    const cam = { ...DEFAULT_CAMERA };
    const center = project({ x: 0, y: 0, z: 0 }, cam, 800, 600);
    expect(center.x).toBeCloseTo(400, 5);
    expect(center.y).toBeCloseTo(300, 5);
    const near = project({ x: 0, y: 0, z: -200 }, cam, 800, 600);
    const far = project({ x: 0, y: 0, z: 200 }, cam, 800, 600);
    expect(near.scale).toBeGreaterThan(far.scale);
    expect(near.depth).toBeLessThan(far.depth);
  });

  it('picks the node under the cursor and nothing far away', () => {
    const g = simulate(buildGraph(seeded()), 40);
    const target = g.nodes[0]!;
    const p = project(target, DEFAULT_CAMERA, 800, 600);
    const hit = pickNode(g, DEFAULT_CAMERA, 800, 600, p.x, p.y, 10);
    expect(hit?.id).toBe(target.id);
    expect(pickNode(g, DEFAULT_CAMERA, 800, 600, 5, 5, 4)).toBeNull();
  });
});

describe('empty case', () => {
  it('produces an empty graph (the view shows its empty state)', () => {
    const c = emptyCase('primary', 't');
    c.constraints.push({
      id: nextItemId(c, 'constraints'), text: 'x', knowledge_class: 'ASSUMED', status: 'active',
      hard: true, created_at: 't', updated_at: 't', provenance: { source: 'user' },
    });
    expect(buildGraph(c).nodes).toHaveLength(1);
    expect(buildGraph(emptyCase('primary', 't')).nodes).toHaveLength(0);
  });
});
