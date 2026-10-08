import React, { useEffect, useState } from 'react';
import type { VersionRecord } from '../../shared/schemas/ideaCase.js';
import type { CaseStateResponse } from '../api';
import { fetchVersion } from '../api';
import { Icon } from '../components/icons.js';
import { cn } from '../components/glass.js';

/**
 * Version history (§18, §19): a chronological evolution timeline — not a Git
 * interface. Selecting a version reveals its semantic diff.
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

export function HistoryView({ versions }: { versions: CaseStateResponse['versions'] }) {
  const sorted = [...versions].sort((a, b) => b.number - a.number);
  const [open, setOpen] = useState<number | null>(null);

  if (sorted.length === 0) {
    return (
      <div className="view-empty">
        <Icon name="history" size={20} />
        <p>No history yet.</p>
        <p className="muted">Versions appear as the idea evolves through accepted changes.</p>
      </div>
    );
  }

  return (
    <div className="history-view">
      <div className="view-head">
        <h1>Evolution</h1>
        <p className="muted">Each version records an accepted change to the Idea State.</p>
      </div>
      <ol className="timeline">
        {sorted.map((v, i) => (
          <li key={v.number} className={cn('tl-item', i === sorted.length - 1 && 'tl-origin')}>
            <span className="tl-node" aria-hidden="true" />
            <div className="tl-card glass mat-2">
              <button
                className="tl-head"
                onClick={() => setOpen(open === v.number ? null : v.number)}
                aria-expanded={open === v.number}
              >
                <span className="tl-version">v{v.number}</span>
                <span className="tl-summary">{v.summary || 'Idea state updated'}</span>
                <span className="tl-meta">
                  {v.counts.added > 0 && `+${v.counts.added}`}
                  {v.counts.modified > 0 && ` ~${v.counts.modified}`}
                </span>
                <Icon
                  name="chevron-down"
                  size={13}
                  className={cn('sp-chev', open === v.number && 'open')}
                />
              </button>
              <div className="tl-sub">
                {formatTrigger(v.trigger)} · {formatDate(v.created_at)}
              </div>
              {open === v.number && <VersionDetail number={v.number} />}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function VersionDetail({ number }: { number: number }) {
  const [record, setRecord] = useState<VersionRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchVersion(number)
      .then((res) => {
        if (!cancelled) setRecord(res.version);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [number]);

  if (loading) return <div className="tl-diff muted">Loading diff…</div>;
  if (error) return <div className="tl-diff error-text">{error}</div>;
  if (!record) return null;

  const d = record.diff;
  const collections = Object.entries(d.collections);
  const touchedCount =
    collections.reduce((n, [, cd]) => n + cd.added.length + cd.modified.length, 0) +
    (d.title ? 1 : 0) +
    (d.current_intent ? 1 : 0) +
    (d.original_idea_set ? 1 : 0);

  return (
    <div className="tl-diff">
      <div className="diff-impact">
        <Icon name="state" size={12} />
        {touchedCount} component{touchedCount === 1 ? '' : 's'} affected
      </div>
      {d.title && (
        <p className="diff-line">
          <span className="diff-glyph mod">~</span> title <s>{d.title.from}</s> → <strong>{d.title.to}</strong>
        </p>
      )}
      {d.current_intent && (
        <p className="diff-line">
          <span className="diff-glyph mod">~</span> intent → <strong>{truncate(d.current_intent.to, 90)}</strong>
        </p>
      )}
      {d.original_idea_set && (
        <p className="diff-line">
          <span className="diff-glyph add">+</span> original idea captured
        </p>
      )}
      {collections.map(([collection, cd]) => (
        <div key={collection} className="diff-collection">
          <div className="group-label">{COLLECTION_LABELS[collection] ?? collection}</div>
          {cd.added.map((a) => (
            <p key={a.id} className="diff-line">
              <span className="diff-glyph add">+</span> {a.text}
            </p>
          ))}
          {cd.modified.map((m) => (
            <div key={m.id} className="diff-mod">
              <p className="diff-line">
                <span className="diff-glyph mod">~</span> {m.text ?? m.id}
              </p>
              {m.changes.map((change, i) => (
                <p key={i} className="diff-field">
                  {change.field}: {formatValue(change.from)} → {formatValue(change.to)}
                </p>
              ))}
            </div>
          ))}
        </div>
      ))}
      {d.warnings.length > 0 && (
        <div className="diff-warnings">
          {d.warnings.map((w, i) => (
            <p key={i}>⚠ {w}</p>
          ))}
        </div>
      )}
      {collections.length === 0 && !d.title && !d.current_intent && !d.original_idea_set && (
        <p className="muted">No state changes recorded.</p>
      )}
    </div>
  );
}

function formatTrigger(trigger: CaseStateResponse['versions'][number]['trigger']): string {
  switch (trigger.kind) {
    case 'initialization':
      return 'Original idea';
    case 'user_acceptance':
      return trigger.user_message ? `From “${truncate(trigger.user_message, 60)}”` : 'Accepted changes';
    case 'user_rejection':
      return 'Rejected changes';
    case 'reset':
      return 'Case reset';
    default:
      return trigger.kind;
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '∅';
  if (typeof value === 'string') return truncate(value, 48);
  return JSON.stringify(value);
}
