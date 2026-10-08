import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatEvent, ChatMessage } from '../shared/chat.js';
import type { StoredProposal } from '../shared/schemas/proposal.js';
import type { IdeaCase } from '../shared/schemas/ideaCase.js';
import type { RedactedConfig } from '../shared/config.js';
import {
  fetchCaseState,
  fetchConfig,
  fetchHealth,
  streamChat,
  acceptProposal,
  rejectProposal,
  resetCase,
  type CaseStateResponse,
  type HealthResponse,
} from './api';
import { Markdownish } from './components/Markdownish';
import { ProposalCard } from './components/ProposalCard';
import { StatePanel } from './components/StatePanel';
import { VersionsPanel } from './components/VersionsPanel';

interface TurnError {
  code: string;
  message: string;
  detail?: string[];
  recoverable?: boolean;
}

export function App() {
  const [caseData, setCaseData] = useState<IdeaCase | null>(null);
  const [versions, setVersions] = useState<CaseStateResponse['versions']>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [proposals, setProposals] = useState<Map<string, StoredProposal>>(new Map());
  const [config, setConfig] = useState<(RedactedConfig & { startup_notes: string[] }) | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [loadWarnings, setLoadWarnings] = useState<string[]>([]);

  const [input, setInput] = useState('');
  const [streamText, setStreamText] = useState('');
  const [phase, setPhase] = useState<string | null>(null);
  const [streamProposal, setStreamProposal] = useState<StoredProposal | null>(null);
  const [turnError, setTurnError] = useState<TurnError | null>(null);
  const [invalidNotice, setInvalidNotice] = useState<{ errors: string[]; summary?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyProposal, setBusyProposal] = useState<string | null>(null);
  const [tab, setTab] = useState<'state' | 'versions'>('state');
  const [banner, setBanner] = useState<string | null>(null);

  const chatEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    try {
      const state = await fetchCaseState();
      setCaseData(state.case);
      setVersions(state.versions);
      setMessages(state.messages);
      setProposals(new Map(state.proposals.map((p) => [p.id, p])));
      setLoadWarnings(state.load_warnings);
    } catch (err) {
      setBanner(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    refresh();
    fetchConfig().then(setConfig).catch(() => undefined);
    fetchHealth().then(setHealth).catch(() => undefined);
  }, [refresh]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, streamText, streamProposal, turnError, invalidNotice]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    setBusy(true);
    setStreamText('');
    setStreamProposal(null);
    setTurnError(null);
    setInvalidNotice(null);
    setPhase('routing');
    setMessages((prev) => [
      ...prev,
      { id: `local-${Date.now()}`, role: 'user', content: text, created_at: new Date().toISOString() },
    ]);

    const abort = new AbortController();
    abortRef.current = abort;

    try {
      await streamChat(
        text,
        (event: ChatEvent) => {
          handleEvent(event);
        },
        abort.signal,
      );
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        setTurnError({ code: 'NETWORK', message: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      setBusy(false);
      setPhase(null);
      abortRef.current = null;
      // Refresh authoritative state (messages, proposals) after each turn.
      refresh();
    }
  };

  const handleEvent = (event: ChatEvent) => {
    switch (event.type) {
      case 'status':
        setPhase(event.phase);
        return;
      case 'token':
        setStreamText((prev) => prev + event.text);
        return;
      case 'reply':
        setStreamText(event.text);
        return;
      case 'proposal':
        setStreamProposal(event.proposal);
        return;
      case 'proposal_invalid':
        setInvalidNotice({ errors: event.errors, summary: event.reasoning_summary });
        return;
      case 'error':
        setTurnError(event.error);
        return;
      case 'done':
        return;
    }
  };

  const onAccept = async (id: string) => {
    setBusyProposal(id);
    try {
      await acceptProposal(id);
      await refresh();
    } catch (err) {
      setBanner(err instanceof Error ? err.message : String(err));
      await refresh();
    } finally {
      setBusyProposal(null);
    }
  };

  const onReject = async (id: string) => {
    setBusyProposal(id);
    try {
      await rejectProposal(id);
      await refresh();
    } catch (err) {
      setBanner(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyProposal(null);
    }
  };

  const onReset = async () => {
    setBusy(true);
    try {
      await resetCase();
      await refresh();
    } catch (err) {
      setBanner(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const provider = health?.providers.find((p) => p.health.ok) ?? health?.providers[0];
  const demoActive = config?.providers.some((p) => p.is_demo) ?? false;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">◆</span>
          <span className="brand-name">Ideno</span>
          <span className="brand-sub">idea development system</span>
        </div>
        <div className="topbar-case">
          {caseData && (
            <>
              <span className="case-name">{caseData.title}</span>
              <span className="version-chip">v{caseData.version}</span>
            </>
          )}
        </div>
        <div className="topbar-right">
          {provider && (
            <span className={`provider-pill ${provider.health.ok ? 'ok' : 'bad'}`} title={provider.health.detail}>
              <span className="dot" />
              {provider.is_demo && <span className="demo-tag">DEMO</span>}
              {provider.display_name}
              <span className="provider-model">{provider.model}</span>
            </span>
          )}
          {config && <span className="privacy-chip" title="Privacy mode — what data may leave your machine">{config.privacy_mode}</span>}
          <button className="btn ghost small" onClick={onReset} disabled={busy} title="Archive this idea and start fresh">
            New idea
          </button>
        </div>
      </header>

      {banner && (
        <div className="banner error">
          <span>{banner}</span>
          <button className="btn ghost small" onClick={() => setBanner(null)}>
            dismiss
          </button>
        </div>
      )}
      {demoActive && (
        <div className="banner demo">
          Demo mode: the scripted demo provider is active — it is <strong>not an AI model</strong>. Configure a real
          provider in <code>config/ideno.config.json</code> (see <code>config/ideno.config.example.json</code>).
        </div>
      )}
      {loadWarnings.length > 0 && (
        <div className="banner warn">
          {loadWarnings.map((w, i) => (
            <span key={i}>{w}</span>
          ))}
        </div>
      )}

      <main className="main">
        <section className="chat-pane">
          <div className="messages">
            {messages.length === 0 && !busy && <Welcome />}
            {messages.map((msg) => (
              <Message key={msg.id} message={msg} proposal={msg.proposal_id ? proposals.get(msg.proposal_id) : undefined}
                onAccept={onAccept} onReject={onReject} busyProposal={busyProposal} />
            ))}
            {busy && (
              <div className="msg assistant streaming">
                {streamText ? <Markdownish text={streamText} /> : <em className="muted">{phaseLabel(phase)}</em>}
                {streamProposal && (
                  <ProposalCard proposal={streamProposal} onAccept={onAccept} onReject={onReject} busy={busyProposal !== null} />
                )}
                {invalidNotice && <InvalidNotice notice={invalidNotice} />}
                {turnError && <ErrorCard error={turnError} />}
              </div>
            )}
            <div ref={chatEndRef} />
          </div>
          <div className="composer">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder={busy ? 'Ideno is working…' : 'Describe your idea, add constraints, ask for alternatives…'}
              disabled={busy}
              rows={2}
            />
            <button className="btn primary" onClick={send} disabled={busy || !input.trim()}>
              Send
            </button>
            {busy && (
              <button
                className="btn ghost"
                onClick={() => abortRef.current?.abort()}
                title="Cancel generation"
              >
                Stop
              </button>
            )}
          </div>
        </section>

        <aside className="state-pane">
          <div className="tabs">
            <button className={`tab ${tab === 'state' ? 'active' : ''}`} onClick={() => setTab('state')}>
              Idea State
            </button>
            <button className={`tab ${tab === 'versions' ? 'active' : ''}`} onClick={() => setTab('versions')}>
              Versions {versions.length > 0 && <span className="tab-count">{versions.length}</span>}
            </button>
          </div>
          <div className="state-scroll">
            {caseData && tab === 'state' && <StatePanel caseData={caseData} />}
            {tab === 'versions' && <VersionsPanel versions={versions} />}
          </div>
        </aside>
      </main>
    </div>
  );
}

function Welcome() {
  return (
    <div className="welcome">
      <h1>Develop your idea.</h1>
      <p>
        Describe a rough idea. Ideno structures it into an evolving <strong>Idea State</strong> — goals,
        requirements, constraints, assumptions, unknowns, alternatives, decisions — and helps you develop it
        step by step. Every state change is proposed for your review; you accept or reject it.
      </p>
      <p className="muted">Try: “I want to build a small autonomous greenhouse.”</p>
    </div>
  );
}

function Message({
  message,
  proposal,
  onAccept,
  onReject,
  busyProposal,
}: {
  message: ChatMessage;
  proposal?: StoredProposal;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  busyProposal: string | null;
}) {
  if (message.role === 'system') {
    return (
      <div className="msg system">
        <span>{message.content}</span>
      </div>
    );
  }
  return (
    <div className={`msg ${message.role}`}>
      <div className="msg-role">{message.role === 'user' ? 'You' : 'Ideno'}</div>
      <div className="msg-body">
        <Markdownish text={message.content} />
        {proposal && (
          <ProposalCard proposal={proposal} onAccept={onAccept} onReject={onReject} busy={busyProposal !== null} />
        )}
      </div>
    </div>
  );
}

function InvalidNotice({ notice }: { notice: { errors: string[]; summary?: string } }) {
  return (
    <div className="proposal-card status-invalid">
      <div className="proposal-head">
        <span className="proposal-title">PROPOSAL REJECTED AUTOMATICALLY</span>
        <span className="proposal-status status-badge-invalid">invalid</span>
      </div>
      <p className="muted">
        The model proposed state changes that failed semantic validation. The Idea State was not modified.
      </p>
      <ul className="error-list">
        {notice.errors.map((e, i) => (
          <li key={i}>{e}</li>
        ))}
      </ul>
      {notice.summary && <p className="proposal-reasoning">Reasoning summary: {notice.summary}</p>}
    </div>
  );
}

function ErrorCard({ error }: { error: TurnError }) {
  return (
    <div className="error-card">
      <div className="error-code">{error.code}</div>
      <p>{error.message}</p>
      {error.detail && (
        <ul>
          {error.detail.map((d, i) => (
            <li key={i}>{d}</li>
          ))}
        </ul>
      )}
      {error.recoverable && <p className="muted">This error is recoverable — you can try sending the message again.</p>}
    </div>
  );
}

function phaseLabel(phase: string | null): string {
  switch (phase) {
    case 'routing':
      return 'Selecting model…';
    case 'generating':
      return 'Ideno is thinking…';
    case 'validating':
      return 'Validating proposed changes…';
    default:
      return 'Working…';
  }
}
