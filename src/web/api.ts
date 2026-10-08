import type { ChatEvent, ChatMessage } from '../shared/chat.js';
import type { StoredProposal, Proposal } from '../shared/schemas/proposal.js';
import type { VersionRecord, IdeaCase } from '../shared/schemas/ideaCase.js';
import type { RedactedConfig } from '../shared/config.js';
import { demoBackend } from './demoBackend.js';

/**
 * Typed client for the Ideno API. The browser talks only to the Ideno
 * backend — never to any AI provider directly.
 *
 * DEPLOYMENT MODES:
 *  - 'server' — a real Ideno backend. Same-origin when the backend serves
 *    this UI (npm start), or any reachable instance via a saved API base
 *    URL (Settings → Connection; needed for static hosting such as GitHub
 *    Pages). The backend must allow the UI's origin (server.allowed_origins).
 *  - 'demo' — OFFLINE DEMO: no backend; the real core state machine runs in
 *    the browser with a scripted demo provider (labeled everywhere, nothing
 *    persisted, resets on reload, research unavailable).
 */

export type ApiMode = 'server' | 'demo';

const API_BASE_KEY = 'ideno.apiBase';

export function readApiBase(): string {
  try {
    const v = localStorage.getItem(API_BASE_KEY);
    if (v && /^https?:\/\//i.test(v)) return v.replace(/\/+$/, '');
  } catch {
    // storage unavailable
  }
  return '';
}

export function writeApiBase(base: string): boolean {
  try {
    const trimmed = base.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(trimmed)) return false;
    localStorage.setItem(API_BASE_KEY, trimmed);
    return true;
  } catch {
    return false;
  }
}

export function clearApiBase(): void {
  try {
    localStorage.removeItem(API_BASE_KEY);
  } catch {
    // ignore
  }
}

let cachedMode: ApiMode | null = null;

/**
 * Determine the mode once per session:
 *  1. A saved API base URL wins (explicit user configuration).
 *  2. Otherwise probe same-origin /api/health (the backend serving this UI).
 *  3. Otherwise fall back to the clearly-labeled offline demo.
 */
export async function initApiMode(): Promise<ApiMode> {
  if (cachedMode) return cachedMode;
  const base = readApiBase();
  if (base) {
    cachedMode = 'server';
    return cachedMode;
  }
  try {
    const res = await fetch('/api/health', {
      signal: typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(3000) : undefined,
    });
    // A backend answers JSON. Some static hosts answer 200 + index.html for
    // any path (SPA history fallback) — that is NOT a backend.
    const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
    if (res.ok && isJson) {
      cachedMode = 'server';
      return cachedMode;
    }
  } catch {
    // unreachable → not served by a backend
  }
  cachedMode = 'demo';
  return cachedMode;
}

export async function getApiMode(): Promise<ApiMode> {
  return cachedMode ?? initApiMode();
}

/** Test hook: forget the cached mode (module state persists across renders). */
export function resetApiModeCache(): void {
  cachedMode = null;
}

function apiUrl(path: string): string {
  return readApiBase() + path;
}

function toThrown(shape: { code?: string; message?: string; detail?: string[]; recoverable?: boolean }): never {
  const err = new Error(shape.message ?? 'Request failed.') as Error & { code?: string; detail?: string[] };
  err.code = shape.code;
  err.detail = shape.detail;
  throw err;
}

export interface CaseStateResponse {
  case: IdeaCase;
  versions: Array<{
    number: number;
    id: string;
    created_at: string;
    summary: string;
    trigger: { kind: string; user_message?: string; proposal_id?: string };
    counts: { added: number; modified: number };
  }>;
  proposals: StoredProposal[];
  messages: ChatMessage[];
  load_warnings: string[];
}

export interface HealthResponse {
  server: string;
  providers: Array<{
    id: string;
    display_name: string;
    model: string;
    privacy: 'local' | 'cloud';
    is_demo: boolean;
    health: { ok: boolean; detail: string; latencyMs?: number };
  }>;
  routing: Array<{ providerId: string; eligible: boolean; reasons: string[] }>;
}

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => null)) as (T & { code?: string; message?: string }) | null;
  if (!res.ok) {
    const message = body?.message ?? `Request failed (HTTP ${res.status})`;
    const detail = (body as { detail?: string[] } | null)?.detail;
    const err = new Error(detail?.length ? `${message} — ${detail.join('; ')}` : message) as Error & {
      code?: string;
      detail?: string[];
    };
    err.code = body?.code;
    err.detail = detail;
    throw err;
  }
  return body as T;
}

export async function fetchCaseState(): Promise<CaseStateResponse> {
  if ((await getApiMode()) === 'demo') return demoBackend.getCaseState();
  return json<CaseStateResponse>(await fetch(apiUrl('/api/case')));
}

export async function fetchConfig(): Promise<RedactedConfig & { startup_notes: string[] }> {
  if ((await getApiMode()) === 'demo') return demoBackend.getConfig();
  return json(await fetch(apiUrl('/api/config')));
}

export async function fetchHealth(): Promise<HealthResponse> {
  if ((await getApiMode()) === 'demo') return demoBackend.getHealth();
  return json<HealthResponse>(await fetch(apiUrl('/api/health')));
}

export async function fetchVersion(n: number): Promise<{ version: VersionRecord }> {
  if ((await getApiMode()) === 'demo') return demoBackend.getVersion(n);
  return json(await fetch(apiUrl(`/api/versions/${n}`)));
}

export async function acceptProposal(
  id: string,
): Promise<{ case: IdeaCase; version: { number: number; summary: string; created_at: string } }> {
  if ((await getApiMode()) === 'demo') return demoBackend.acceptProposal(id);
  const res = await fetch(apiUrl(`/api/proposals/${id}/accept`), { method: 'POST' });
  return json(res);
}

export async function rejectProposal(id: string, reason?: string): Promise<StoredProposal> {
  if ((await getApiMode()) === 'demo') return demoBackend.rejectProposal(id, reason);
  const res = await fetch(apiUrl(`/api/proposals/${id}/reject`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
  return json(res);
}

export async function resetCase(): Promise<CaseStateResponse> {
  if ((await getApiMode()) === 'demo') return demoBackend.resetCase();
  return json(await fetch(apiUrl('/api/case/reset'), { method: 'POST' }));
}

/** Research search — throws a classified error when no provider is configured. */
export interface ResearchSource {
  title: string;
  url: string;
  source_type: string;
  author?: string;
  publication_date?: string;
  excerpt?: string;
}
export interface ResearchResponse {
  query: { question: string };
  sources: ResearchSource[];
  retrieved_at: string;
}

export async function researchSearch(question: string, keywords?: string[]): Promise<ResearchResponse> {
  if ((await getApiMode()) === 'demo') {
    try {
      return await demoBackend.researchSearch();
    } catch (shape) {
      toThrown(shape as { code?: string; message?: string; detail?: string[] });
    }
  }
  const res = await fetch(apiUrl('/api/research'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, keywords }),
  });
  return json(res);
}

/** Run research server-side and create a pending proposal recording it. */
export async function proposeResearch(
  question: string,
): Promise<{ message: ChatMessage; proposal: StoredProposal }> {
  if ((await getApiMode()) === 'demo') {
    try {
      return await demoBackend.proposeResearch();
    } catch (shape) {
      toThrown(shape as { code?: string; message?: string; detail?: string[] });
    }
  }
  const res = await fetch(apiUrl('/api/research/propose'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question }),
  });
  return json(res);
}

/**
 * POST /api/chat as an SSE stream. Calls onEvent for each server event;
 * resolves when the stream ends. Uses fetch-streaming (EventSource cannot
 * POST), which works against the same origin.
 */
export async function streamChat(
  message: string,
  onEvent: (event: ChatEvent) => void,
  signal?: AbortSignal,
  opts?: { deep?: boolean },
): Promise<void> {
  if ((await getApiMode()) === 'demo') {
    await demoBackend.chat(message, opts?.deep === true, onEvent, signal);
    return;
  }
  const res = await fetch(apiUrl('/api/chat'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, deep: opts?.deep === true }),
    signal,
  });
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => null)) as { message?: string; detail?: string[] } | null;
    const message2 = body?.message ?? `Chat request failed (HTTP ${res.status})`;
    onEvent({
      type: 'error',
      error: {
        code: 'INTERNAL',
        message: body?.detail?.length ? `${message2} — ${body.detail.join('; ')}` : message2,
        recoverable: true,
      },
    });
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        try {
          onEvent(JSON.parse(payload) as ChatEvent);
        } catch {
          // ignore malformed event
        }
      }
    }
  }
}

// Re-export shared types used by components.
export type { StoredProposal, Proposal };
