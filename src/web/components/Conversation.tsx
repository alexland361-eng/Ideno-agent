import React, { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../../shared/chat.js';
import type { StoredProposal } from '../../shared/schemas/proposal.js';
import type { IdeaCase } from '../../shared/schemas/ideaCase.js';
import { Icon } from './icons.js';
import { Button, IconButton, cn } from './glass.js';
import { Markdownish } from './Markdownish.js';
import { ProposalCard } from './ProposalCard.js';

/**
 * The main workspace conversation (§10, §11).
 *
 * Semantic message types are visually distinct: user input, Ideno response,
 * state proposals, and system events are different objects — not one chat
 * stream with different colors.
 */

export interface TurnErrorShape {
  code: string;
  message: string;
  detail?: string[];
  recoverable?: boolean;
}

export interface ConversationProps {
  /** Deep analysis: adversarial critique pass over the drafted proposal. */
  deep: boolean;
  onDeepChange: (deep: boolean) => void;
  caseData: IdeaCase | null;
  messages: ChatMessage[];
  proposals: Map<string, StoredProposal>;
  busy: boolean;
  phase: string | null;
  streamText: string;
  streamProposal: StoredProposal | null;
  invalidNotice: { errors: string[]; summary?: string } | null;
  turnError: TurnErrorShape | null;
  busyProposal: string | null;
  onSend: (text: string) => void;
  onStop: () => void;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
}

const EXAMPLE_IDEA = 'I want to build a small autonomous greenhouse.';

const PHASE_LABELS: Record<string, string> = {
  routing: 'Analyzing your message…',
  generating: 'Developing the idea…',
  validating: 'Re-evaluating affected state…',
  critiquing: 'Critiquing the draft (deep analysis)…',
};

export function Conversation(props: ConversationProps) {
  const { messages, busy, streamText, onSend } = props;
  const [input, setInput] = useState('');
  const scrollerRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const nearBottomRef = useRef(true);

  // Intelligent auto-scroll (§22): follow the stream only while the user is
  // already at the bottom; never fight the reader.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    if (nearBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, streamText, busy]);

  useEffect(() => {
    const focus = () => composerRef.current?.focus();
    window.addEventListener('ideno:focus-composer', focus);
    return () => window.removeEventListener('ideno:focus-composer', focus);
  }, []);

  const send = () => {
    const text = input.trim();
    if (!text || busy) return;
    onSend(text);
    setInput('');
    nearBottomRef.current = true;
  };

  const onComposerKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
  };

  const empty = messages.length === 0 && !busy;

  return (
    <div className="conversation">
      <div
        className="messages"
        ref={scrollerRef}
        onScroll={onScroll}
        aria-label="Conversation with Ideno"
      >
        {empty ? (
          <EmptyState onPick={(text) => { setInput(text); composerRef.current?.focus(); }} />
        ) : (
          <div className="messages-inner">
            {messages.map((msg) => (
              <Message
                key={msg.id}
                message={msg}
                proposal={msg.proposal_id ? props.proposals.get(msg.proposal_id) : undefined}
                onAccept={props.onAccept}
                onReject={props.onReject}
                busyProposal={props.busyProposal}
              />
            ))}
            {busy && (
              <div className="msg-streaming" aria-live="polite">
                {streamText ? (
                  <div className="msg ai">
                    <div className="msg-role">
                      <Icon name="sparkle" size={12} className="ai-mark" /> Ideno
                    </div>
                    <div className="bubble ai streaming-text">
                      <Markdownish text={streamText} />
                    </div>
                  </div>
                ) : (
                  <div className="phase-indicator">
                    <span className="phase-dots" aria-hidden="true">
                      <i /><i /><i />
                    </span>
                    <span className="phase-label">
                      {PHASE_LABELS[props.phase ?? ''] ?? 'Thinking…'}
                    </span>
                  </div>
                )}
                {props.streamProposal && (
                  <ProposalCard
                    proposal={props.streamProposal}
                    onAccept={props.onAccept}
                    onReject={props.onReject}
                    busy={props.busyProposal !== null}
                  />
                )}
              </div>
            )}
            {!busy && props.invalidNotice && <InvalidNotice notice={props.invalidNotice} />}
            {!busy && props.turnError && <ErrorCard error={props.turnError} />}
          </div>
        )}
      </div>

      <div className="composer-dock">
        <div className={cn('composer glass', busy && 'busy')}>
          <textarea
            ref={composerRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onComposerKey}
            placeholder={
              busy ? 'Ideno is working…' : 'Describe your idea, add a constraint, ask for alternatives…'
            }
            disabled={busy}
            rows={1}
            aria-label="Message to Ideno"
            onInput={(e) => {
              const el = e.currentTarget;
              el.style.height = 'auto';
              el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
            }}
          />
          <div className="composer-actions">
            <button
              className={cn('deep-toggle', props.deep && 'on')}
              onClick={() => props.onDeepChange(!props.deep)}
              disabled={busy}
              aria-pressed={props.deep}
              title="Deep analysis: after drafting, a second adversarial pass critiques the proposal before you review it"
            >
              <Icon name="inspect" size={13} />
              Deep
            </button>
            {busy ? (
              <IconButton label="Stop generating" icon="stop" className="send-btn stop" onClick={props.onStop} />
            ) : (
              <button
                className="send-btn"
                onClick={send}
                disabled={!input.trim()}
                aria-label="Send message"
                title="Send (Enter)"
              >
                <Icon name="send" size={17} />
              </button>
            )}
          </div>
        </div>
        <div className="composer-hint">Enter to send · Shift+Enter for a new line</div>
      </div>
    </div>
  );
}

function EmptyState({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="empty-state">
      <div className="empty-mark">
        <Icon name="sparkle" size={22} />
      </div>
      <h1>No idea yet.</h1>
      <p className="empty-lede">Give Ideno something rough.</p>
      <p className="empty-lines">
        A question.
        <br />
        A machine.
        <br />
        A project.
        <br />
        A strange thought.
      </p>
      <p className="empty-cta">Start anywhere.</p>
      <button className="empty-example" onClick={() => onPick(EXAMPLE_IDEA)}>
        “{EXAMPLE_IDEA}”
      </button>
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
      <div className="msg system" id={`msg-${message.id}`}>
        <span className="system-pill">{message.content}</span>
      </div>
    );
  }
  if (message.role === 'user') {
    return (
      <div className="msg user" id={`msg-${message.id}`}>
        <div className="bubble user">
          <Markdownish text={message.content} />
        </div>
      </div>
    );
  }
  return (
    <div className="msg ai" id={`msg-${message.id}`}>
      <div className="msg-role">
        <Icon name="sparkle" size={12} className="ai-mark" /> Ideno
      </div>
      <div className="bubble ai">
        <Markdownish text={message.content} />
      </div>
      {proposal && (
        <ProposalCard
          proposal={proposal}
          onAccept={onAccept}
          onReject={onReject}
          busy={busyProposal !== null}
        />
      )}
    </div>
  );
}

function InvalidNotice({ notice }: { notice: { errors: string[]; summary?: string } }) {
  return (
    <div className="notice-card invalid glass mat-2" role="alert">
      <div className="notice-head">
        <Icon name="shield" size={14} />
        <span className="notice-title">Proposal rejected automatically</span>
      </div>
      <p className="muted">
        The model proposed changes that failed validation. The Idea State was not modified.
      </p>
      <ul className="notice-list">
        {notice.errors.map((e, i) => (
          <li key={i}>{e}</li>
        ))}
      </ul>
      {notice.summary && <p className="notice-reason">Reasoning summary: {notice.summary}</p>}
    </div>
  );
}

function ErrorCard({ error }: { error: TurnErrorShape }) {
  return (
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
      {error.recoverable && <p className="muted">You can try sending the message again.</p>}
    </div>
  );
}
