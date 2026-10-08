import express, { type Request, type Response, type NextFunction } from 'express';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { AppError } from '../../shared/errors.js';
import type { ApiErrorShape } from '../../shared/errors.js';
import type { RedactedConfig } from '../../shared/config.js';
import type { ChatEvent } from '../../shared/chat.js';
import type { AIRuntime } from '../ai/runtime.js';
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

      try {
        const gen = deps.orchestrator.handleUserMessage(message, abort.signal, { deep });
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
