import express, { type Request, type Response, type NextFunction } from 'express';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { AppError } from '../../shared/errors.js';
import type { ApiErrorShape } from '../../shared/errors.js';
import type { RedactedConfig } from '../../shared/config.js';
import type { ChatEvent } from '../../shared/chat.js';
import type { AIRuntime } from '../ai/runtime.js';
import type { SupabaseClient, UserSettings } from '../supabase/client.js';
import { runtimeForUser, invalidateUserRuntime } from '../supabase/userRuntime.js';
import { ProviderConfig } from '../../shared/config.js';
import type { Orchestrator } from '../core/orchestration/orchestrator.js';
import type { Clock } from '../util/clock.js';

/**
 * HTTP API + static UI serving.
 *
 * Trust boundary: the browser talks ONLY to this backend. Provider keys,
 * config file contents, and full endpoint URLs never cross this boundary.
 * All AI calls go browser → Ideno backend → provider adapter (§10).
 */

export interface AppDependencies {
  orchestrator: Orchestrator;
  runtime: AIRuntime;
  redactedConfig: RedactedConfig;
  webDistDir?: string;
  startupNotes: string[];
  /** CORS: origins allowed to call the API (static UI hosting, e.g. Pages). */
  allowedOrigins?: string[];
  /** Supabase (accounts + per-user settings). Absent = auth unavailable. */
  supabase?: SupabaseClient | null;
  /** Base config — source of the server privacy mode for user providers. */
  baseConfig: import('../../shared/config.js').IdenoConfig;
}

function safeOrigin(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return '<invalid url>';
  }
}

export function createApp(deps: AppDependencies) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  // Security headers for the served UI.
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
    );
    next();
  });

  // CORS for statically-hosted UIs (e.g. GitHub Pages) talking to this
  // backend cross-origin. The browser only ever talks to THIS backend.
  const allowedOrigins = deps.allowedOrigins ?? ['*'];
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (!origin || !req.path.startsWith('/api/')) return next();
    if (!allowedOrigins.includes('*') && !allowedOrigins.includes(origin)) return next();
    if (allowedOrigins.includes('*')) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // Single-flight guard: one generation at a time keeps context coherent.
  let chatInFlight = false;

  app.get('/api/health', async (_req, res) => {
    const health = await deps.runtime.healthReport();
    res.json({
      server: 'ok',
      providers: health,
      routing: deps.runtime.routingPreview('conversation'),
    });
  });

  app.get('/api/config', (_req, res) => {
    res.json({ ...deps.redactedConfig, startup_notes: deps.startupNotes });
  });

  app.get('/api/case', async (req, res, next) => {
    try {
      const [versions, proposals, messages] = await Promise.all([
        deps.orchestrator.listVersions(),
        deps.orchestrator.listProposals(),
        deps.orchestrator.listMessages(300),
      ]);
      res.json({
        case: deps.orchestrator.getCase(),
        versions,
        proposals,
        messages,
        load_warnings: deps.orchestrator.getLoadWarnings(),
      });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/versions/:number', async (req, res, next) => {
    try {
      const n = Number(req.params.number);
      if (!Number.isInteger(n) || n < 0) {
        throw new AppError('BAD_REQUEST', 'Version number must be a non-negative integer.');
      }
      const version = await deps.orchestrator.getVersion(n);
      if (!version) throw new AppError('PROPOSAL_NOT_FOUND', `Version v${n} does not exist.`);
      res.json({ version });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/chat', async (req, res, next) => {
    try {
      if (chatInFlight) {
        throw new AppError('STATE_CONFLICT', 'A generation is already in progress.', {
          detail: ['Wait for the current response to finish.'],
          recoverable: true,
          status: 429,
        });
      }
      const message = typeof req.body?.message === 'string' ? req.body.message : '';
      if (!message.trim()) {
        throw new AppError('BAD_REQUEST', "Field 'message' (non-empty string) is required.");
      }
      const deep = req.body?.deep === true;

      chatInFlight = true;
      const abort = new AbortController();
      req.on('close', () => abort.abort());

      // SSE setup
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();
      const heartbeat = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          /* ignore */
        }
      }, 15_000);

      const send = (event: ChatEvent) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      };

      // Signed-in users with stored providers chat through THEIR runtime
      // (keys consumed server-side; never sent to the browser).
      let userRuntime: import('../ai/runtime.js').AIRuntime | undefined;
      if (deps.supabase) {
        const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
        if (token) {
          try {
            const user = await deps.supabase.verifyUserToken(token);
            const settings = await deps.supabase.getUserSettings(user.id);
            if (settings.providers.length > 0) {
              userRuntime = runtimeForUser(user.id, settings, deps.baseConfig);
            }
          } catch (err) {
            if (err instanceof AppError && err.code === 'AUTH_INVALID') {
              // Invalid session: fall back to the server runtime rather
              // than failing the turn; the UI refreshes sessions on 401s.
            } else {
              throw err;
            }
          }
        }
      }

      try {
        const gen = deps.orchestrator.handleUserMessage(message, abort.signal, { deep, runtime: userRuntime });
        while (true) {
          const next = await gen.next();
          if (next.done) break;
          send(next.value);
        }
      } catch (err) {
        send({ type: 'error', error: toShape(err) });
      } finally {
        clearInterval(heartbeat);
        chatInFlight = false;
        res.end();
      }
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/proposals/:id/accept', async (req, res, next) => {
    try {
      if (!/^[a-z0-9_-]+$/i.test(req.params.id)) {
        throw new AppError('BAD_REQUEST', 'Invalid proposal id.');
      }
      const { caseData, version } = await deps.orchestrator.acceptProposal(req.params.id);
      res.json({ case: caseData, version: versionSummary(version) });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/proposals/:id/reject', async (req, res, next) => {
    try {
      if (!/^[a-z0-9_-]+$/i.test(req.params.id)) {
        throw new AppError('BAD_REQUEST', 'Invalid proposal id.');
      }
      const reason =
        typeof req.body?.reason === 'string' && req.body.reason.trim()
          ? req.body.reason.trim().slice(0, 1000)
          : undefined;
      const proposal = await deps.orchestrator.rejectProposal(req.params.id, reason);
      res.json({ proposal });
    } catch (err) {
      next(err);
    }
  });

  // External research (§17): fails explicitly while no research provider is
  // configured — never fakes results.
  app.post('/api/research', async (req, res, next) => {
    try {
      const question =
        typeof req.body?.question === 'string' ? req.body.question.trim() : '';
      if (!question) {
        throw new AppError('BAD_REQUEST', "Field 'question' (non-empty string) is required.");
      }
      if (question.length > 2000) {
        throw new AppError('BAD_REQUEST', 'Question is too long (max 2000 chars).');
      }
      const result = await deps.orchestrator.researchSearch({
        question,
        keywords: Array.isArray(req.body.keywords)
          ? req.body.keywords.filter((k: unknown): k is string => typeof k === 'string').slice(0, 10)
          : undefined,
        max_results: 5,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // Run research and propose recording the findings as a pending proposal
  // (§17/§27): sources come from the research provider, acceptance is human.
  app.post('/api/research/propose', async (req, res, next) => {
    try {
      const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
      if (!question) {
        throw new AppError('BAD_REQUEST', "Field 'question' (non-empty string) is required.");
      }
      const out = await deps.orchestrator.proposeResearchFindings(question);
      res.json(out);
    } catch (err) {
      next(err);
    }
  });

  /* ------------------------------------------------------------------
     Accounts (Supabase, server-mediated: no Supabase secrets in browser)
     ------------------------------------------------------------------ */

  const requireUser = async (req: Request): Promise<{ id: string; email: string | null }> => {
    if (!deps.supabase) {
      throw new AppError('AUTH_UNAVAILABLE', 'This Ideno server has no Supabase configured (config: supabase.url + env keys).', {
        detail: ['Set supabase in config/ideno.config.json and SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY in the environment.'],
      });
    }
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) throw new AppError('AUTH_REQUIRED', 'Sign in to use this endpoint.', { status: 401 });
    return deps.supabase.verifyUserToken(token);
  };

  app.post('/api/auth/signup', async (req, res, next) => {
    try {
      if (!deps.supabase) throw new AppError('AUTH_UNAVAILABLE', 'This server has no Supabase configured.');
      const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      if (!email || !password) throw new AppError('BAD_REQUEST', "Fields 'email' and 'password' are required.");
      const user = await deps.supabase.signUp(email, password);
      res.json({ user });
    } catch (err) { next(err); }
  });

  app.post('/api/auth/login', async (req, res, next) => {
    try {
      if (!deps.supabase) throw new AppError('AUTH_UNAVAILABLE', 'This server has no Supabase configured.');
      const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      if (!email || !password) throw new AppError('BAD_REQUEST', "Fields 'email' and 'password' are required.");
      const session = await deps.supabase.signInWithPassword(email, password);
      res.json(session);
    } catch (err) { next(err); }
  });

  app.post('/api/auth/refresh', async (req, res, next) => {
    try {
      if (!deps.supabase) throw new AppError('AUTH_UNAVAILABLE', 'This server has no Supabase configured.');
      const refreshToken = typeof req.body?.refresh_token === 'string' ? req.body.refresh_token : '';
      if (!refreshToken) throw new AppError('BAD_REQUEST', "Field 'refresh_token' is required.");
      const session = await deps.supabase.refreshSession(refreshToken);
      res.json(session);
    } catch (err) { next(err); }
  });

  app.post('/api/auth/logout', async (req, res, next) => {
    try {
      const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      if (deps.supabase && token) await deps.supabase.signOut(token);
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  app.get('/api/auth/user', async (req, res, next) => {
    try {
      const user = await requireUser(req);
      res.json({ user });
    } catch (err) { next(err); }
  });

  /* ------------------------------------------------------------------
     Per-user settings (provider keys stored server-side, redacted views)
     ------------------------------------------------------------------ */

  /** NEVER return full keys to the browser — hints only. */
  const redact = (settings: UserSettings) => ({
    providers: settings.providers.map((p) => {
      const key = typeof p.api_key === 'string' ? p.api_key : undefined;
      return {
        id: p.id,
        type: p.type,
        display_name: p.display_name ?? p.id,
        model: p.model,
        base_url_origin: typeof p.base_url === 'string' ? safeOrigin(p.base_url) : undefined,
        structured_output: p.structured_output,
        api_key_hint: key ? `${key.slice(0, 6)}…${key.slice(-4)}` : null,
      };
    }),
    routing: settings.routing,
  });

  app.get('/api/user/settings', async (req, res, next) => {
    try {
      const user = await requireUser(req);
      const settings = await deps.supabase!.getUserSettings(user.id);
      res.json(redact(settings));
    } catch (err) { next(err); }
  });

  app.put('/api/user/settings', async (req, res, next) => {
    try {
      const user = await requireUser(req);
      const incoming = req.body?.providers;
      if (!Array.isArray(incoming) || incoming.length > 10) {
        throw new AppError('BAD_REQUEST', "Field 'providers' must be an array (max 10).");
      }
      const providers: UserSettings['providers'] = [];
      const seen = new Set<string>();
      for (const raw of incoming) {
        if (!raw || typeof raw !== 'object') throw new AppError('BAD_REQUEST', 'Each provider must be an object.');
        const { id, ...rest } = raw as Record<string, unknown>;
        if (typeof id !== 'string' || !id.trim()) throw new AppError('BAD_REQUEST', 'Each provider needs a non-empty id.');
        if (seen.has(id)) throw new AppError('BAD_REQUEST', `Duplicate provider id '${id}'.`);
        seen.add(id);
        // NOTE: an empty api_key means "keep the stored one" — the client
        // cannot read keys back, so edits send blank unless re-entered.
        if (rest.api_key === '') delete rest.api_key;
        const parsed = ProviderConfig.safeParse(rest);
        if (!parsed.success) {
          throw new AppError('CONFIG_INVALID', `Provider '${id}' is invalid.`, {
            detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
          });
        }
        let record = parsed.data as Record<string, unknown>;
        if (rest.api_key === undefined) {
          // keep existing key for this id if the client sent none
          const existing = (await deps.supabase!.getUserSettings(user.id)).providers.find((p) => p.id === id);
          if (existing?.api_key) record = { ...record, api_key: existing.api_key };
        }
        providers.push({ id, ...record });
      }
      const routing = (req.body?.routing && typeof req.body.routing === 'object' ? req.body.routing : undefined) as UserSettings['routing'];
      const settings: UserSettings = { providers, ...(routing ? { routing } : {}) };
      await deps.supabase!.upsertUserSettings(user.id, settings);
      invalidateUserRuntime(user.id);
      res.json(redact(settings));
    } catch (err) { next(err); }
  });

  /** Health-check the USER'S stored providers (server-side, redacted result). */
  app.post('/api/user/settings/test', async (req, res, next) => {
    try {
      const user = await requireUser(req);
      const settings = await deps.supabase!.getUserSettings(user.id);
      if (settings.providers.length === 0) {
        throw new AppError('BAD_REQUEST', 'No providers saved yet.');
      }
      const runtime = runtimeForUser(user.id, settings, deps.baseConfig);
      const health = await runtime.healthReport();
      res.json({
        providers: health.map((h) => ({
          id: h.id,
          display_name: h.display_name,
          model: h.model,
          health: h.health,
        })),
      });
    } catch (err) { next(err); }
  });

  app.post('/api/case/reset', async (_req, res, next) => {
    try {
      const caseData = await deps.orchestrator.reset();
      const versions = await deps.orchestrator.listVersions();
      res.json({ case: caseData, versions, proposals: [], messages: [] });
    } catch (err) {
      next(err);
    }
  });

  // --- static UI (production build) ---
  const webDir = deps.webDistDir;
  if (webDir) {
    app.use(
      express.static(webDir, {
        setHeaders: (res, filePath) => {
          if (filePath.startsWith(path.join(webDir, 'assets'))) {
            res.setHeader('Cache-Control', 'public, max-age=3600');
          }
        },
      }),
    );
    // SPA fallback for non-API GET requests.
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
      const index = path.join(webDir, 'index.html');
      fs.readFile(index, 'utf8')
        .then((html) => {
          res.type('html').send(html);
        })
        .catch(() => next(new AppError('INTERNAL', 'Web UI build not found. Run `npm run build`.')));
    });
  }

  app.use('/api', (req, res) => {
    res.status(404).json({ code: 'BAD_REQUEST', message: `Unknown API route: ${req.method} ${req.path}`, recoverable: false });
  });

  // Central error handler — classified, never leaking internals.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const shape = toShape(err);
    const status = err instanceof AppError ? err.status : 500;
    if (status >= 500) {
      console.error('[ideno] API error:', err);
    }
    res.status(status).json(shape);
  });

  return app;
}

function toShape(err: unknown): ApiErrorShape {
  if (err instanceof AppError) return err.toJSON();
  return {
    code: 'INTERNAL',
    message: 'An unexpected internal error occurred.',
    detail: [err instanceof Error ? `${err.name}: ${err.message}` : String(err)],
    recoverable: false,
  };
}

function versionSummary(version: { number: number; summary: string; created_at: string }) {
  return { number: version.number, summary: version.summary, created_at: version.created_at };
}
