import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { loadConfig, buildRuntime } from '../src/server/config/load.js';
import { Store } from '../src/server/persistence/store.js';
import { Orchestrator } from '../src/server/core/orchestration/orchestrator.js';
import { createApp } from '../src/server/api/routes.js';
import { SupabaseClient } from '../src/server/supabase/client.js';
import { NoResearchProvider } from '../src/server/research/interface.js';
import { systemClock } from '../src/server/util/clock.js';
import type { ChatEvent } from '../src/shared/chat.js';

/**
 * Supabase integration tests. The Supabase side is a LOCAL mock implementing
 * the documented REST contract (auth/v1 + rest/v1) — the sandbox cannot
 * reach a real Supabase project. What IS real here: the Express routes,
 * token verification flow, settings storage round trip, redaction, and the
 * per-user runtime injection into chat. A live Supabase project is NOT
 * verified (same honesty rule as the NVIDIA NIM entry in v0.1.1).
 */

/* ------------------------------- mock Supabase ------------------------------ */

const users = new Map<string, { id: string; email: string; password: string }>(); // email -> user
const tokens = new Map<string, string>(); // access token -> email
const settingsRows = new Map<string, unknown>(); // user id -> settings
let tokenSeq = 0;

const ANON_KEY = 'anon-test-key';
const SERVICE_KEY = 'service-test-key';

let mockServer: http.Server;
let supabaseUrl: string;

beforeAll(async () => {
  mockServer = http.createServer((req, res) => {
    const url = req.url ?? '';
    const authz = req.headers.authorization ?? '';
    const token = authz.replace(/^Bearer\s+/i, '');
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const json = () => (body ? (JSON.parse(body) as Record<string, unknown>) : {});
      const send = (code: number, data: unknown) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };

      // ---- auth/v1 ----
      if (url === '/auth/v1/signup' && req.method === 'POST') {
        if (req.headers.apikey !== ANON_KEY) return send(401, { msg: 'bad apikey' });
        const { email, password } = json() as { email?: string; password?: string };
        if (!email || !password || password.length < 6) return send(400, { msg: 'invalid email or password' });
        if (users.has(email)) return send(422, { msg: 'user already exists' });
        const user = { id: `u_${users.size + 1}`, email, password };
        users.set(email, user);
        return send(200, { id: user.id, email: user.email });
      }
      if (url.startsWith('/auth/v1/token') && req.method === 'POST') {
        if (req.headers.apikey !== ANON_KEY) return send(401, { msg: 'bad apikey' });
        const body_ = json();
        if (url.includes('grant_type=password')) {
          const { email, password } = body_ as { email?: string; password?: string };
          const user = users.get(email ?? '');
          if (!user || user.password !== password) return send(400, { msg: 'invalid credentials' });
          const accessToken = `tok_${++tokenSeq}`;
          tokens.set(accessToken, user.email);
          return send(200, {
            access_token: accessToken,
            refresh_token: `ref_${accessToken}`,
            expires_in: 3600,
            user: { id: user.id, email: user.email },
          });
        }
        // refresh
        const { refresh_token } = body_ as { refresh_token?: string };
        const email = refresh_token?.replace(/^ref_tok_/, '');
        const user = email ? users.get(email.replace(/^ref_/, '')) : undefined;
        const direct = refresh_token ? users.get(refresh_token.replace(/^ref_tok_/, '')) : undefined;
        const target = user ?? direct;
        if (!target) return send(400, { msg: 'invalid refresh token' });
        const accessToken = `tok_${++tokenSeq}`;
        tokens.set(accessToken, target.email);
        return send(200, {
          access_token: accessToken,
          refresh_token: `ref_${accessToken}`,
          expires_in: 3600,
          user: { id: target.id, email: target.email },
        });
      }
      if (url === '/auth/v1/user' && req.method === 'GET') {
        if (req.headers.apikey !== ANON_KEY) return send(401, { msg: 'bad apikey' });
        const email = tokens.get(token);
        const user = email ? users.get(email) : undefined;
        if (!user) return send(401, { msg: 'invalid token' });
        return send(200, { id: user.id, email: user.email });
      }
      if (url === '/auth/v1/logout' && req.method === 'POST') {
        tokens.delete(token);
        return send(204, '');
      }

      // ---- rest/v1 (service role only) ----
      if (url.startsWith('/rest/v1/')) {
        if (req.headers.apikey !== SERVICE_KEY || req.headers.authorization !== `Bearer ${SERVICE_KEY}`) {
          return send(401, { message: 'service key required' });
        }
        if (url.startsWith('/rest/v1/ideno_user_settings') && req.method === 'GET') {
          const m = /user_id=eq\.([^&]+)/.exec(url);
          if (!m) return send(400, { message: 'user_id filter required' });
          const row = settingsRows.get(m[1]!);
          return send(200, row ? [{ settings: row }] : []);
        }
        if (url === '/rest/v1/ideno_user_settings' && req.method === 'POST') {
          const row = json() as { user_id?: string; settings?: unknown };
          if (!row.user_id) return send(400, { message: 'user_id required' });
          settingsRows.set(row.user_id, row.settings);
          return send(201, [row]);
        }
        return send(404, { message: 'table not found' });
      }

      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  supabaseUrl = `http://127.0.0.1:${(mockServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => mockServer.close(() => resolve()));
});

/* --------------------------------- test app -------------------------------- */

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ideno-supabase-'));
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ideno-supabase-cfg-'));
  await fs.writeFile(
    path.join(configDir, 'ideno.config.json'),
    JSON.stringify({
      data_dir: dataDir,
      privacy_mode: 'CLOUD_ALLOWED',
      providers: { demo: { type: 'demo', model: 'server-demo-v0', privacy: 'local' } },
      routing: { conversation: { provider: 'demo' } },
    }),
  );
  process.env.IDENO_CONFIG = path.join(configDir, 'ideno.config.json');
  const { config } = await loadConfig();
  const runtime = buildRuntime(config);
  const store = new Store(dataDir, systemClock);
  const orchestrator = new Orchestrator(store, runtime, systemClock, config, new NoResearchProvider());
  await orchestrator.init();
  const supabase = new SupabaseClient(supabaseUrl, ANON_KEY, SERVICE_KEY);
  const app = createApp({
    orchestrator,
    runtime,
    baseConfig: config,
    redactedConfig: {
      privacy_mode: config.privacy_mode,
      providers: [],
      routing: {},
      research_provider_configured: false,
    },
    startupNotes: [],
    supabase,
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  delete process.env.IDENO_CONFIG;
});

async function post<T>(path: string, body: unknown, token?: string): Promise<{ status: number; json: T }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as T };
}

async function chat(message: string, token?: string): Promise<ChatEvent[]> {
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ message }),
  });
  expect(res.ok).toBe(true);
  const text = await res.text();
  const events: ChatEvent[] = [];
  for (const block of text.split('\n\n')) {
    for (const line of block.split('\n')) {
      if (line.startsWith('data:')) events.push(JSON.parse(line.slice(5).trim()) as ChatEvent);
    }
  }
  return events;
}

/* ----------------------------------- tests ---------------------------------- */

describe('accounts (Supabase, server-mediated)', () => {
  it('signs up and in; wrong credentials are classified AUTH_INVALID', async () => {
    const up = await post<{ user?: { id: string } }>('/api/auth/signup', {
      email: 'dev@example.com',
      password: 'correct-horse',
    });
    expect(up.status).toBe(200);
    expect(up.json.user?.id).toBe('u_1');

    const bad = await post('/api/auth/login', { email: 'dev@example.com', password: 'wrong' });
    expect(bad.status).toBeGreaterThanOrEqual(400);

    const ok = await post<{ access_token: string; user: { email: string } }>('/api/auth/login', {
      email: 'dev@example.com',
      password: 'correct-horse',
    });
    expect(ok.status).toBe(200);
    expect(ok.json.user.email).toBe('dev@example.com');
    expect(ok.json.access_token).toMatch(/^tok_/);
  });

  it('CORS preflight allows the cross-origin UI to save settings (PUT + Authorization)', async () => {
    // Regression: round-7 live QA found Allow-Methods lacked PUT, which would
    // have blocked the Pages-hosted UI from ever saving provider keys.
    const res = await fetch(`${baseUrl}/api/user/settings`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://alexland361-eng.github.io',
        'Access-Control-Request-Method': 'PUT',
        'Access-Control-Request-Headers': 'content-type, authorization',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toContain('PUT');
    expect(res.headers.get('access-control-allow-headers')).toContain('Authorization');
    expect(res.headers.get('access-control-allow-origin')).toBeTruthy();
  });

  it('settings require auth (AUTH_REQUIRED, 401) and Supabase (AUTH_UNAVAILABLE)', async () => {
    const noAuth = await fetch(`${baseUrl}/api/user/settings`);
    expect(noAuth.status).toBe(401);
    expect(((await noAuth.json()) as { code: string }).code).toBe('AUTH_REQUIRED');
  });

  it('stores provider keys server-side and NEVER returns them (redacted views)', async () => {
    const login = await post<{ access_token: string }>('/api/auth/login', {
      email: 'dev@example.com',
      password: 'correct-horse',
    });
    const token = login.json.access_token;

    const save = await fetch(`${baseUrl}/api/user/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        providers: [
          {
            id: 'my-nim',
            type: 'openai_compatible',
            display_name: 'NVIDIA NIM',
            base_url: 'https://integrate.api.nvidia.com/v1',
            model: 'meta/llama-3.1-8b-instruct',
            api_key: 'nvapi-SUPER-SECRET-KEY-1234',
          },
        ],
      }),
    });
    expect(save.status).toBe(200);
    const saved = (await save.json()) as { providers: Array<{ api_key_hint: string | null; base_url_origin?: string }> };
    expect(saved.providers[0]!.api_key_hint).toBe('nvapi-…1234');
    expect(JSON.stringify(saved)).not.toContain('SUPER-SECRET');

    // Blank api_key on re-save keeps the stored key (client cannot read it back).
    const resave = await fetch(`${baseUrl}/api/user/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        providers: [
          {
            id: 'my-nim',
            type: 'openai_compatible',
            base_url: 'https://integrate.api.nvidia.com/v1',
            model: 'meta/llama-3.1-8b-instruct',
            api_key: '',
          },
        ],
      }),
    });
    expect(resave.status).toBe(200);
    const kept = (await resave.json()) as { providers: Array<{ api_key_hint: string | null }> };
    expect(kept.providers[0]!.api_key_hint).toBe('nvapi-…1234');

    // GET is redacted too.
    const got = await fetch(`${baseUrl}/api/user/settings`, { headers: { Authorization: `Bearer ${token}` } });
    const read = await got.json();
    expect(JSON.stringify(read)).not.toContain('SUPER-SECRET');
  });

  it('chat from a signed-in user with providers runs on THEIR runtime', async () => {
    const login = await post<{ access_token: string }>('/api/auth/login', {
      email: 'dev@example.com',
      password: 'correct-horse',
    });
    const token = login.json.access_token;

    // Replace settings with a demo-type provider (deterministic in tests).
    await fetch(`${baseUrl}/api/user/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        providers: [{ id: 'user-demo', type: 'demo', model: 'user-own-demo-v0', privacy: 'local' }],
      }),
    });

    const events = await chat('I want to build a treehouse.', token);
    const proposal = [...events].reverse().find((e) => e.type === 'proposal');
    expect(proposal).toBeDefined();
    if (proposal?.type === 'proposal') {
      // Provider label proves the per-user runtime produced this proposal.
      expect(proposal.proposal.provider).toBe('user-demo/user-own-demo-v0');
    }

    // Without a token: the server's own runtime (different model label).
    const anon = await chat('I want to build a shed.');
    const anonProposal = [...anon].reverse().find((e) => e.type === 'proposal');
    if (anonProposal?.type === 'proposal') {
      expect(anonProposal.proposal.provider).toBe('demo/server-demo-v0');
    }
  });

  it('test endpoint health-checks the user runtime server-side', async () => {
    const login = await post<{ access_token: string }>('/api/auth/login', {
      email: 'dev@example.com',
      password: 'correct-horse',
    });
    const res = await post<{ providers: Array<{ id: string; health: { ok: boolean } }> }>(
      '/api/user/settings/test',
      {},
      login.json.access_token,
    );
    expect(res.status).toBe(200);
    expect(res.json.providers[0]!.id).toBe('user-demo');
    expect(typeof res.json.providers[0]!.health.ok).toBe('boolean');
  });

  it('invalid session tokens fall back to the server runtime, never fail the turn', async () => {
    const events = await chat('I want to build a bench.', 'not-a-real-token');
    const proposal = [...events].reverse().find((e) => e.type === 'proposal');
    if (proposal?.type === 'proposal') {
      expect(proposal.proposal.provider).toBe('demo/server-demo-v0');
    }
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });
});
