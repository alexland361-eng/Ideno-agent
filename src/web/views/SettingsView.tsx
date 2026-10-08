import React from 'react';
import type { Appearance } from '../theme';
import type { RedactedConfig } from '../../shared/config.js';
import type { HealthResponse } from '../api';
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
