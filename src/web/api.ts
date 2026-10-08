import type { ChatEvent, ChatMessage } from '../shared/chat.js';
import type { StoredProposal, Proposal } from '../shared/schemas/proposal.js';
import type { VersionRecord, IdeaCase } from '../shared/schemas/ideaCase.js';
import type { RedactedConfig } from '../shared/config.js';

/**
 * Typed client for the Ideno API. The browser talks only to the Ideno
 * backend — never to any AI provider directly.
 */

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
  return json<CaseStateResponse>(await fetch('/api/case'));
}

export async function fetchConfig(): Promise<RedactedConfig & { startup_notes: string[] }> {
  return json(await fetch('/api/config'));
}

export async function fetchHealth(): Promise<HealthResponse> {
  return json<HealthResponse>(await fetch('/api/health'));
}

export async function fetchVersion(n: number): Promise<{ version: VersionRecord }> {
  return json(await fetch(`/api/versions/${n}`));
}

export async function acceptProposal(
  id: string,
): Promise<{ case: IdeaCase; version: { number: number; summary: string; created_at: string } }> {
  const res = await fetch(`/api/proposals/${id}/accept`, { method: 'POST' });
  return json(res);
}

export async function rejectProposal(id: string, reason?: string): Promise<StoredProposal> {
  const res = await fetch(`/api/proposals/${id}/reject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
  return json(res);
}

export async function resetCase(): Promise<CaseStateResponse> {
  return json(await fetch('/api/case/reset', { method: 'POST' }));
}

/** Research search — throws a classified error when no provider is configured. */
export async function researchSearch(question: string, keywords?: string[]): Promise<unknown> {
  const res = await fetch('/api/research', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, keywords }),
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
): Promise<void> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
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
