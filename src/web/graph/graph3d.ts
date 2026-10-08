/**
 * Idea Constellation — 3D graph derivation and projection (pure functions).
 *
 * The Idea State rendered as a spatial structure: every active item is a
 * node (colored by collection semantics), and only REAL relations become
 * edges (decisions affect items, evidence supports/contradicts claims,
 * alternatives link to their rejected kin). No fabricated connections.
 *
 * Rendering is Canvas 2D with hand-rolled 3D projection — no WebGL context
 * to lose, no 3D library to ship, works everywhere, and the math is
 * unit-testable. Positions come from a deterministic seed layout relaxed by
 * a small force simulation, so the same state always produces the same
 * constellation.
 */

import type { IdeaCase } from '../../shared/schemas/ideaCase.js';

export type CollectionKey =
  | 'goals' | 'requirements' | 'assumptions' | 'constraints' | 'unknowns'
  | 'risks' | 'dependencies' | 'evidence' | 'research_items' | 'alternatives'
  | 'decisions' | 'rejected_approaches' | 'open_questions';

/** Semantic color token per collection (§4: hue carries meaning). */
export const COLLECTION_COLOR: Record<CollectionKey, string> = {
  goals: 'var(--accent)',
  requirements: 'var(--teal)',
  assumptions: 'var(--ink-dim)',
  constraints: 'var(--warn)',
  unknowns: 'var(--warn)',
  risks: 'var(--danger)',
  dependencies: 'var(--ink-faint)',
  evidence: 'var(--ok)',
  research_items: 'var(--explore)',
  alternatives: 'var(--explore)',
  decisions: 'var(--ink)',
  rejected_approaches: 'var(--ink-faint)',
  open_questions: 'var(--ink-dim)',
};

export const COLLECTION_SHELL: Record<CollectionKey, number> = {
  goals: 0,          // center
  decisions: 1,
  requirements: 2,
  constraints: 2,
  assumptions: 3,
  unknowns: 3,
  open_questions: 3,
  alternatives: 4,
  risks: 4,
  dependencies: 4,
  evidence: 5,       // outer ring: sources orbit the claims
  research_items: 5,
  rejected_approaches: 5,
};

export interface GraphNode {
  id: string;
  collection: CollectionKey;
  label: string;
  /** 3D position */
  x: number; y: number; z: number;
  /** simulation velocity */
  vx: number; vy: number; vz: number;
  /** render radius */
  radius: number;
}

export type EdgeKind = 'decision' | 'supports' | 'contradicts' | 'alternative';

export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
}

export interface IdeaGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

interface ItemLike {
  id: string;
  status?: string;
  text?: string;
  claim?: string;
  decision?: string;
  question?: string;
  name?: string;
}

function itemLabel(item: ItemLike): string {
  return String(item.text ?? item.claim ?? item.decision ?? item.question ?? item.name ?? item.id);
}

/** Deterministic 32-bit hash (FNV-1a) → seed positions are stable per id. */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const COLLECTIONS: CollectionKey[] = [
  'goals', 'requirements', 'assumptions', 'constraints', 'unknowns', 'risks',
  'dependencies', 'evidence', 'research_items', 'alternatives', 'decisions',
  'rejected_approaches', 'open_questions',
];

export function buildGraph(caseData: IdeaCase): IdeaGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const idSet = new Set<string>();

  for (const collection of COLLECTIONS) {
    const items = caseData[collection] as ItemLike[];
    for (const item of items) {
      if (item.status && item.status !== 'active' && !(collection === 'alternatives' && item.status === 'accepted')) continue;
      idSet.add(item.id);
      const shell = COLLECTION_SHELL[collection];
      const h = hash32(item.id);
      const golden = 2.399963; // golden angle → even sphere packing
      const t = (h % 1000) / 1000;
      const ringR = shell === 0 ? 0 : 30 + shell * 26 + t * 18;
      const angle = ((h >>> 10) % 1000) / 1000 * Math.PI * 2;
      const height = shell === 0 ? 0 : (((h >>> 20) % 1000) / 1000 - 0.5) * (18 + shell * 10);
      nodes.push({
        id: item.id,
        collection,
        label: itemLabel(item),
        x: Math.cos(angle + nodes.length * golden * 0.001) * ringR,
        y: height,
        z: Math.sin(angle + nodes.length * golden * 0.001) * ringR,
        vx: 0, vy: 0, vz: 0,
        radius: collection === 'goals' ? 10 : collection === 'decisions' ? 8 : collection === 'evidence' ? 5 : 6.5,
      });
    }
  }

  // Only REAL relations become edges (§57 no fake functionality).
  for (const d of caseData.decisions) {
    for (const target of d.affected_ids ?? []) {
      if (idSet.has(d.id) && idSet.has(target)) {
        edges.push({ from: d.id, to: target, kind: 'decision' });
      }
    }
  }
  for (const e of caseData.evidence) {
    for (const target of e.supports ?? []) {
      if (idSet.has(e.id) && idSet.has(target)) edges.push({ from: e.id, to: target, kind: 'supports' });
    }
    for (const target of e.contradicts ?? []) {
      if (idSet.has(e.id) && idSet.has(target)) edges.push({ from: e.id, to: target, kind: 'contradicts' });
    }
  }
  for (const a of caseData.alternatives) {
    const rel = (a as unknown as { related_alternative_id?: string }).related_alternative_id;
    if (rel && idSet.has(a.id) && idSet.has(rel)) {
      edges.push({ from: a.id, to: rel, kind: 'alternative' });
    }
  }

  return { nodes, edges };
}

/**
 * Relax the layout: springs along edges, repulsion between nodes, gentle
 * pull of each node toward its collection shell radius. Mutates node
 * positions. Runs a fixed number of iterations for determinism.
 */
export function simulate(graph: IdeaGraph, iterations = 90): IdeaGraph {
  const { nodes, edges } = graph;
  if (nodes.length === 0) return graph;
  const spring = 0.012;
  const repulse = 900;
  const damping = 0.82;
  const byId = new Map(nodes.map((n) => [n.id, n]));

  for (let it = 0; it < iterations; it++) {
    // pairwise repulsion
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i]!;
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j]!;
        let dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
        let d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < 0.01) { dx = (hash32(a.id + b.id) % 21 - 10) / 10; dy = 0.37; dz = 0.11; d2 = dx * dx + dy * dy + dz * dz; }
        const d = Math.sqrt(d2);
        const f = repulse / d2;
        const fx = (dx / d) * f, fy = (dy / d) * f, fz = (dz / d) * f;
        a.vx += fx; a.vy += fy; a.vz += fz;
        b.vx -= fx; b.vy -= fy; b.vz -= fz;
      }
    }
    // edge springs
    for (const e of edges) {
      const a = byId.get(e.from), b = byId.get(e.to);
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      const f = (d - 70) * spring;
      const fx = (dx / d) * f, fy = (dy / d) * f, fz = (dz / d) * f;
      a.vx += fx; a.vy += fy; a.vz += fz;
      b.vx -= fx; b.vy -= fy; b.vz -= fz;
    }
    // shell pull + integrate
    for (const n of nodes) {
      const shell = COLLECTION_SHELL[n.collection];
      if (shell > 0) {
        const r = Math.sqrt(n.x * n.x + n.z * n.z) || 1;
        const target = 30 + shell * 26;
        const pull = (target - r) * 0.004;
        n.vx += (n.x / r) * pull * 10;
        n.vz += (n.z / r) * pull * 10;
      } else {
        n.vx -= n.x * 0.002; n.vy -= n.y * 0.002; n.vz -= n.z * 0.002;
      }
      n.vx *= damping; n.vy *= damping; n.vz *= damping;
      n.x += n.vx; n.y += n.vy; n.z += n.vz;
    }
  }
  return graph;
}

export interface Camera {
  /** yaw around Y axis (radians) */
  yaw: number;
  /** pitch (radians, clamped ±~1.35) */
  pitch: number;
  /** camera distance from centroid */
  dist: number;
}

export const DEFAULT_CAMERA: Camera = { yaw: 0.6, pitch: 0.35, dist: 420 };

export interface Projected {
  x: number;
  y: number;
  /** depth (camera-space z); larger = farther */
  depth: number;
  /** perspective scale factor (>0) */
  scale: number;
}

const FOCALE = 900;

/** Project a world point to screen space with the orbiting camera. */
export function project(
  node: { x: number; y: number; z: number },
  cam: Camera,
  width: number,
  height: number,
): Projected {
  const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
  const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
  // rotate around Y (yaw), then X (pitch)
  const x1 = node.x * cy - node.z * sy;
  const z1 = node.x * sy + node.z * cy;
  const y2 = node.y * cp - z1 * sp;
  const z2 = node.y * sp + z1 * cp;
  const zc = z2 + cam.dist;
  const scale = FOCALE / Math.max(zc, 40);
  return {
    x: width / 2 + x1 * scale,
    y: height / 2 - y2 * scale,
    depth: zc,
    scale,
  };
}

/** Find the node nearest to screen point (px, py) within `tolerance` px. */
export function pickNode(
  graph: IdeaGraph,
  cam: Camera,
  width: number,
  height: number,
  px: number,
  py: number,
  tolerance = 14,
): GraphNode | null {
  let best: GraphNode | null = null;
  let bestD = tolerance;
  for (const n of graph.nodes) {
    const p = project(n, cam, width, height);
    const d = Math.hypot(p.x - px, p.y - py);
    if (d <= bestD) {
      bestD = d;
      best = n;
    }
  }
  return best;
}

/** Total kinetic energy — used by tests to assert the layout settles. */
export function kineticEnergy(graph: IdeaGraph): number {
  let e = 0;
  for (const n of graph.nodes) e += n.vx * n.vx + n.vy * n.vy + n.vz * n.vz;
  return e;
}
