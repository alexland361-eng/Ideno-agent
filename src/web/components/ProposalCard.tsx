import React, { useState } from 'react';
import type { StoredProposal } from '../../shared/schemas/proposal.js';
import type { CollectionKey } from '../../shared/schemas/ideaCase.js';

/**
 * Change review card (§5 Human Authority, §29 Change Inspection).
 * Every state-changing proposal is visible, explained, and requires an
 * explicit human decision before it touches the Idea State.
 */

const COLLECTION_LABELS: Record<string, string> = {
  goals: 'Goals',
  requirements: 'Requirements',
  assumptions: 'Assumptions',
  constraints: 'Constraints',
  unknowns: 'Unknowns',
  risks: 'Risks',
  dependencies: 'Dependencies',
  evidence: 'Evidence',
  research_items: 'Research items',
  alternatives: 'Alternatives',
  decisions: 'Decisions',
  rejected_approaches: 'Rejected approaches',
  open_questions: 'Open questions',
};

function addedText(add: Record<string, unknown>): string {
  return String(add.text ?? add.claim ?? add.question ?? add.decision ?? add.name ?? '');
}

function addedSub(add: Record<string, unknown>): string | undefined {
  const bits: string[] = [];
  if (typeof add.knowledge_class === 'string') bits.push(add.knowledge_class);
  if (typeof add.priority === 'string') bits.push(`priority: ${add.priority}`);
  if (typeof add.severity === 'string') bits.push(`severity: ${add.severity}`);
  if (add.hard === true) bits.push('hard');
  if (add.hard === false) bits.push('soft');
  if (typeof add.source_type === 'string') bits.push(`source: ${add.source_type}`);
  if (add.decision_maker) bits.push(`by ${String(add.decision_maker)}`);
  if (typeof add.basis === 'string') bits.push(`basis: ${add.basis}`);
  return bits.length ? bits.join(' · ') : undefined;
}

export function ProposalCard({
  proposal,
  onAccept,
  onReject,
  busy,
}: {
  proposal: StoredProposal;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  busy: boolean;
}) {
  const [inspect, setInspect] = useState(false);
  const p = proposal.proposal;
  const changes = p.changes as unknown as Record<
    string,
    { added: Array<Record<string, unknown>>; modified: Array<Record<string, unknown>> }
  >;

  const touched = Object.entries(changes).filter(
    ([, c]) => (c?.added?.length ?? 0) > 0 || (c?.modified?.length ?? 0) > 0,
  );
  const invalidations: Array<{ collection: string; mod: Record<string, unknown> }> = [];
  const modifications: Array<{ collection: string; mod: Record<string, unknown> }> = [];
  for (const [collection, c] of touched) {
    for (const mod of c.modified ?? []) {
      if (mod.status === 'invalidated' || mod.status === 'superseded' || mod.status === 'rejected') {
        invalidations.push({ collection, mod });
      } else {
        modifications.push({ collection, mod });
      }
    }
  }

  const scalarChanges: string[] = [];
  if (p.title) scalarChanges.push(`New title: “${p.title}”`);
  if (p.current_intent) scalarChanges.push(`Updated intent`);
  if (p.original_idea) scalarChanges.push(`Captures the original idea`);

  return (
    <div className={`proposal-card status-${proposal.status}`}>
      <div className="proposal-head">
        <span className="proposal-title">PROPOSED STATE CHANGES</span>
        <span className={`proposal-status status-badge-${proposal.status}`}>{proposal.status}</span>
        {proposal.resulting_version !== undefined && (
          <span className="proposal-version">→ v{proposal.resulting_version}</span>
        )}
      </div>

      {touched.length === 0 && scalarChanges.length === 0 && (
        <p className="proposal-empty">No state changes in this proposal.</p>
      )}

      {scalarChanges.length > 0 && (
        <div className="proposal-section">
          <div className="section-label">Case</div>
          <ul className="change-list adds">
            {scalarChanges.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </div>
      )}

      {touched
        .filter(([, c]) => (c.added?.length ?? 0) > 0)
        .map(([collection, c]) => (
          <div className="proposal-section" key={collection}>
            <div className="section-label">Added · {COLLECTION_LABELS[collection] ?? collection}</div>
            <ul className="change-list adds">
              {c.added.map((add, i) => (
                <li key={i}>
                  <span className="change-text">{addedText(add)}</span>
                  {addedSub(add) && <span className="change-sub">{addedSub(add)}</span>}
                </li>
              ))}
            </ul>
          </div>
        ))}

      {modifications.length > 0 && (
        <div className="proposal-section">
          <div className="section-label">Modified</div>
          <ul className="change-list mods">
            {modifications.map(({ collection, mod }, i) => (
              <li key={i}>
                <span className="change-id">
                  {COLLECTION_LABELS[collection] ?? collection} {String(mod.id)}
                </span>
                <span className="change-text">{String(mod.text ?? '')}</span>
                <span className="change-sub">Reason: {String(mod.reason ?? '')}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {invalidations.length > 0 && (
        <div className="proposal-section">
          <div className="section-label">Invalidated / superseded</div>
          <ul className="change-list invalidations">
            {invalidations.map(({ collection, mod }, i) => (
              <li key={i}>
                <span className="change-id">
                  {COLLECTION_LABELS[collection] ?? collection} {String(mod.id)}
                </span>
                <span className="change-text strike">{String(mod.text ?? '')}</span>
                <span className="change-sub">
                  {String(mod.status)} — {String(mod.reason ?? '')}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {p.impact_analysis.length > 0 && (
        <div className="proposal-section">
          <div className="section-label">Affected areas</div>
          <ul className="impact-list">
            {p.impact_analysis.map((impact, i) => (
              <li key={i}>
                <span className="impact-area">{impact.area}</span>
                <span className="change-sub">{impact.effect}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {p.conflicts.length > 0 && (
        <div className="proposal-conflicts">
          <div className="section-label conflict-label">⚠ Conflicts detected</div>
          {p.conflicts.map((c, i) => (
            <div key={i} className="conflict-item">
              <p>{c.description}</p>
              {c.suggested_resolutions.length > 0 && (
                <ul>
                  {c.suggested_resolutions.map((r, j) => (
                    <li key={j}>{r}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}

      {p.questions.length > 0 && (
        <div className="proposal-section">
          <div className="section-label">Suggested next question</div>
          {p.questions.map((q, i) => (
            <p key={i} className="question-text">{q}</p>
          ))}
        </div>
      )}

      {proposal.warnings.length > 0 && (
        <div className="proposal-warnings">
          {proposal.warnings.map((w, i) => (
            <p key={i}>{w}</p>
          ))}
        </div>
      )}

      {p.reasoning_summary && <p className="proposal-reasoning">Reasoning summary: {p.reasoning_summary}</p>}

      <div className="proposal-actions">
        {proposal.status === 'pending' ? (
          <>
            <button className="btn accept" disabled={busy} onClick={() => onAccept(proposal.id)}>
              Accept
            </button>
            <button className="btn reject" disabled={busy} onClick={() => onReject(proposal.id)}>
              Reject
            </button>
            <button className="btn ghost" onClick={() => setInspect((v) => !v)}>
              {inspect ? 'Hide' : 'Inspect'}
            </button>
          </>
        ) : (
          <>
            <span className={`proposal-resolution res-${proposal.status}`}>
              {proposal.status === 'accepted' && `Accepted → v${proposal.resulting_version}`}
              {proposal.status === 'rejected' &&
                `Rejected${proposal.rejection_reason ? ` — ${proposal.rejection_reason}` : ''}. State unchanged.`}
              {proposal.status === 'invalid' && 'Automatically rejected (failed validation). State unchanged.'}
            </span>
            <button className="btn ghost" onClick={() => setInspect((v) => !v)}>
              {inspect ? 'Hide' : 'Inspect'}
            </button>
          </>
        )}
      </div>

      {inspect && (
        <pre className="proposal-json">{JSON.stringify(proposal.proposal, null, 2)}</pre>
      )}
      <div className="proposal-provenance">via {proposal.provider}</div>
    </div>
  );
}

export type { CollectionKey };
