import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatEvent, ChatMessage } from '../shared/chat.js';
import type { StoredProposal } from '../shared/schemas/proposal.js';
import type { IdeaCase, CollectionKey } from '../shared/schemas/ideaCase.js';
import type { RedactedConfig } from '../shared/config.js';
import {
  fetchCaseState,
  fetchConfig,
  fetchHealth,
  streamChat,
  acceptProposal,
  rejectProposal,
  resetCase,
  initApiMode,
  readApiBase,
  type CaseStateResponse,
  type HealthResponse,
  type ApiMode,
} from './api';
import { Icon, type IconName } from './components/icons.js';
import { Button, Dot, IconButton, Kbd, Pill, Sheet, cn, useClickOutside } from './components/glass.js';
import { Conversation, type TurnErrorShape } from './components/Conversation';
import { StatePanel, type DetailTarget } from './components/StatePanel';
import { HistoryView } from './views/HistoryView';
import { ConstellationView } from './views/ConstellationView';
import { ResearchView } from './views/ResearchView';
import { SettingsView } from './views/SettingsView';
import { CommandPalette, type PaletteCommand, type PaletteResult } from './components/CommandPalette';
import { Toasts, type Toast } from './components/Toasts';
import {
  nextAppearance,
  readStateWidth,
  useAppearance,
  useMediaQuery,
  writeStateWidth,
  type Appearance,
} from './theme';

/**
 * Ideno application shell.
 *
 * Spatial layout (§7): floating glass top bar, navigation rail, main
 * workspace, and the Idea State pane — layered surfaces on an ambient
 * environment, not rigid dashboard columns. The pane is resizable on wide
 * screens (§33) and becomes an overlay sheet on narrow ones (§32).
 */

type View = 'workspace' | 'constellation' | 'research' | 'history' | 'settings';

const VIEW_META: Record<View, { label: string; icon: IconName }> = {
  workspace: { label: 'Workspace', icon: 'workspace' },
  constellation: { label: 'Map', icon: 'orbit' },
  research: { label: 'Research', icon: 'research' },
  history: { label: 'History', icon: 'history' },
  settings: { label: 'Settings', icon: 'settings' },
};

const MAX_USER_MESSAGE_CHARS = 20_000;

export function App() {
  /* ---- data ---- */
  const [caseData, setCaseData] = useState<IdeaCase | null>(null);
  const [versions, setVersions] = useState<CaseStateResponse['versions']>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [proposals, setProposals] = useState<Map<string, StoredProposal>>(new Map());
  const [config, setConfig] = useState<(RedactedConfig & { startup_notes: string[] }) | null>(null);
  const [apiMode, setApiMode] = useState<ApiMode | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadWarnings, setLoadWarnings] = useState<string[]>([]);

  /* ---- ui ---- */
  const [view, setView] = useState<View>('workspace');
  const [stateOpen, setStateOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [detail, setDetail] = useState<DetailTarget | null>(null);
  const [highlightKeys, setHighlightKeys] = useState<Set<string>>(new Set());
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [appearance, setAppearance] = useAppearance();
  const [stateWidth, setStateWidth] = useState(readStateWidth);
  const [testing, setTesting] = useState(false);
  const [runtimeOpen, setRuntimeOpen] = useState(false);

  const narrow = useMediaQuery('(max-width: 1180px)');
  const compact = useMediaQuery('(max-width: 900px)');

  /* ---- chat stream ---- */
  const [busy, setBusy] = useState(false);
  const [deep, setDeep] = useState(false);
  const [phase, setPhase] = useState<string | null>(null);
  const [streamText, setStreamText] = useState('');
  const [streamProposal, setStreamProposal] = useState<StoredProposal | null>(null);
  const [invalidNotice, setInvalidNotice] = useState<{ errors: string[]; summary?: string } | null>(null);
  const [turnError, setTurnError] = useState<TurnErrorShape | null>(null);
  const [busyProposal, setBusyProposal] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const notify = useCallback((kind: Toast['kind'], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev.slice(-2), { id, kind, text }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3600);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const state = await fetchCaseState();
      setCaseData(state.case);
      setVersions(state.versions);
      setMessages(state.messages);
      setProposals(new Map(state.proposals.map((p) => [p.id, p])));
      setLoadWarnings(state.load_warnings);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const testConnection = useCallback(async () => {
    setTesting(true);
    try {
      const next = await fetchHealth();
      setHealth(next);
      const anyOk = next.providers.some((p) => p.health.ok);
      notify(anyOk ? 'ok' : 'error', anyOk ? 'Runtime reachable' : 'No reachable provider');
    } catch (err) {
      notify('error', err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  }, [notify]);

  useEffect(() => {
    let alive = true;
    initApiMode()
      .then((mode) => {
        if (!alive) return;
        setApiMode(mode);
        refresh();
        fetchConfig().then(setConfig).catch(() => undefined);
        fetchHealth().then(setHealth).catch(() => undefined);
      })
      .catch(() => setApiMode('demo'));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---- highlight affected state after acceptance (§45, §46) ---- */
  const highlight = useCallback((keys: string[]) => {
    if (keys.length === 0) return;
    setHighlightKeys(new Set(keys));
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => setHighlightKeys(new Set()), 3200);
  }, []);

  const revealState = useCallback(
    (section?: string) => {
      if (narrow) setStateOpen(true);
      if (section) highlight([section]);
    },
    [narrow, highlight],
  );

  /* ---- conversation ---- */
  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim().slice(0, MAX_USER_MESSAGE_CHARS);
      if (!trimmed || busy) return;
      setBusy(true);
      setStreamText('');
      setStreamProposal(null);
      setTurnError(null);
      setInvalidNotice(null);
      setPhase('routing');
      setMessages((prev) => [
        ...prev,
        { id: `local-${Date.now()}`, role: 'user', content: trimmed, created_at: new Date().toISOString() },
      ]);

      const abort = new AbortController();
      abortRef.current = abort;

      try {
        await streamChat(
          trimmed,
          (event: ChatEvent) => {
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
          },
          abort.signal,
          { deep },
        );
      } catch (err) {
        if (!(err instanceof DOMException && err.name === 'AbortError')) {
          setTurnError({ code: 'NETWORK', message: err instanceof Error ? err.message : String(err) });
        }
      } finally {
        setBusy(false);
        setPhase(null);
        abortRef.current = null;
        refresh();
      }
    },
    [busy, deep, refresh],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const onAccept = useCallback(
    async (id: string) => {
      setBusyProposal(id);
      try {
        const { version } = await acceptProposal(id);
        notify('ok', `Version ${version.number} created`);
        const state = await fetchCaseState();
        setCaseData(state.case);
        setVersions(state.versions);
        setMessages(state.messages);
        setProposals(new Map(state.proposals.map((p) => [p.id, p])));
        // Link conversation → state (§46): pulse everything this acceptance touched.
        const accepted = state.proposals.find((p) => p.id === id);
        const keys = Object.keys(accepted?.proposal.changes ?? {}).filter((k) => {
          const ch = (accepted?.proposal.changes as Record<
            string,
            { added: unknown[]; modified: unknown[] }
          >)[k];
          return ch && ((ch.added?.length ?? 0) > 0 || (ch.modified?.length ?? 0) > 0);
        });
        highlight(keys);
        revealState();
      } catch (err) {
        notify('error', err instanceof Error ? err.message : String(err));
        await refresh();
      } finally {
        setBusyProposal(null);
      }
    },
    [highlight, notify, refresh, revealState],
  );

  const onReject = useCallback(
    async (id: string) => {
      setBusyProposal(id);
      try {
        await rejectProposal(id);
        notify('info', 'Change rejected — state unchanged');
        await refresh();
      } catch (err) {
        notify('error', err instanceof Error ? err.message : String(err));
        await refresh();
      } finally {
        setBusyProposal(null);
      }
    },
    [notify, refresh],
  );

  const doReset = useCallback(async () => {
    setResetOpen(false);
    setBusy(true);
    try {
      await resetCase();
      await refresh();
      setDetail(null);
      setView('workspace');
      notify('info', 'New idea started — previous case archived');
    } catch (err) {
      notify('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [notify, refresh]);

  /* ---- keyboard (§34) ---- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 'h') {
        e.preventDefault();
        setView('history');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /* ---- palette search index (§48) ---- */
  const searchIndex = useMemo<PaletteResult[]>(() => {
    const out: PaletteResult[] = [];
    if (!caseData) return out;
    const sections: Array<[CollectionKey, string, IconName]> = [
      ['goals', 'Goal', 'compass'],
      ['requirements', 'Requirement', 'check'],
      ['constraints', 'Constraint', 'shield'],
      ['assumptions', 'Assumption', 'info'],
      ['unknowns', 'Unknown', 'alert'],
      ['risks', 'Risk', 'alert'],
      ['dependencies', 'Dependency', 'state'],
      ['evidence', 'Evidence', 'inspect'],
      ['research_items', 'Research', 'research'],
      ['alternatives', 'Alternative', 'layers'],
      ['decisions', 'Decision', 'bolt'],
      ['open_questions', 'Question', 'research'],
    ];
    for (const [collection, kind, icon] of sections) {
      for (const item of caseData[collection]) {
        const title = String(
          (item as Record<string, unknown>).text ??
          (item as Record<string, unknown>).claim ??
          (item as Record<string, unknown>).decision ??
          (item as Record<string, unknown>).question ??
          (item as Record<string, unknown>).name ??
          item.id,
        );
        out.push({
          id: `item-${item.id}`,
          kind,
          title,
          icon,
          run: () => {
            setDetail({ collection, id: item.id });
            // On narrow screens the state pane (which hosts the detail sheet)
            // is an overlay — make sure it is visible before opening details.
            revealState();
          },
        });
      }
    }
    for (const v of versions) {
      out.push({
        id: `ver-${v.number}`,
        kind: 'Version',
        title: `v${v.number} — ${v.summary || 'state updated'}`,
        icon: 'history',
        run: () => setView('history'),
      });
    }
    for (const m of messages) {
      if (m.role === 'system') continue;
      out.push({
        id: `msg-${m.id}`,
        kind: m.role === 'user' ? 'You said' : 'Ideno said',
        title: m.content.slice(0, 90),
        icon: m.role === 'user' ? 'user' : 'sparkle',
        run: () => {
          setView('workspace');
          window.setTimeout(() => {
            document.getElementById(`msg-${m.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }, 60);
        },
      });
    }
    return out;
  }, [caseData, versions, messages, revealState]);

  const commands = useMemo<PaletteCommand[]>(() => {
    const cmds: PaletteCommand[] = [
      {
        id: 'focus-composer',
        label: 'Focus composer',
        icon: 'send',
        hint: 'write to Ideno',
        run: () => {
          setView('workspace');
          window.setTimeout(() => window.dispatchEvent(new CustomEvent('ideno:focus-composer')), 60);
        },
      },
    ];
    const sections: Array<[string, string]> = [
      ['constraints', 'Show constraints'],
      ['evidence', 'Show evidence'],
      ['alternatives', 'Show alternatives'],
      ['decisions', 'Show decisions'],
      ['unknowns', 'Show unknowns'],
    ];
    for (const [key, label] of sections) {
      cmds.push({
        id: `show-${key}`,
        label,
        icon: 'state',
        keywords: 'idea state section reveal',
        run: () => revealState(key),
      });
    }
    cmds.push(
      { id: 'history', label: 'View history', icon: 'history', hint: '⌘⇧H', run: () => setView('history') },
      { id: 'research', label: 'Open research', icon: 'research', run: () => setView('research') },
      { id: 'settings', label: 'Open settings', icon: 'settings', run: () => setView('settings') },
      {
        id: 'appearance',
        label: 'Toggle appearance',
        icon: 'sun',
        hint: appearance,
        keywords: 'theme light dark system',
        run: () => setAppearance(nextAppearance(appearance)),
      },
      { id: 'new-idea', label: 'New idea', icon: 'plus', keywords: 'reset archive', run: () => setResetOpen(true) },
    );
    return cmds;
  }, [appearance, revealState, setAppearance]);

  /* ---- resizable state pane (§33) ---- */
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = stateWidth;
    const move = (ev: PointerEvent) => {
      const w = Math.min(620, Math.max(320, startW + (startX - ev.clientX)));
      setStateWidth(w);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      writeStateWidth(stateWidthRef.current);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const stateWidthRef = useRef(stateWidth);
  stateWidthRef.current = stateWidth;

  const runtimeProvider = useMemo(() => {
    if (!health) return null;
    const routed = health.routing.find((r) => r.eligible);
    const byId = new Map(health.providers.map((p) => [p.id, p]));
    return (routed && byId.get(routed.providerId)) ?? health.providers[0] ?? null;
  }, [health]);

  const demoActive = config?.providers.some((p) => p.is_demo) ?? false;
  const navItems: Array<{ key: View | 'state'; label: string; icon: IconName }> = narrow
    ? [
        { key: 'workspace', ...VIEW_META.workspace },
        { key: 'constellation', ...VIEW_META.constellation },
        { key: 'state', label: 'Idea State', icon: 'state' },
        { key: 'research', ...VIEW_META.research },
        { key: 'history', ...VIEW_META.history },
        { key: 'settings', ...VIEW_META.settings },
      ]
    : (Object.keys(VIEW_META) as View[]).map((key) => ({ key, ...VIEW_META[key] }));

  if (loadError && !caseData) {
    return (
      <div className="app app-error">
        <div className="error-state glass mat-3">
          <Icon name="alert" size={22} />
          <h1>Runtime unavailable</h1>
          <p className="muted">{loadError}</p>
          <Button variant="primary" icon="refresh" onClick={() => { setLoadError(null); refresh(); }}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="topbar glass mat-1" role="banner">
        <div className="topbar-brand" onClick={() => setView('workspace')} role="button" tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter') setView('workspace'); }}>
          <Icon name="logo" size={20} className="brand-mark" />
          <span className="brand-name">Ideno</span>
        </div>
        <div className="topbar-idea">
          {caseData && (
            <>
              <span className="topbar-title">{caseData.title}</span>
              <span className="version-chip">v{caseData.version}</span>
            </>
          )}
        </div>
        <div className="topbar-actions">
          <button
            className="iconbtn searchbtn"
            onClick={() => setPaletteOpen(true)}
            aria-label="Search and commands"
            title="Search and commands (⌘K)"
          >
            <Icon name="search" size={15} />
            {!compact && <Kbd>⌘K</Kbd>}
          </button>
          <RuntimePill provider={runtimeProvider} privacy={config?.privacy_mode} open={runtimeOpen} setOpen={setRuntimeOpen} />
          <IconButton
            label={`Appearance: ${appearance}`}
            icon={appearance === 'light' ? 'sun' : appearance === 'dark' ? 'moon' : 'monitor'}
            onClick={() => setAppearance(nextAppearance(appearance))}
          />
          <IconButton label="New idea" icon="plus" onClick={() => setResetOpen(true)} />
        </div>
      </header>

      {apiMode === 'demo' && (
          <div className="banner offline" role="note" data-testid="offline-banner">
            <Icon name="alert" size={13} />
            <span>
              <strong>Offline demo</strong> — no server connected. The real state machine runs in
              your browser with a scripted provider (not an AI); nothing is saved and everything
              resets on reload. {readApiBase() ? '' : 'Connect to a server in Settings → Connection for full functionality.'}
            </span>
          </div>
        )}
        {demoActive && (
        <div className="banner demo" role="note">
          <Icon name="info" size={13} />
          <span>
            Demo mode — the scripted provider is <strong>not an AI model</strong>. Configure a real
            provider in <code>config/ideno.config.json</code>.
          </span>
        </div>
      )}
      {loadWarnings.length > 0 && (
        <div className="banner warn" role="note">
          <Icon name="alert" size={13} />
          <span>{loadWarnings.join(' · ')}</span>
        </div>
      )}

      <div
        className="app-body"
        style={narrow ? undefined : ({ '--state-w': `${stateWidth}px` } as React.CSSProperties)}
      >
        {!compact && (
          <nav className="navrail glass mat-1" aria-label="Primary">
            {navItems.map((item) =>
              item.key === 'state' ? (
                <button
                  key={item.key}
                  className={cn('navitem', stateOpen && 'active')}
                  onClick={() => setStateOpen((v) => !v)}
                  aria-current={stateOpen ? 'page' : undefined}
                >
                  <Icon name={item.icon} size={16} />
                  <span>{item.label}</span>
                </button>
              ) : (
                <button
                  key={item.key}
                  className={cn('navitem', view === item.key && 'active')}
                  onClick={() => setView(item.key as View)}
                  aria-current={view === item.key ? 'page' : undefined}
                >
                  <Icon name={item.icon} size={16} />
                  <span>{item.label}</span>
                </button>
              ),
            )}
            <div className="navrail-foot">
              <span className="navrail-hint muted">
                <Kbd>⌘K</Kbd> commands
              </span>
            </div>
          </nav>
        )}

        <main className="workspace glass mat-1" aria-label="Main workspace">
          {view === 'workspace' && caseData && (
            <Conversation
              caseData={caseData}
              messages={messages}
              proposals={proposals}
              busy={busy}
              phase={phase}
              streamText={streamText}
              streamProposal={streamProposal}
              invalidNotice={invalidNotice}
              turnError={turnError}
              busyProposal={busyProposal}
              onSend={send}
              onAccept={onAccept}
              onReject={onReject}
              onStop={stop}
              deep={deep}
              onDeepChange={setDeep}
            />
          )}
          {view === 'constellation' && caseData && (
            <ConstellationView
              caseData={caseData}
              onOpenItem={(collection, id) => {
                setDetail({ collection, id });
                revealState();
              }}
            />
          )}
          {view === 'research' && caseData && (
            <ResearchView
              caseData={caseData}
              researchConfigured={config?.research_provider_configured === true}
              onProposed={() => {
                void refresh();
                setView('workspace');
              }}
            />
          )}
          {view === 'history' && <HistoryView versions={versions} />}
          {view === 'settings' && (
            <SettingsView
              appearance={appearance}
              onAppearance={setAppearance}
              config={config}
              health={health}
              onTestConnection={testConnection}
              testing={testing}
              onReset={() => setResetOpen(true)}
            />
          )}
        </main>

        {!narrow && <div className="resizer" onPointerDown={startResize} role="separator" aria-orientation="vertical" aria-label="Resize Idea State pane" />}

        {(narrow ? stateOpen : true) && caseData && (
          <>
            {narrow && <div className="sheet-backdrop state-backdrop" onClick={() => setStateOpen(false)} aria-hidden="true" />}
            <aside className={cn('statepane glass mat-1', narrow && 'overlay')} aria-label="Idea State">
              <div className="statepane-head">
                <span className="statepane-title">
                  <Icon name="state" size={14} /> Idea State
                </span>
                {narrow && <IconButton label="Close Idea State" icon="close" onClick={() => setStateOpen(false)} />}
              </div>
              <StatePanel
                caseData={caseData}
                highlightKeys={highlightKeys}
                detail={detail}
                onDetailChange={setDetail}
              />
            </aside>
          </>
        )}
      </div>

      {compact && (
        <nav className="tabbar glass mat-3" aria-label="Primary">
          {navItems.map((item) =>
            item.key === 'state' ? (
              <button
                key={item.key}
                className={cn('tabitem', stateOpen && 'active')}
                onClick={() => setStateOpen(true)}
                aria-label="Idea State"
              >
                <Icon name={item.icon} size={19} />
                <span>State</span>
              </button>
            ) : (
              <button
                key={item.key}
                className={cn('tabitem', view === item.key && !stateOpen && 'active')}
                onClick={() => {
                  setStateOpen(false);
                  setView(item.key as View);
                }}
                aria-current={view === item.key && !stateOpen ? 'page' : undefined}
              >
                <Icon name={item.icon} size={19} />
                <span>{item.label}</span>
              </button>
            ),
          )}
        </nav>
      )}

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
        searchIndex={searchIndex}
      />

      <Sheet open={resetOpen} onClose={() => setResetOpen(false)} title="New idea" variant={compact ? 'bottom' : 'center'}>
        <p>Start a new idea?</p>
        <p className="muted">
          The current case — versions, messages, and proposals — is archived on disk. Nothing is
          deleted.
        </p>
        <div className="sheet-actions">
          <Button variant="ghost" onClick={() => setResetOpen(false)}>Cancel</Button>
          <Button variant="danger" icon="plus" onClick={doReset}>Start new idea</Button>
        </div>
      </Sheet>

      <Toasts toasts={toasts} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function RuntimePill({
  provider,
  privacy,
  open,
  setOpen,
}: {
  provider: HealthResponse['providers'][number] | null;
  privacy?: string;
  open: boolean;
  setOpen: (v: boolean) => void;
}) {
  const ref = useClickOutside<HTMLDivElement>(open, () => setOpen(false));
  if (!provider) return null;
  return (
    <div className="runtime-wrap" ref={ref}>
      <button
        className={cn('runtime-pill', provider.health.ok ? 'ok' : 'bad')}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="AI runtime"
      >
        <Dot className={provider.health.ok ? 'ok' : 'bad'} />
        {!provider.is_demo && <span className="runtime-pill-name">{provider.display_name}</span>}
        {provider.is_demo && <span className="demo-tag">DEMO</span>}
        <span className="runtime-pill-model">{provider.model}</span>
      </button>
      {open && (
        <div className="runtime-pop glass mat-3" role="dialog" aria-label="Runtime details">
          <div className="runtime-pop-head">
            <span className="runtime-name">{provider.display_name}</span>
            <span className={cn('runtime-status', provider.health.ok ? 'ok' : 'bad')}>
              {provider.health.ok ? 'Connected' : 'Unreachable'}
            </span>
          </div>
          <dl className="runtime-grid">
            <div>
              <dt>Model</dt>
              <dd className="mono">{provider.model}</dd>
            </div>
            <div>
              <dt>Privacy</dt>
              <dd>
                {provider.privacy === 'local' ? 'Local' : 'Cloud'}{privacy ? ` · ${privacy}` : ''}
              </dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{provider.health.detail}</dd>
            </div>
          </dl>
          <p className="muted runtime-detail">
            Runtime selection is a configuration setting — see Settings or{' '}
            <code>config/ideno.config.json</code>.
          </p>
        </div>
      )}
    </div>
  );
}

export type { Appearance };
