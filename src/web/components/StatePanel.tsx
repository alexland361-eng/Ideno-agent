import React, { useState } from 'react';
import type {
  IdeaCase,
  GoalItem,
  RequirementItem,
  AssumptionItem,
  ConstraintItem,
  UnknownItem,
  RiskItem,
  DependencyItem,
  EvidenceItem,
  ResearchItem,
  AlternativeItem,
  DecisionItem,
  RejectedApproachItem,
  OpenQuestionItem,
  KnowledgeClass,
} from '../../shared/schemas/ideaCase.js';

/**
 * Live Idea State panel (§28 UI Architecture).
 * Communicates structure, epistemic class, and lifecycle — not a JSON dump.
 */

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

function ClassBadge({ kc }: { kc: string }) {
  const key = (kc as KnowledgeClass) in CLASS_LABEL ? (kc as KnowledgeClass) : 'MODEL_SUGGESTED';
  return <span className={`kbadge kbadge-${key}`}>{CLASS_LABEL[key]}</span>;
}

interface ItemRowProps {
  id: string;
  text: string;
  status: string;
  knowledgeClass: string;
  chips?: string[];
  sub?: string;
}

function ItemRow({ id, text, status, knowledgeClass, chips, sub }: ItemRowProps) {
  const dead = status !== 'active';
  return (
    <div className={`item-row ${dead ? `item-dead item-${status}` : ''}`} title={`${id} · ${status}`}>
      <div className="item-main">
        <span className={`item-text ${dead ? 'strike' : ''}`}>{text}</span>
        <span className="item-chips">
          {chips?.map((c) => (
            <span key={c} className={`chip chip-${c.replace(/\s+/g, '-')}`}>
              {c}
            </span>
          ))}
        </span>
      </div>
      <div className="item-meta">
        <ClassBadge kc={knowledgeClass} />
        <span className="item-id">{id}</span>
        {dead && <span className="item-status-note">{status}</span>}
      </div>
      {sub && <div className="item-sub">{sub}</div>}
    </div>
  );
}

function Section({
  title,
  count,
  children,
  defaultOpen = true,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (count === 0) return null;
  return (
    <section className="state-section">
      <button className="section-header" onClick={() => setOpen(!open)}>
        <span className={`chev ${open ? 'open' : ''}`}>▸</span>
        <span className="section-title">{title}</span>
        <span className="section-count">{count}</span>
      </button>
      {open && <div className="section-body">{children}</div>}
    </section>
  );
}

export function StatePanel({ caseData }: { caseData: IdeaCase }) {
  const c = caseData;
  const active = <T extends { status: string }>(items: T[]): T[] => items.filter((i) => i.status === 'active');
  const dead = <T extends { status: string }>(items: T[]): T[] => items.filter((i) => i.status !== 'active');

  return (
    <div className="state-panel">
      <div className="state-overview">
        <h2 className="case-title">{c.title}</h2>
        {c.original_idea && <p className="case-original">“{c.original_idea}”</p>}
        {c.current_intent && (
          <p className="case-intent">
            <span className="label">Intent</span> {c.current_intent}
          </p>
        )}
        <div className="confidence-wrap" title={`How well-specified the idea is (${c.confidence.note || 'no note'})`}>
          <div className="confidence-bar">
            <div className="confidence-fill" style={{ width: `${Math.round(c.confidence.overall * 100)}%` }} />
          </div>
          <span className="confidence-label">confidence {Math.round(c.confidence.overall * 100)}%</span>
        </div>
        {c.current_state.summary && <p className="case-summary">{c.current_state.summary}</p>}
        {c.current_state.next_steps.length > 0 && (
          <div className="next-steps">
            <span className="label">Next steps</span>
            <ul>
              {c.current_state.next_steps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <Section title="Goals" count={active(c.goals).length}>
        {active(c.goals).map((g: GoalItem) => (
          <ItemRow key={g.id} id={g.id} text={g.text} status={g.status} knowledgeClass={g.knowledge_class} sub={g.success_criteria ? `Success: ${g.success_criteria}` : undefined} />
        ))}
        {dead(c.goals).map((g) => (
          <ItemRow key={g.id} id={g.id} text={g.text} status={g.status} knowledgeClass={g.knowledge_class} />
        ))}
      </Section>

      <Section title="Requirements" count={active(c.requirements).length}>
        {active(c.requirements).map((r: RequirementItem) => (
          <ItemRow key={r.id} id={r.id} text={r.text} status={r.status} knowledgeClass={r.knowledge_class} chips={[r.priority]} />
        ))}
        {dead(c.requirements).map((r) => (
          <ItemRow key={r.id} id={r.id} text={r.text} status={r.status} knowledgeClass={r.knowledge_class} />
        ))}
      </Section>

      <Section title="Constraints" count={active(c.constraints).length}>
        {active(c.constraints).map((k: ConstraintItem) => (
          <ItemRow key={k.id} id={k.id} text={k.text} status={k.status} knowledgeClass={k.knowledge_class} chips={[k.hard ? 'hard' : 'soft']} />
        ))}
        {dead(c.constraints).map((k) => (
          <ItemRow key={k.id} id={k.id} text={k.text} status={k.status} knowledgeClass={k.knowledge_class} />
        ))}
      </Section>

      <Section title="Assumptions" count={active(c.assumptions).length}>
        {active(c.assumptions).map((a: AssumptionItem) => (
          <ItemRow key={a.id} id={a.id} text={a.text} status={a.status} knowledgeClass={a.knowledge_class} sub={a.note} />
        ))}
        {dead(c.assumptions).map((a) => (
          <ItemRow key={a.id} id={a.id} text={a.text} status={a.status} knowledgeClass={a.knowledge_class} />
        ))}
      </Section>

      <Section title="Unknowns" count={active(c.unknowns).length}>
        {active(c.unknowns).map((u: UnknownItem) => (
          <ItemRow key={u.id} id={u.id} text={u.text} status={u.status} knowledgeClass={u.knowledge_class} chips={[u.priority]} />
        ))}
        {dead(c.unknowns).map((u) => (
          <ItemRow key={u.id} id={u.id} text={u.text} status={u.status} knowledgeClass={u.knowledge_class} />
        ))}
      </Section>

      <Section title="Open questions" count={active(c.open_questions).length}>
        {active(c.open_questions).map((q: OpenQuestionItem) => (
          <ItemRow key={q.id} id={q.id} text={q.text} status={q.status} knowledgeClass={q.knowledge_class} chips={q.asked_to === 'research' ? ['for research'] : undefined} sub={q.answer ? `Answered: ${q.answer}` : undefined} />
        ))}
      </Section>

      <Section title="Alternatives" count={c.alternatives.length}>
        {c.alternatives.map((a: AlternativeItem) => (
          <div key={a.id} className={`alt-card alt-${a.status}`}>
            <div className="alt-head">
              <span className={`alt-name ${a.status === 'rejected' || a.status === 'superseded' ? 'strike' : ''}`}>{a.name}</span>
              <span className={`chip chip-alt-${a.status}`}>{a.status}</span>
            </div>
            <p className="alt-desc">{a.description}</p>
            {a.advantages.length > 0 && (
              <div className="alt-cols">
                <ul className="alt-pros">
                  {a.advantages.map((x, i) => (
                    <li key={i}>{x}</li>
                  ))}
                </ul>
                <ul className="alt-cons">
                  {a.disadvantages.map((x, i) => (
                    <li key={i}>{x}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ))}
      </Section>

      <Section title="Decisions" count={active(c.decisions).length}>
        {active(c.decisions).map((d: DecisionItem) => (
          <ItemRow
            key={d.id}
            id={d.id}
            text={d.decision}
            status={d.status}
            knowledgeClass={d.knowledge_class}
            chips={[`by ${d.decision_maker}`]}
            sub={[d.reason, d.basis !== 'user_message' ? `basis: ${d.basis}` : undefined].filter(Boolean).join(' · ') || undefined}
          />
        ))}
      </Section>

      <Section title="Risks" count={active(c.risks).length}>
        {active(c.risks).map((r: RiskItem) => (
          <ItemRow key={r.id} id={r.id} text={r.text} status={r.status} knowledgeClass={r.knowledge_class} chips={[r.severity]} />
        ))}
      </Section>

      <Section title="Dependencies" count={active(c.dependencies).length}>
        {active(c.dependencies).map((d: DependencyItem) => (
          <ItemRow key={d.id} id={d.id} text={d.text} status={d.status} knowledgeClass={d.knowledge_class} />
        ))}
      </Section>

      <Section title="Evidence" count={active(c.evidence).length} defaultOpen={false}>
        {active(c.evidence).map((e: EvidenceItem) => (
          <ItemRow
            key={e.id}
            id={e.id}
            text={e.claim}
            status={e.status}
            knowledgeClass={e.knowledge_class}
            chips={[e.source_type === 'user' ? 'user' : e.source_type === 'external' ? 'external' : 'model knowledge']}
            sub={`${e.source} · confidence ${Math.round(e.confidence * 100)}%`}
          />
        ))}
      </Section>

      <Section title="Research questions" count={c.research_items.filter((r) => r.status !== 'answered').length} defaultOpen={false}>
        {c.research_items
          .filter((r: ResearchItem) => r.status !== 'answered')
          .map((r) => (
            <ItemRow key={r.id} id={r.id} text={r.question} status={r.status === 'pending' ? 'active' : r.status} knowledgeClass={r.knowledge_class} chips={[r.status, r.priority]} sub={r.rationale} />
          ))}
      </Section>

      <Section title="Rejected approaches" count={active(c.rejected_approaches).length} defaultOpen={false}>
        {active(c.rejected_approaches).map((r: RejectedApproachItem) => (
          <ItemRow key={r.id} id={r.id} text={r.text} status={r.status} knowledgeClass={r.knowledge_class} sub={r.reason ? `Reason: ${r.reason} (by ${r.rejected_by})` : `by ${r.rejected_by}`} />
        ))}
      </Section>
    </div>
  );
}
