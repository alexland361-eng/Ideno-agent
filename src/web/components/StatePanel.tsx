import React, { useEffect, useMemo, useRef, useState } from 'react';
import type {
  IdeaCase,
  CollectionKey,
  KnowledgeClass,
} from '../../shared/schemas/ideaCase.js';
import { Icon, type IconName } from './icons.js';
import { ConfidenceDots, Sheet, cn } from './glass.js';

/**
 * The Idea State surface (§12, §13): the visual centerpiece of Ideno.
 * Elegant glass sections with progressive disclosure; every item carries
 * semantic metadata (knowledge class, origin, lifecycle). Clicking an item
 * opens an inspector-style detail sheet (§47). Highlight pulses (§45, §46)
 * make the evolution of the idea perceptible when proposals are accepted.
 */

export interface DetailTarget {
  collection: CollectionKey;
  id: string;
}

export interface StatePanelProps {
  caseData: IdeaCase;
  highlightKeys: Set<string>;
  detail: DetailTarget | null;
  onDetailChange: (target: DetailTarget | null) => void;
}

const CLASS_LABEL: Record<KnowledgeClass, string> = {
  USER_PROVIDED: 'user',
  USER_DECIDED: 'user decision',
  ASSUMED: 'assumed',
  INFERRED: 'inferred',
  UNKNOWN: 'unknown',
  MODEL_SUGGESTED: 'model suggestion',
  SUPPORTED_BY_EVIDENCE: 'evidenced',
  CONTRADICTED_BY_EVIDENCE: 'contradicted',
  KNOWN: 'known',
  REJECTED: 'rejected',
};

function KBadge({ kc }: { kc: string }) {
  const key = (kc as KnowledgeClass) in CLASS_LABEL ? (kc as KnowledgeClass) : 'MODEL_SUGGESTED';
  return <span className={cn('kbadge', `kb-${key}`)}>{CLASS_LABEL[key]}</span>;
}

interface SectionDef {
  key: CollectionKey;
  label: string;
  icon: IconName;
  openByDefault?: boolean;
}

const SECTIONS: SectionDef[] = [
  { key: 'goals', label: 'Goal', icon: 'compass' },
  { key: 'requirements', label: 'Requirements', icon: 'check' },
  { key: 'constraints', label: 'Constraints', icon: 'shield' },
  { key: 'assumptions', label: 'Assumptions', icon: 'info' },
  { key: 'unknowns', label: 'Unknowns', icon: 'alert' },
  { key: 'open_questions', label: 'Open questions', icon: 'research' },
  { key: 'alternatives', label: 'Alternatives', icon: 'layers' },
  { key: 'decisions', label: 'Decisions', icon: 'bolt' },
  { key: 'risks', label: 'Risks', icon: 'alert' },
  { key: 'dependencies', label: 'Dependencies', icon: 'state' },
  { key: 'evidence', label: 'Evidence', icon: 'inspect', openByDefault: false },
  { key: 'research_items', label: 'Research', icon: 'research', openByDefault: false },
  { key: 'rejected_approaches', label: 'Rejected', icon: 'minus', openByDefault: false },
];

export function StatePanel({ caseData, highlightKeys, detail, onDetailChange }: StatePanelProps) {
  const c = caseData;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const bodyRef = useRef<HTMLDivElement>(null);

  // Highlighted sections expand and scroll into view (§46 linkage).
  useEffect(() => {
    if (highlightKeys.size === 0) return;
    setCollapsed((prev) => {
      const next = new Set(prev);
      for (const key of highlightKeys) next.delete(key);
      return next;
    });
    const first = bodyRef.current?.querySelector<HTMLElement>('.sp-section.hl');
    first?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [highlightKeys]);

  return (
    <div className="statepanel">
      <div className="sp-overview" ref={bodyRef}>
        <div className="sp-title-row">
          <h2 className="sp-title">{c.title}</h2>
          <span className="version-chip">v{c.version}</span>
        </div>
        {c.original_idea && <p className="sp-original">“{c.original_idea}”</p>}
        {c.current_intent && <p className="sp-intent">{c.current_intent}</p>}
        <div className="sp-confidence">
          <ConfidenceDots value={c.confidence.overall} />
          <span className="sp-confidence-note">
            {c.confidence.note || 'how well-specified the idea is'}
          </span>
        </div>
        {c.current_state.summary && <p className="sp-summary">{c.current_state.summary}</p>}
        {c.current_state.next_steps.length > 0 && (
          <div className="sp-next">
            <span className="group-label">Next</span>
            <ul>
              {c.current_state.next_steps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="sp-sections">
        {SECTIONS.map((section) => (
          <StateSection
            key={section.key}
            def={section}
            caseData={c}
            highlighted={highlightKeys.has(section.key)}
            collapsed={collapsed.has(section.key)}
            onToggle={() =>
              setCollapsed((prev) => {
                const next = new Set(prev);
                if (next.has(section.key)) next.delete(section.key);
                else next.add(section.key);
                return next;
              })
            }
            onOpenItem={(id) => onDetailChange({ collection: section.key, id })}
          />
        ))}
      </div>

      <ItemDetailSheet caseData={c} detail={detail} onDetailChange={onDetailChange} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function StateSection({
  def,
  caseData,
  highlighted,
  collapsed,
  onToggle,
  onOpenItem,
}: {
  def: SectionDef;
  caseData: IdeaCase;
  highlighted: boolean;
  collapsed: boolean;
  onToggle: () => void;
  onOpenItem: (id: string) => void;
}) {
  const items = caseData[def.key] as Array<Record<string, unknown> & { id: string }>;
  const active = items.filter((i) => i.status === 'active' || (def.key === 'alternatives' && i.status === 'accepted'));
  const extra = items.length - active.length;
  const open = !collapsed;

  if (active.length === 0 && extra === 0) return null;

  return (
    <section className={cn('sp-section glass mat-2', highlighted && 'hl')} data-section={def.key}>
      <button className="sp-section-head" onClick={onToggle} aria-expanded={open}>
        <Icon name={def.icon} size={13} className="sp-section-icon" />
        <span className="sp-section-label">{def.label}</span>
        <span className="sp-count">{active.length}</span>
        {extra > 0 && <span className="sp-count-extra">+{extra}</span>}
        <Icon name="chevron-down" size={13} className={cn('sp-chev', open && 'open')} />
      </button>
      {open && (
        <div className="sp-section-body">
          {active.map((item) => (
            <StateItemRow
              key={item.id}
              collection={def.key}
              item={item}
              onOpen={() => onOpenItem(item.id)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function StateItemRow({
  collection,
  item,
  onOpen,
}: {
  collection: CollectionKey;
  item: Record<string, unknown> & { id: string };
  onOpen: () => void;
}) {
  const text = String(
    item.text ?? item.claim ?? item.decision ?? item.question ?? item.name ?? item.id,
  );
  const chips: string[] = [];
  if (typeof item.priority === 'string') chips.push(item.priority);
  if (item.hard === true) chips.push('hard');
  if (item.hard === false) chips.push('soft');
  if (typeof item.severity === 'string') chips.push(item.severity);
  if (collection === 'alternatives' && typeof item.status === 'string') chips.push(item.status);
  const sub =
    typeof item.note === 'string' && item.note
      ? item.note
      : typeof item.reason === 'string' && item.reason && collection === 'rejected_approaches'
        ? `reason: ${item.reason}`
        : collection === 'evidence'
          ? `${String(item.source ?? '')} · confidence ${Math.round(Number(item.confidence ?? 0.5) * 100)}%`
          : undefined;

  return (
    <button className="sp-item" onClick={onOpen} title={`Inspect ${item.id}`}>
      <span className="sp-item-text">{text}</span>
      {chips.length > 0 && (
        <span className="sp-item-chips">
          {chips.map((chip) => (
            <span key={chip} className={cn('chip', `chip-${chip}`)}>
              {chip}
            </span>
          ))}
        </span>
      )}
      {sub && <span className="sp-item-sub">{sub}</span>}
      <span className="sp-item-meta">
        <KBadge kc={String(item.knowledge_class ?? 'MODEL_SUGGESTED')} />
        <span className="sp-item-id">{item.id}</span>
      </span>
    </button>
  );
}

/* --------------------------------------------------------------------------
   Detail sheet (§47) — Apple-inspector-style surface for one state item.
   -------------------------------------------------------------------------- */

function ItemDetailSheet({
  caseData,
  detail,
  onDetailChange,
}: {
  caseData: IdeaCase;
  detail: DetailTarget | null;
  onDetailChange: (t: DetailTarget | null) => void;
}) {
  const item = useMemo(() => {
    if (!detail) return null;
    const list = caseData[detail.collection] as Array<Record<string, unknown> & { id: string }>;
    return list.find((i) => i.id === detail.id) ?? null;
  }, [caseData, detail]);

  if (!detail || !item) return null;

  const text = String(
    item.text ?? item.claim ?? item.decision ?? item.question ?? item.name ?? item.id,
  );
  const id = item.id;
  const relatedEvidence = caseData.evidence.filter(
    (e) => (e.supports ?? []).includes(id) || (e.contradicts ?? []).includes(id),
  );
  const relatedDecisions = caseData.decisions.filter((d) => (d.affected_ids ?? []).includes(id));

  const label = SECTIONS.find((s) => s.key === detail.collection)?.label ?? detail.collection;

  return (
    <Sheet
      open
      onClose={() => onDetailChange(null)}
      title={label}
      className="item-detail"
    >
      <p className="detail-text">{text}</p>

      <dl className="detail-grid">
        <div>
          <dt>Knowledge class</dt>
          <dd>
            <KBadge kc={String(item.knowledge_class ?? 'MODEL_SUGGESTED')} />
          </dd>
        </div>
        <div>
          <dt>Origin</dt>
          <dd>
            {String((item.provenance as Record<string, unknown> | undefined)?.source ?? '—')}
            {((item.provenance as Record<string, unknown> | undefined)?.note as string | undefined)
              ? ` · ${String((item.provenance as Record<string, unknown>).note)}`
              : ''}
          </dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>{formatDate(String(item.created_at))}</dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>{formatDate(String(item.updated_at))}</dd>
        </div>
        {typeof item.last_change_reason === 'string' && item.last_change_reason && (
          <div className="detail-wide">
            <dt>Last change</dt>
            <dd>{item.last_change_reason}</dd>
          </div>
        )}
        {typeof item.status === 'string' && item.status !== 'active' && (
          <div>
            <dt>Status</dt>
            <dd>
              <span className={cn('chip', `chip-status-${item.status}`)}>{item.status}</span>
            </dd>
          </div>
        )}
        {typeof item.success_criteria === 'string' && item.success_criteria && (
          <div className="detail-wide">
            <dt>Success criteria</dt>
            <dd>{item.success_criteria}</dd>
          </div>
        )}
        {typeof item.rationale === 'string' && item.rationale && (
          <div className="detail-wide">
            <dt>Rationale</dt>
            <dd>{item.rationale}</dd>
          </div>
        )}
        {detail.collection === 'evidence' && (
          <>
            <div className="detail-wide">
              <dt>Source</dt>
              <dd>{String(item.source ?? '—')}</dd>
            </div>
            <div>
              <dt>Confidence</dt>
              <dd>
                <ConfidenceDots value={Number(item.confidence ?? 0.5)} label="evidence confidence" />
              </dd>
            </div>
          </>
        )}
        {detail.collection === 'alternatives' && (
          <>
            <div className="detail-wide">
              <dt>Advantages</dt>
              <dd>
                <ul className="detail-list pros">
                  {((item.advantages as string[]) ?? []).map((x, i) => (
                    <li key={i}>{x}</li>
                  ))}
                </ul>
              </dd>
            </div>
            <div className="detail-wide">
              <dt>Limitations</dt>
              <dd>
                <ul className="detail-list cons">
                  {((item.disadvantages as string[]) ?? []).map((x, i) => (
                    <li key={i}>{x}</li>
                  ))}
                </ul>
              </dd>
            </div>
          </>
        )}
      </dl>

      {(relatedEvidence.length > 0 || relatedDecisions.length > 0) && (
        <div className="detail-related">
          <div className="group-label">Related</div>
          {relatedEvidence.map((e) => (
            <button
              key={e.id}
              className="related-row"
              onClick={() => onDetailChange({ collection: 'evidence', id: e.id })}
            >
              <Icon name="inspect" size={12} />
              <span className="related-text">{e.claim}</span>
              <span className={cn('chip', (e.contradicts ?? []).includes(id) ? 'chip-low' : 'chip-high')}>
                {(e.contradicts ?? []).includes(id) ? 'contradicts' : 'supports'}
              </span>
            </button>
          ))}
          {relatedDecisions.map((d) => (
            <button
              key={d.id}
              className="related-row"
              onClick={() => onDetailChange({ collection: 'decisions', id: d.id })}
            >
              <Icon name="bolt" size={12} />
              <span className="related-text">{d.decision}</span>
              <span className="chip">decision</span>
            </button>
          ))}
        </div>
      )}
    </Sheet>
  );
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}
