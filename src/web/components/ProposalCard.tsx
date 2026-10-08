import React, { useState } from 'react';
import type { StoredProposal } from '../../shared/schemas/proposal.js';
import { Icon } from './icons.js';
import { Button, cn } from './glass.js';

/**
 * Change proposal card (§15): proposal → inspection → acceptance → integration.
 * This is where the human exercises authority over the Idea State.
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
  research_items: 'Research',
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
  if (typeof add.knowledge_class === 'string') bits.push(add.knowledge_class.toLowerCase().replace(/_/g, ' '));
  if (typeof add.priority === 'string') bits.push(add.priority);
  if (typeof add.severity === 'string') bits.push(add.severity);
  if (add.hard === true) bits.push('hard');
  if (add.hard === false) bits.push('soft');
  if (typeof add.source_type === 'string') bits.push(`source: ${add.source_type.replace(/_/g, ' ')}`);
  if (add.decision_maker) bits.push(`by ${String(add.decision_maker)}`);
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
  if (p.title) scalarChanges.push(`New title — “${p.title}”`);
  if (p.current_intent) scalarChanges.push('Updated intent');
  if (p.original_idea) scalarChanges.push('Captures the original idea');

  const isPending = proposal.status === 'pending';
  const integrating = isPending && busy;

  return (
    <div className={cn('proposal glass mat-2', `proposal-${proposal.status}`)}>
      <div className="proposal-head">
        <span className="proposal-label">
          <Icon name="state" size={13} /> Proposed changes
        </span>
        <span className={cn('proposal-status', `st-${proposal.status}`)}>
          {proposal.status === 'pending' && integrating ? 'integrating…' : proposal.status}
        </span>
      </div>

      {touched.length === 0 && scalarChanges.length === 0 && (
        <p className="muted proposal-empty">No state changes in this proposal.</p>
      )}

      {scalarChanges.length > 0 && (
        <ul className="chg-list">
          {scalarChanges.map((s, i) => (
            <li key={i} className="chg add">
              <span className="chg-glyph">+</span>
              <span>{s}</span>
            </li>
          ))}
        </ul>
      )}

      {touched
        .filter(([, c]) => (c.added?.length ?? 0) > 0)
        .map(([collection, c]) => (
          <div className="proposal-group" key={collection}>
            <div className="group-label">{COLLECTION_LABELS[collection] ?? collection}</div>
            <ul className="chg-list">
              {c.added.map((add, i) => (
                <li key={i} className="chg add">
                  <span className="chg-glyph">+</span>
                  <span className="chg-body">
                    <span className="chg-text">{addedText(add)}</span>
                    {addedSub(add) && <span className="chg-sub">{addedSub(add)}</span>}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}

      {modifications.length > 0 && (
        <div className="proposal-group">
          <div className="group-label">Modified</div>
          <ul className="chg-list">
            {modifications.map(({ collection, mod }, i) => (
              <li key={i} className="chg mod">
                <span className="chg-glyph">~</span>
                <span className="chg-body">
                  <span className="chg-id">
                    {COLLECTION_LABELS[collection] ?? collection} {String(mod.id)}
                  </span>
                  {typeof mod.text === 'string' && mod.text && <span className="chg-text">{mod.text}</span>}
                  <span className="chg-sub">{String(mod.reason ?? '')}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {invalidations.length > 0 && (
        <div className="proposal-group">
          <div className="group-label">Invalidated</div>
          <ul className="chg-list">
            {invalidations.map(({ collection, mod }, i) => (
              <li key={i} className="chg rem">
                <span className="chg-glyph">−</span>
                <span className="chg-body">
                  <span className="chg-id">
                    {COLLECTION_LABELS[collection] ?? collection} {String(mod.id)}
                  </span>
                  {typeof mod.text === 'string' && mod.text && <span className="chg-text strike">{mod.text}</span>}
                  <span className="chg-sub">
                    {String(mod.status)} — {String(mod.reason ?? '')}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {p.impact_analysis.length > 0 && (
        <div className="proposal-group">
          <div className="group-label">Affects</div>
          <ul className="impact-list">
            {p.impact_analysis.map((impact, i) => (
              <li key={i}>
                <span className="impact-area">{impact.area}</span>
                {impact.effect && <span className="chg-sub"> {impact.effect}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {p.conflicts.length > 0 && (
        <div className="conflict-box" role="alert">
          <div className="conflict-title">
            <Icon name="alert" size={14} /> Conflicts detected
          </div>
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
        <div className="proposal-question">
          {p.questions.map((q, i) => (
            <p key={i}>{q}</p>
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

      {p.reasoning_summary && (
        <p className="proposal-reasoning">Reasoning summary: {p.reasoning_summary}</p>
      )}

      <div className="proposal-actions">
        {isPending ? (
          <>
            <Button
              variant="accept"
              icon="check"
              disabled={busy}
              onClick={() => onAccept(proposal.id)}
            >
              Accept
            </Button>
            <Button
              variant="danger"
              icon="close"
              disabled={busy}
              onClick={() => onReject(proposal.id)}
            >
              Reject
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setInspect((v) => !v)}>
              {inspect ? 'Hide details' : 'Inspect'}
            </Button>
            <span className="proposal-provenance">via {proposal.provider}</span>
          </>
        ) : (
          <>
            <span className={cn('proposal-resolution', `res-${proposal.status}`)}>
              {proposal.status === 'accepted' && `Accepted — version ${proposal.resulting_version}`}
              {proposal.status === 'rejected' &&
                `Rejected${proposal.rejection_reason ? ` — ${proposal.rejection_reason}` : ''}`}
              {proposal.status === 'invalid' && 'Rejected automatically — state unchanged'}
            </span>
            <Button variant="ghost" size="sm" onClick={() => setInspect((v) => !v)}>
              {inspect ? 'Hide details' : 'Inspect'}
            </Button>
          </>
        )}
      </div>

      {inspect && (
        <pre className="proposal-json">{JSON.stringify(proposal.proposal, null, 2)}</pre>
      )}
    </div>
  );
}
