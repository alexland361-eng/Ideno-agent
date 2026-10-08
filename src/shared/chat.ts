import { z } from 'zod';
import type { ApiErrorShape } from './errors.js';
import type { StoredProposal } from './schemas/proposal.js';

/**
 * Conversation + streaming contract between the Ideno API and the web UI.
 * The conversation is *supporting context*; the Idea State is canonical (§14).
 */

export const MessageRole = z.enum(['user', 'assistant', 'system']);
export type MessageRole = z.infer<typeof MessageRole>;

export const ChatMessage = z.object({
  id: z.string().min(1),
  role: MessageRole,
  content: z.string(),
  created_at: z.string().min(1),
  /** Proposal shown alongside this assistant message, if any. */
  proposal_id: z.string().optional(),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

// ---------------------------------------------------------------------------
// SSE event stream for POST /api/chat
// ---------------------------------------------------------------------------

export type ChatEvent =
  | { type: 'status'; phase: 'routing' | 'generating' | 'critiquing' | 'validating'; detail?: string }
  | { type: 'token'; text: string }
  | { type: 'reply'; text: string }
  | { type: 'proposal'; proposal: StoredProposal }
  | { type: 'proposal_invalid'; errors: string[]; reasoning_summary?: string }
  | { type: 'error'; error: ApiErrorShape }
  | { type: 'done'; message_id: string; proposal_id?: string };
