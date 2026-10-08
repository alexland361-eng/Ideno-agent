import React, { useEffect, useState } from 'react';
import type { VersionRecord } from '../../shared/schemas/ideaCase.js';
import type { CaseStateResponse } from '../api';
import { fetchVersion } from '../api';

/**
 * Version inspector (§23 Version History, §28).
 * Each version shows its trigger, summary, and state diff. Snapshots enable
 * future branching; v0.1 is a linear chain.
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

export function VersionsPanel({ versions }: { versions: CaseStateResponse['versions'] }) {
  const [openNumber, setOpenNumber] = useState<number | null>(null);
  const [record, setRecord] = useState<VersionRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (openNumber === null) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchVersion(openNumber)
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
  }, [openNumber]);

  const sorted = [...versions].sort((a, b) => b.number - a.number);

  return (
    <div className="versions-panel">
      {sorted.map((v) => (
        <div key={v.number} className={`version-item ${openNumber === v.number ? 'open' : ''}`}>
          <button className="version-head" onClick={() => setOpenNumber(openNumber === v.number ? null : v.number)}>
            <span className="version-number">v{v.number}</span>
            <span className="version-summary">{v.summary || '(no summary)'}</span>
            <span className="version-meta">
              {v.counts.added > 0 && `+${v.counts.added}`} {v.counts.modified > 0 && `~${v.counts.modified}`}
            </span>
          </button>
          {openNumber === v.number && (
            <div className="version-detail">
              <div className="version-trigger">
                {formatTrigger(v.trigger)} · {new Date(v.created_at).toLocaleString()}
              </div>
              {loading && <p className="muted">Loading diff…</p>}
              {error && <p className="error-text">{error}</p>}
              {record && <VersionDiff record={record} />}
            </div>
          )}
        </div>
      ))}
      {sorted.length === 0 && <p className="muted">No versions yet.</p>}
    </div>
  );
}

function formatTrigger(trigger: CaseStateResponse['versions'][number]['trigger']): string {
  switch (trigger.kind) {
    case 'initialization':
      return 'Initial state';
    case 'user_acceptance':
      return trigger.user_message ? `Accepted changes proposed from: “${truncate(trigger.user_message, 80)}”` : 'Accepted changes';
    case 'user_rejection':
      return 'Rejected changes (no state change)';
    case 'reset':
      return 'Case reset';
    default:
      return trigger.kind;
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function VersionDiff({ record }: { record: VersionRecord }) {
  const d = record.diff;
  return (
    <div className="version-diff">
      {d.title && (
        <p className="diff-line">
          <span className="diff-field">title</span> <s>{d.title.from}</s> → <strong>{d.title.to}</strong>
        </p>
      )}
      {d.current_intent && (
        <p className="diff-line">
          <span className="diff-field">intent</span> <s>{truncate(d.current_intent.from, 60)}</s> → <strong>{truncate(d.current_intent.to, 60)}</strong>
        </p>
      )}
      {d.original_idea_set && (
        <p className="diff-line">
          <span className="diff-field">original idea</span> <strong>captured</strong>
        </p>
      )}
      {Object.entries(d.collections).map(([collection, cd]) => (
        <div key={collection} className="diff-collection">
          <div className="diff-collection-name">{COLLECTION_LABELS[collection] ?? collection}</div>
          {cd.added.map((a) => (
            <p key={a.id} className="diff-line add">
              + {a.text}
            </p>
          ))}
          {cd.modified.map((m) => (
            <div key={m.id} className="diff-mod">
              <p className="diff-line mod">
                ~ {m.text ?? m.id}
              </p>
              {m.changes.map((change, i) => (
                <p key={i} className="diff-field-change">
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
      {Object.keys(d.collections).length === 0 && !d.title && !d.current_intent && !d.original_idea_set && (
        <p className="muted">No state changes in this version.</p>
      )}
    </div>
  );
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '∅';
  if (typeof value === 'string') return truncate(value, 50);
  return JSON.stringify(value);
}
