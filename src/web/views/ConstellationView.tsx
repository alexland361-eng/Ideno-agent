import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { IdeaCase } from '../../shared/schemas/ideaCase.js';
import {
  buildGraph, simulate, project, pickNode, DEFAULT_CAMERA,
  COLLECTION_COLOR, type Camera, type GraphNode, type EdgeKind, type IdeaGraph,
} from '../graph/graph3d.js';
import { Icon } from '../components/icons.js';

/**
 * Idea Constellation (§62, spatial form): the Idea State as a 3D structure.
 * Orbit by dragging, zoom with the wheel, click a node to inspect it in the
 * detail sheet. Edges are real relations only — decisions → affected items,
 * evidence → supported/contradicted claims.
 *
 * Rendering is Canvas 2D with our own projection (graph3d.ts). Hardened
 * against the classic canvas glitches: DPR-aware sizing, single rAF loop
 * that stops when hidden/unmounted, pointer capture during drags, no page
 * scroll hijacking outside the canvas, and a graceful fallback when 2D
 * context is unavailable (e.g. test DOMs).
 */

const EDGE_COLOR: Record<EdgeKind, string> = {
  decision: 'rgba(128,128,128,0.5)',
  supports: 'var(--ok)',
  contradicts: 'var(--danger)',
  alternative: 'var(--explore)',
};

function reducedMotion(): boolean {
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  } catch {
    return false;
  }
}

export function ConstellationView({
  caseData,
  onOpenItem,
}: {
  caseData: IdeaCase;
  onOpenItem: (collection: 'goals' | 'requirements' | 'assumptions' | 'constraints' | 'unknowns' | 'risks' | 'dependencies' | 'evidence' | 'research_items' | 'alternatives' | 'decisions' | 'rejected_approaches' | 'open_questions', id: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const camRef = useRef<Camera>({ ...DEFAULT_CAMERA });
  const graphRef = useRef<IdeaGraph | null>(null);
  const sizeRef = useRef({ w: 0, h: 0 });
  const hoverRef = useRef<string | null>(null);
  const dragRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const rafRef = useRef<number | null>(null);
  const [ctxOk, setCtxOk] = useState(true);
  const [hoverLabel, setHoverLabel] = useState<{ x: number; y: number; node: GraphNode } | null>(null);

  const graph = useMemo(() => simulate(buildGraph(caseData)), [caseData]);
  graphRef.current = graph;

  /* ---- render loop ---- */
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) { setCtxOk(false); return; }
    const { w, h } = sizeRef.current;
    if (w === 0 || h === 0) return;
    const g = graphRef.current;
    if (!g) return;

    // slow ambient rotation unless the user prefers reduced motion
    if (!reducedMotion() && !dragRef.current) camRef.current.yaw += 0.0016;
    const cam = camRef.current;

    ctx.clearRect(0, 0, w, h);
    const proj = new Map<string, { x: number; y: number; depth: number; scale: number }>();
    for (const n of g.nodes) proj.set(n.id, project(n, cam, w, h));
    const byId = new Map(g.nodes.map((n) => [n.id, n]));

    // edges (far first, then near — painter's algorithm by midpoint depth)
    const edgeOrder = g.edges
      .map((e) => ({ e, d: ((proj.get(e.from)?.depth ?? 0) + (proj.get(e.to)?.depth ?? 0)) / 2 }))
      .sort((a, b) => b.d - a.d);
    for (const { e } of edgeOrder) {
      const a = proj.get(e.from), b = proj.get(e.to);
      if (!a || !b) continue;
      const depthFade = Math.max(0.25, 1 - (a.depth + b.depth) / 2 / 900);
      ctx.globalAlpha = 0.65 * depthFade;
      ctx.strokeStyle = EDGE_COLOR[e.kind];
      ctx.lineWidth = e.kind === 'contradicts' || e.kind === 'supports' ? 1.6 : 1.2;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    // nodes back-to-front
    const order = [...g.nodes].sort((a, b) => (proj.get(b.id)!.depth) - (proj.get(a.id)!.depth));
    for (const n of order) {
      const p = proj.get(n.id)!;
      const r = Math.max(2.2, n.radius * p.scale);
      const depthFade = Math.max(0.35, 1 - p.depth / 1100);
      const hovered = hoverRef.current === n.id;
      ctx.globalAlpha = depthFade;
      ctx.beginPath();
      ctx.fillStyle = COLLECTION_COLOR[n.collection];
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
      // rim light (top-left) — the specular cue, subtle
      ctx.globalAlpha = depthFade * 0.5;
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.lineWidth = 1;
      ctx.arc(p.x, p.y, r, Math.PI * 1.05, Math.PI * 1.75);
      ctx.stroke();
      if (hovered) {
        ctx.globalAlpha = 0.9;
        ctx.beginPath();
        ctx.strokeStyle = 'var(--ink)';
        ctx.lineWidth = 2;
        ctx.arc(p.x, p.y, r + 3.5, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // labels: goals/decisions always; others on hover
    ctx.font = '600 11px ' + '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    for (const n of order) {
      const p = proj.get(n.id)!;
      const show = n.collection === 'goals' || n.collection === 'decisions' || hoverRef.current === n.id;
      if (!show) continue;
      const label = n.label.length > 34 ? n.label.slice(0, 33) + '…' : n.label;
      const tw = ctx.measureText(label).width;
      const r = Math.max(2.2, n.radius * p.scale);
      ctx.globalAlpha = 0.92;
      ctx.fillStyle = 'rgba(20,20,22,0.72)';
      ctx.beginPath();
      ctx.roundRect(p.x + r + 5, p.y - 8, tw + 10, 16, 8);
      ctx.fill();
      ctx.fillStyle = '#f4f4f5';
      ctx.fillText(label, p.x + r + 10, p.y + 3.5);
    }
    ctx.globalAlpha = 1;
  }, []);

  useEffect(() => {
    const loop = () => {
      rafRef.current = requestAnimationFrame(loop);
      if (typeof document !== 'undefined' && document.hidden) return;
      draw();
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [draw]);

  /* ---- sizing: DPR-aware, resize-observer driven ---- */
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const resize = () => {
      const dpr = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 2);
      const w = wrap.clientWidth, h = wrap.clientHeight;
      sizeRef.current = { w, h };
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [ctxOk]);

  /* ---- interactions ---- */
  const toLocal = (e: { clientX: number; clientY: number }) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    return rect ? { x: e.clientX - rect.left, y: e.clientY - rect.top } : { x: 0, y: 0 };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, moved: false };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { w, h } = sizeRef.current;
    const drag = dragRef.current;
    if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
      camRef.current.yaw += dx * 0.005;
      camRef.current.pitch = Math.max(-1.35, Math.min(1.35, camRef.current.pitch + dy * 0.005));
      drag.x = e.clientX; drag.y = e.clientY;
      return;
    }
    const g = graphRef.current;
    if (!g) return;
    const { x, y } = toLocal(e);
    const hit = pickNode(g, camRef.current, w, h, x, y);
    if ((hit?.id ?? null) !== hoverRef.current) {
      hoverRef.current = hit?.id ?? null;
      setHoverLabel(hit && hit.collection !== 'goals' && hit.collection !== 'decisions'
        ? { x, y, node: hit } : null);
    } else if (hit && hoverLabel) {
      setHoverLabel({ x, y, node: hit });
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || drag.moved) return; // it was an orbit, not a click
    const { w, h } = sizeRef.current;
    const { x, y } = toLocal(e);
    const hit = pickNode(graphRef.current!, camRef.current, w, h, x, y);
    if (hit) onOpenItem(hit.collection, hit.id);
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      camRef.current.dist = Math.max(160, Math.min(900, camRef.current.dist + e.deltaY * 0.6));
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLCanvasElement>) => {
    const cam = camRef.current;
    switch (e.key) {
      case 'ArrowLeft': cam.yaw -= 0.08; e.preventDefault(); break;
      case 'ArrowRight': cam.yaw += 0.08; e.preventDefault(); break;
      case 'ArrowUp': cam.pitch = Math.min(1.35, cam.pitch + 0.06); e.preventDefault(); break;
      case 'ArrowDown': cam.pitch = Math.max(-1.35, cam.pitch - 0.06); e.preventDefault(); break;
      case '+': case '=': cam.dist = Math.max(160, cam.dist - 30); e.preventDefault(); break;
      case '-': case '_': cam.dist = Math.min(900, cam.dist + 30); e.preventDefault(); break;
      default: break;
    }
  };

  if (graph.nodes.length === 0) {
    return (
      <div className="view-empty">
        <Icon name="orbit" size={34} />
        <h2>The constellation is empty</h2>
        <p>Start a conversation — as the Idea State grows, its goals, decisions, evidence, and risks appear here as a spatial structure.</p>
      </div>
    );
  }

  return (
    <div className="constellation" ref={wrapRef} data-testid="constellation">
      {!ctxOk && (
        <div className="constellation-fallback">
          3D canvas is unavailable in this environment. The Idea State is fully available in the State panel.
        </div>
      )}
      <canvas
        ref={canvasRef}
        className="constellation-canvas"
        role="application"
        tabIndex={0}
        aria-label={`Idea constellation: ${graph.nodes.length} items, ${graph.edges.length} relations. Drag to orbit, scroll to zoom, arrow keys to rotate, plus and minus to zoom, click a node to inspect it.`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => { dragRef.current = null; }}
        onKeyDown={onKeyDown}
      />
      <div className="constellation-legend glass mat-3" aria-hidden="true">
        <span className="lg-item"><i style={{ background: COLLECTION_COLOR.goals }} />Goal</span>
        <span className="lg-item"><i style={{ background: COLLECTION_COLOR.decisions }} />Decision</span>
        <span className="lg-item"><i style={{ background: COLLECTION_COLOR.requirements }} />Requirement</span>
        <span className="lg-item"><i style={{ background: COLLECTION_COLOR.constraints }} />Constraint</span>
        <span className="lg-item"><i style={{ background: COLLECTION_COLOR.evidence }} />Evidence</span>
        <span className="lg-item"><i style={{ background: COLLECTION_COLOR.risks }} />Risk</span>
        <span className="lg-item"><i style={{ background: COLLECTION_COLOR.research_items }} />Explore</span>
      </div>
      <div className="constellation-hint">Drag to orbit · Scroll to zoom · Click a node to inspect</div>
      {hoverLabel && (
        <div className="constellation-tip glass mat-3" style={{ left: hoverLabel.x + 14, top: hoverLabel.y - 10 }}>
          {hoverLabel.node.label}
        </div>
      )}
    </div>
  );
}
