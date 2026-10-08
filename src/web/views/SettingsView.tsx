import React, { useEffect, useState } from 'react';
import type { Appearance } from '../theme';
import type { RedactedConfig } from '../../shared/config.js';
import type { HealthResponse, ApiMode } from '../api';
import { getApiMode, readApiBase, writeApiBase, clearApiBase } from '../api';
import {
  getUserSettings, saveUserSettings, testUserProviders,
  type RedactedUserSettings, type UserSettingsInput,
} from '../api';
import {
  readSession, clearSession, ensureSession, signIn, signUp, signOut,
  type SessionUser,
} from '../auth';
import { Icon } from '../components/icons.js';
import { Button, Dot, Kbd, Pill, cn } from '../components/glass.js';

/**
 * Settings (§49, §50): grouped, native-feeling. Runtime information is
 * read-only and real — providers are configured in config/ideno.config.json
 * (the file is the source of truth; no credentials ever reach the browser).
 * "Test connection" performs a live health check.
 */

export function SettingsView({
  appearance,
  onAppearance,
  config,
  health,
  onTestConnection,
  testing,
  onReset,
}: {
  appearance: Appearance;
  onAppearance: (a: Appearance) => void;
  config: (RedactedConfig & { startup_notes?: string[] }) | null;
  health: HealthResponse | null;
  onTestConnection: () => void;
  testing: boolean;
  onReset: () => void;
}) {
  const providers = mergeProviders(config, health);

  return (
    <div className="settings-view">
      <div className="view-head">
        <h1>Settings</h1>
      </div>

      <AccountCard />
      <ConnectionCard />

      <section className="set-group glass mat-2" aria-label="Appearance">
        <div className="set-group-title">Appearance</div>
        <div className="set-row">
          <div>
            <div className="set-label">Theme</div>
            <div className="set-sub">Light, dark, or follow the system.</div>
          </div>
          <div className="segmented" role="radiogroup" aria-label="Theme">
            {(
              [
                ['light', 'sun', 'Light'],
                ['dark', 'moon', 'Dark'],
                ['system', 'monitor', 'System'],
              ] as const
            ).map(([value, icon, label]) => (
              <button
                key={value}
                role="radio"
                aria-checked={appearance === value}
                className={cn('seg', appearance === value && 'active')}
                onClick={() => onAppearance(value)}
              >
                <Icon name={icon} size={14} />
                <span>{label}</span>
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="set-group glass mat-2" aria-label="AI runtime">
        <div className="set-group-title">AI Runtime</div>
        {config && (
          <div className="set-row">
            <div>
              <div className="set-label">Privacy mode</div>
              <div className="set-sub">{PRIVACY_EXPLAIN[config.privacy_mode]}</div>
            </div>
            <Pill className="privacy-pill">
              <Icon name="shield" size={12} /> {config.privacy_mode}
            </Pill>
          </div>
        )}
        {providers.map((p) => (
          <div key={p.id} className="runtime-card">
            <div className="runtime-head">
              <Dot className={p.ok ? 'ok' : 'bad'} />
              <span className="runtime-name">{p.displayName}</span>
              {p.isDemo && <span className="demo-tag">DEMO</span>}
              <span className={cn('runtime-status', p.ok ? 'ok' : 'bad')}>
                {p.ok ? 'Connected' : 'Unreachable'}
                {p.latencyMs !== undefined ? ` · ${p.latencyMs}ms` : ''}
              </span>
            </div>
            <dl className="runtime-grid">
              <div>
                <dt>Model</dt>
                <dd className="mono">{p.model}</dd>
              </div>
              <div>
                <dt>Privacy</dt>
                <dd>{p.privacy === 'local' ? 'Local infrastructure' : 'Cloud — data leaves your machine'}</dd>
              </div>
              <div>
                <dt>Capabilities</dt>
                <dd>
                  {p.streaming ? '✓' : '✗'} streaming · structured output: {p.structuredOutput}
                </dd>
              </div>
              {p.origin && (
                <div>
                  <dt>Endpoint</dt>
                  <dd className="mono">{p.origin}</dd>
                </div>
              )}
              {p.routed && (
                <div>
                  <dt>Routing</dt>
                  <dd>{p.routed}</dd>
                </div>
              )}
            </dl>
            {!p.ok && p.detail && <p className="muted runtime-detail">{p.detail}</p>}
          </div>
        ))}
        <div className="set-row">
          <div>
            <div className="set-label">Connection</div>
            <div className="set-sub">Run a live health check against configured providers.</div>
          </div>
          <Button variant="secondary" icon="refresh" onClick={onTestConnection} disabled={testing}>
            {testing ? 'Testing…' : 'Test connection'}
          </Button>
        </div>
        <p className="muted set-note">
          Providers are configured in <code>config/ideno.config.json</code> — secrets stay in
          environment variables and never reach the browser. Verify a provider with{' '}
          <code>npm run provider:check</code>.
        </p>
      </section>

      <section className="set-group glass mat-2" aria-label="Keyboard">
        <div className="set-group-title">Keyboard</div>
        <div className="shortcut-list">
          <div className="shortcut">
            <span>Command palette</span>
            <span><Kbd>⌘</Kbd> <Kbd>K</Kbd></span>
          </div>
          <div className="shortcut">
            <span>Send message</span>
            <span><Kbd>Enter</Kbd></span>
          </div>
          <div className="shortcut">
            <span>New line in composer</span>
            <span><Kbd>⇧</Kbd> <Kbd>Enter</Kbd></span>
          </div>
          <div className="shortcut">
            <span>Close sheet / palette</span>
            <span><Kbd>Esc</Kbd></span>
          </div>
          <div className="shortcut">
            <span>History</span>
            <span><Kbd>⌘</Kbd> <Kbd>⇧</Kbd> <Kbd>H</Kbd></span>
          </div>
        </div>
      </section>

      <section className="set-group glass mat-2 danger-zone" aria-label="Data">
        <div className="set-group-title">Idea data</div>
        <div className="set-row">
          <div>
            <div className="set-label">Start a new idea</div>
            <div className="set-sub">
              Archives the current case (versions, messages, proposals) on disk — nothing is
              deleted.
            </div>
          </div>
          <Button variant="danger" icon="plus" onClick={onReset}>
            New idea
          </Button>
        </div>
      </section>
    </div>
  );
}

const PRIVACY_EXPLAIN: Record<string, string> = {
  LOCAL_ONLY: 'Idea State and conversation never leave your infrastructure.',
  PREFERRED_LOCAL: 'Local providers are tried first; cloud is permitted as fallback.',
  CLOUD_ALLOWED: 'Routing follows configuration; cloud providers are permitted.',
  CLOUD_ONLY: 'Local providers are excluded by configuration.',
};

interface MergedProvider {
  id: string;
  displayName: string;
  model: string;
  privacy: 'local' | 'cloud';
  isDemo: boolean;
  ok: boolean;
  detail?: string;
  latencyMs?: number;
  streaming: boolean;
  structuredOutput: string;
  origin?: string;
  routed?: string;
}

function mergeProviders(
  config: (RedactedConfig & { startup_notes?: string[] }) | null,
  health: HealthResponse | null,
): MergedProvider[] {
  if (!config) return [];
  const healthById = new Map((health?.providers ?? []).map((p) => [p.id, p]));
  const route = config.routing.conversation;
  return config.providers.map((p) => {
    const h = healthById.get(p.id);
    const isRouted = route?.provider === p.id;
    const isFallback = route?.fallbacks.includes(p.id) ?? false;
    return {
      id: p.id,
      displayName: p.display_name || p.id,
      model: p.model,
      privacy: p.privacy,
      isDemo: p.is_demo,
      ok: h?.health.ok ?? false,
      detail: h?.health.detail,
      latencyMs: h?.health.latencyMs,
      streaming: p.capabilities.streaming,
      structuredOutput: p.capabilities.structured_output,
      origin: p.base_url_origin,
      routed: isRouted
        ? `primary for conversation${route!.fallbacks.length ? ` · fallbacks: ${route!.fallbacks.join(', ')}` : ''}`
        : isFallback
          ? 'fallback for conversation'
          : 'not routed',
    };
  });
}


function ConnectionCard() {
  const [mode, setMode] = useState<ApiMode | null>(null);
  const [base, setBase] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    getApiMode().then(setMode).catch(() => setMode('demo'));
    setBase(readApiBase());
  }, []);

  const connect = () => {
    if (!writeApiBase(base)) {
      setError('Enter a full URL, e.g. http://192.168.1.20:8787 or https://ideno.example.org');
      return;
    }
    window.location.reload();
  };

  const useDemo = () => {
    clearApiBase();
    window.location.reload();
  };

  return (
    <section className="set-group glass mat-2" aria-label="Connection" data-testid="connection-card">
      <div className="set-group-title">Connection</div>
      <div className="set-row">
        <div>
          <div className="set-label">
            {mode === 'demo' ? 'Offline demo (no server)' : mode === 'server' ? 'Ideno server' : 'Detecting…'}
          </div>
          <div className="set-sub">
            {mode === 'demo'
              ? 'The real state machine runs in this browser tab with a scripted provider (not an AI). Nothing is persisted; reload resets everything. Research is unavailable.'
              : readApiBase()
                ? `Connected to ${readApiBase()} — full functionality with server-side persistence.`
                : 'Connected same-origin to the serving Ideno backend.'}
          </div>
        </div>
        {mode === 'demo' && <span className="pill pill-warn">OFFLINE DEMO</span>}
        {mode === 'server' && <span className="pill pill-ok">SERVER</span>}
      </div>
      <div className="set-row">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="set-label">Server URL</div>
          <div className="set-sub">
            For static hosting (e.g. GitHub Pages): point at any reachable Ideno instance. The
            server must list this page's origin in <code>server.allowed_origins</code>.
          </div>
          <div className="connection-controls">
            <input
              className="text-input"
              value={base}
              onChange={(e) => { setBase(e.target.value); setError(''); }}
              onKeyDown={(e) => { if (e.key === 'Enter') connect(); }}
              placeholder="https://your-ideno-server.example.org"
              aria-label="Ideno server URL"
              spellCheck={false}
            />
            <Button variant="primary" onClick={connect}>Connect</Button>
            {(readApiBase() || mode === 'demo') && (
              <Button variant="ghost" onClick={useDemo}>Use offline demo</Button>
            )}
          </div>
          {error && <div className="set-sub connection-error">{error}</div>}
        </div>
      </div>
    </section>
  );
}


/* ---------------------------------------------------------------------------
   Account (Supabase, via the connected server): sign in to remember your
   settings across browsers. Provider API keys are stored server-side in
   Supabase — write-only from here; reads show hints only (e.g. "nvapi-…9f2c").
   ------------------------------------------------------------------------- */

interface DraftProvider {
  id: string;
  display_name: string;
  base_url: string;
  model: string;
  api_key: string;
  api_key_hint: string | null;
  structured_output: 'json_schema' | 'json_object' | 'none';
}

function AccountCard() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [booted, setBooted] = useState(false);
  const [mode, setMode] = useState<'demo' | 'server' | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSignUp, setIsSignUp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [authError, setAuthError] = useState('');
  const [notice, setNotice] = useState('');

  const [providers, setProviders] = useState<DraftProvider[]>([]);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsError, setSettingsError] = useState('');
  const [settingsNotice, setSettingsNotice] = useState('');

  const loadSettings = React.useCallback(async () => {
    try {
      setSettingsBusy(true);
      setSettingsError('');
      const saved: RedactedUserSettings = await getUserSettings();
      setProviders(
        saved.providers.map((p) => ({
          id: p.id,
          display_name: p.display_name,
          base_url: '',
          model: p.model,
          api_key: '',
          api_key_hint: p.api_key_hint,
          structured_output: p.structured_output ?? 'json_schema',
        })),
      );
    } catch (err) {
      const e = err as { code?: string; message?: string };
      if (e.code !== 'AUTH_REQUIRED' && e.code !== 'AUTH_UNAVAILABLE') {
        setSettingsError(e.message ?? String(err));
      }
    } finally {
      setSettingsBusy(false);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      const m = await getApiMode().catch(() => 'demo' as const);
      if (!alive) return;
      setMode(m);
      if (m === 'server') {
        // "Remember the user": silently refresh/verify a stored session.
        const u = await ensureSession('server').catch(() => null);
        if (!alive) return;
        setUser(u);
        if (u) await loadSettings();
      }
      setBooted(true);
    })();
    return () => { alive = false; };
  }, [loadSettings]);

  const submit = async () => {
    if (busy || !email.trim() || !password) return;
    setBusy(true);
    setAuthError('');
    setNotice('');
    try {
      if (isSignUp) {
        await signUp(email.trim(), password);
        setNotice('Account created. You can sign in now.' +
          ' (If your Supabase project requires email confirmation, confirm first.)');
      } else {
        const session = await signIn(email.trim(), password);
        setUser(session.user);
        await loadSettings();
      }
    } catch (err) {
      setAuthError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const doSignOut = async () => {
    await signOut();
    setUser(null);
    setProviders([]);
    setNotice('Signed out.');
  };

  const saveProviders = async () => {
    if (settingsBusy) return;
    setSettingsBusy(true);
    setSettingsError('');
    setSettingsNotice('');
    try {
      const input: UserSettingsInput = {
        providers: providers.map((p) => {
          if (!p.base_url.trim()) {
            throw Object.assign(new Error(`Provider '${p.id || 'unnamed'}' needs a base URL (e.g. https://integrate.api.nvidia.com/v1).`), {});
          }
          if (!p.model.trim()) {
            throw new Error("Provider '" + (p.id || 'unnamed') + "' needs a model.");
          }
          return {
            id: p.id.trim() || `provider-${providers.indexOf(p) + 1}`,
            type: 'openai_compatible' as const,
            display_name: p.display_name.trim() || p.id.trim() || 'My provider',
            base_url: p.base_url.trim(),
            model: p.model.trim(),
            api_key: p.api_key || undefined,
            structured_output: p.structured_output,
          };
        }),
      };
      const saved = await saveUserSettings(input);
      setProviders(
        saved.providers.map((p) => ({
          id: p.id,
          display_name: p.display_name,
          base_url: '',
          model: p.model,
          api_key: '',
          api_key_hint: p.api_key_hint,
          structured_output: p.structured_output ?? 'json_schema',
        })),
      );
      setSettingsNotice('Saved. Keys are stored server-side in Supabase — this browser only keeps hints.');
    } catch (err) {
      setSettingsError((err as Error).message);
    } finally {
      setSettingsBusy(false);
    }
  };

  const testProviders = async () => {
    if (settingsBusy) return;
    setSettingsBusy(true);
    setSettingsError('');
    setSettingsNotice('');
    try {
      const result = await testUserProviders();
      const lines = result.providers.map((p) => `${p.display_name}: ${p.health.ok ? 'reachable' : 'unreachable'} — ${p.health.detail}`);
      setSettingsNotice('Provider check (run server-side, keys never leave the server):\n' + lines.join('\n'));
    } catch (err) {
      setSettingsError((err as Error).message);
    } finally {
      setSettingsBusy(false);
    }
  };

  const updateProvider = (index: number, patch: Partial<DraftProvider>) => {
    setProviders((prev) => prev.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  };

  if (mode === 'demo') {
    return (
      <section className="set-group glass mat-2" aria-label="Account">
        <div className="set-group-title">Account</div>
        <div className="set-row">
          <div>
            <div className="set-label">Accounts need a connected server</div>
            <div className="set-sub">
              The offline demo has no accounts. Connect to an Ideno server (below) that has Supabase
              configured to sign in and store your provider keys.
            </div>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="set-group glass mat-2" aria-label="Account" data-testid="account-card">
      <div className="set-group-title">Account</div>

      {!user ? (
        <div className="set-row">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="set-label">{isSignUp ? 'Create account' : 'Sign in'}</div>
            <div className="set-sub">
              {booted ? 'Remembered on this server via Supabase (configured server-side).' : 'Checking for a saved session…'}
            </div>
            <div className="connection-controls">
              <input
                className="text-input"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                aria-label="Email"
                autoComplete="email"
              />
              <input
                className="text-input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
                placeholder="Password"
                aria-label="Password"
                autoComplete={isSignUp ? 'new-password' : 'current-password'}
              />
              <Button variant="primary" onClick={submit} disabled={busy || !email.trim() || !password}>
                {busy ? '…' : isSignUp ? 'Create account' : 'Sign in'}
              </Button>
            </div>
            <div className="set-sub" style={{ marginTop: 8 }}>
              <button className="linkbtn" onClick={() => { setIsSignUp(!isSignUp); setAuthError(''); setNotice(''); }}>
                {isSignUp ? 'I already have an account' : 'Create an account'}
              </button>
            </div>
            {authError && <div className="set-sub connection-error">{authError}</div>}
            {notice && <div className="set-sub" style={{ marginTop: 6 }}>{notice}</div>}
          </div>
        </div>
      ) : (
        <>
          <div className="set-row">
            <div>
              <div className="set-label">Signed in as {user.email ?? user.id}</div>
              <div className="set-sub">Your settings follow you to any browser connected to this server.</div>
            </div>
            <Button variant="ghost" onClick={doSignOut}>Sign out</Button>
          </div>

          <div className="set-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
            <div className="set-label">AI provider keys (stored in Supabase, server-side)</div>
            <div className="set-sub">
              Keys are sent once over your connection to this server and stored server-side — this browser only
              ever sees hints like <code>nvapi-…9f2c</code>. Chats from a signed-in browser use YOUR providers.
            </div>
            {providers.map((p, i) => (
              <div key={i} className="provider-editor glass mat-2">
                <div className="connection-controls">
                  <input className="text-input" value={p.id} onChange={(e) => updateProvider(i, { id: e.target.value })} placeholder="id (e.g. my-nim)" aria-label={`Provider ${i + 1} id`} />
                  <input className="text-input" value={p.display_name} onChange={(e) => updateProvider(i, { display_name: e.target.value })} placeholder="Name (e.g. NVIDIA NIM)" aria-label={`Provider ${i + 1} name`} />
                </div>
                <div className="connection-controls">
                  <input className="text-input" value={p.base_url} onChange={(e) => updateProvider(i, { base_url: e.target.value })} placeholder={p.api_key_hint ? 'saved — enter to replace' : 'https://api.example.com/v1'} aria-label={`Provider ${i + 1} base URL`} spellCheck={false} />
                  <input className="text-input" value={p.model} onChange={(e) => updateProvider(i, { model: e.target.value })} placeholder="model (e.g. meta/llama-3.1-8b-instruct)" aria-label={`Provider ${i + 1} model`} spellCheck={false} />
                </div>
                <div className="connection-controls">
                  <input
                    className="text-input"
                    type="password"
                    value={p.api_key}
                    onChange={(e) => updateProvider(i, { api_key: e.target.value })}
                    placeholder={p.api_key_hint ? `saved (${p.api_key_hint}) — leave blank to keep` : 'API key (env-style secret, stored server-side)'}
                    aria-label={`Provider ${i + 1} API key`}
                    autoComplete="off"
                  />
                  <select
                    className="text-input"
                    value={p.structured_output}
                    onChange={(e) => updateProvider(i, { structured_output: e.target.value as DraftProvider['structured_output'] })}
                    aria-label={`Provider ${i + 1} structured output mode`}
                  >
                    <option value="json_schema">json_schema</option>
                    <option value="json_object">json_object</option>
                    <option value="none">none</option>
                  </select>
                  <Button variant="ghost" onClick={() => setProviders((prev) => prev.filter((_, j) => j !== i))}>Remove</Button>
                </div>
              </div>
            ))}
            <div className="connection-controls">
              <Button variant="ghost" onClick={() => setProviders((prev) => [...prev, { id: '', display_name: '', base_url: '', model: '', api_key: '', api_key_hint: null, structured_output: 'json_schema' }])}>
                + Add provider
              </Button>
              <Button variant="primary" onClick={saveProviders} disabled={settingsBusy || providers.length === 0}>
                {settingsBusy ? '…' : 'Save keys'}
              </Button>
              <Button variant="ghost" onClick={testProviders} disabled={settingsBusy || providers.length === 0}>
                Test providers
              </Button>
            </div>
            {settingsError && <div className="set-sub connection-error">{settingsError}</div>}
            {settingsNotice && <div className="set-sub" style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>{settingsNotice}</div>}
          </div>
        </>
      )}
    </section>
  );
}
