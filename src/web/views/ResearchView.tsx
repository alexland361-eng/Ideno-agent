import React, { useState } from 'react';
import type { IdeaCase } from '../../shared/schemas/ideaCase.js';
import { researchSearch, proposeResearch, type ResearchResponse } from '../api';
import { Icon } from '../components/icons.js';
import { Button, TextInput, cn } from '../components/glass.js';

/**
 * Research view (§16, §17): evidence is separate from conversation, and the
 * absence of a research provider is stated honestly — never faked (§57).
 */

export function ResearchView({
  caseData,
  researchConfigured,
  onProposed,
}: {
  caseData: IdeaCase;
  researchConfigured: boolean;
  /** Called after a research proposal is created — the review card awaits in the conversation. */
  onProposed: () => void;
}) {
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [proposing, setProposing] = useState(false);
  const [results, setResults] = useState<ResearchResponse | null>(null);
  const [proposedFor, setProposedFor] = useState<string | null>(null);
  const [error, setError] = useState<{ code: string; message: string; detail?: string[] } | null>(null);

  const questions = caseData.research_items.filter((r) => r.status !== 'answered');
  const openForResearch = caseData.open_questions.filter((q) => !q.answer && q.asked_to === 'research');

  const propose = async () => {
    const q = query.trim();
    if (!q || proposing || proposedFor === q) return;
    setProposing(true);
    setError(null);
    try {
      await proposeResearch(q);
      setProposedFor(q);
      onProposed();
    } catch (err) {
      const e = err as { code?: string; message?: string; detail?: string[] };
      setError({
        code: e.code ?? 'RESEARCH_ERROR',
        message: e.message ?? (err instanceof Error ? err.message : String(err)),
        detail: e.detail,
      });
    } finally {
      setProposing(false);
    }
  };

  const search = async () => {
    const q = query.trim();
    if (!q || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await researchSearch(q);
      setResults(res);
      setProposedFor(null);
      setError(null);
    } catch (err) {
      const e = err as { code?: string; message?: string; detail?: string[] };
      setError({
        code: e.code ?? 'RESEARCH_ERROR',
        message: e.message ?? (err instanceof Error ? err.message : String(err)),
        detail: e.detail,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="research-view">
      <div className="view-head">
        <h1>Research</h1>
        <p className="muted">
          External evidence is kept strictly separate from model statements. Every claim
          shown as evidence carries its source.
        </p>
      </div>

      <div className="research-search glass mat-2">
        <TextInput
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') search();
          }}
          placeholder="Ask a research question…"
          aria-label="Research question"
          disabled={busy}
        />
        <Button variant="primary" icon="search" onClick={search} disabled={busy || !query.trim()}>
          {busy ? 'Gathering evidence…' : 'Search'}
        </Button>
      </div>

      {error && (
        <div className="notice-card error glass mat-2" role="alert">
          <div className="notice-head">
            <Icon name="alert" size={14} />
            <span className="notice-title">{error.code.replaceAll('_', ' ').toLowerCase()}</span>
          </div>
          <p>{error.message}</p>
          {error.detail && (
            <ul className="notice-list">
              {error.detail.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {results && results.sources.length > 0 && (
        <div className="research-results" data-testid="research-results">
          <div className="research-results-head">
            <span>{results.sources.length} sourced result(s) · retrieved {new Date(results.retrieved_at).toLocaleString()}</span>
            <Button
              variant="primary"
              icon="check"
              onClick={propose}
              disabled={proposing || proposedFor === results.query.question}
            >
              {proposedFor === results.query.question ? 'Proposed — review in conversation' : proposing ? 'Preparing proposal…' : 'Propose recording in Idea State'}
            </Button>
          </div>
          {results.sources.map((src, i) => (
            <div key={i} className="research-source glass mat-2">
              <div className="research-source-title">
                <span className="chip chip-source">{src.source_type}</span>
                <a href={src.url} target="_blank" rel="noreferrer noopener">{src.title}</a>
              </div>
              {src.publication_date && <div className="muted">{src.publication_date}</div>}
              {src.excerpt && <p className="research-excerpt">{src.excerpt}</p>}
              <div className="research-source-url muted">{src.url}</div>
            </div>
          ))}
          <p className="muted research-note">
            <Icon name="info" size={12} /> Sources come from the configured research provider — not from the model.
            Accepting the proposal records the QUESTION; verify the sources yourself before relying on them.
          </p>
        </div>
      )}

      {questions.length === 0 && openForResearch.length === 0 ? (
        <div className="view-empty">
          <Icon name="research" size={20} />
          <p>No research questions yet.</p>
          <p className="muted">
            As the idea develops, unknowns worth investigating appear here.
          </p>
        </div>
      ) : (
        <div className="research-list">
          {questions.map((r) => (
            <div key={r.id} className="research-item glass mat-2">
              <div className="research-q">{r.question}</div>
              {r.rationale && <p className="muted">{r.rationale}</p>}
              <div className="sp-item-meta">
                <span className={cn('chip', `chip-${r.priority}`)}>{r.priority}</span>
                <span className="chip">{r.status}</span>
                <span className="sp-item-id">{r.id}</span>
              </div>
            </div>
          ))}
          {openForResearch.map((q) => (
            <div key={q.id} className="research-item glass mat-2">
              <div className="research-q">{q.text}</div>
              <div className="sp-item-meta">
                <span className="chip chip-high">for research</span>
                <span className="sp-item-id">{q.id}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      <p className="research-note muted">
        <Icon name="info" size={12} />{' '}
        {researchConfigured
          ? 'A research provider is configured: searches return real, sourced results. Model statements are never shown as evidence (§17).'
          : 'No research provider is configured in this Ideno instance, so external search is unavailable — it fails explicitly rather than presenting model statements as sourced evidence.'}
      </p>
    </div>
  );
}
