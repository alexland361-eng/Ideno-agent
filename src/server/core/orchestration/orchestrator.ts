import type { IdeaCase, VersionRecord } from '../../../shared/schemas/ideaCase.js';
import type { StoredProposal, OrchestratorEnvelope } from '../../../shared/schemas/proposal.js';
import { OrchestratorEnvelope as EnvelopeSchema } from '../../../shared/schemas/proposal.js';
import type { ChatEvent, ChatMessage } from '../../../shared/chat.js';
import { AppError } from '../../../shared/errors.js';
import type { IdenoConfig } from '../../../shared/config.js';
import type { Store, VersionSummary } from '../../persistence/store.js';
import type { AIRuntime } from '../../ai/runtime.js';
import type { Clock } from '../../util/clock.js';
import { iso } from '../../util/clock.js';
import { prefixedId } from '../../util/ids.js';
import { buildEnvelopeWireSchema } from '../../ai/wireSchema.js';
import { validateProposal } from '../state/semanticValidation.js';
import { applyProposal } from '../state/stateManager.js';
import { buildSystemPrompt, buildContextMessages } from './prompts.js';
import { extractPartialStringField } from './partialJson.js';
import type { ResearchProvider, ResearchQuery } from '../../research/interface.js';

/**
 * Orchestrator (§15 Agent Responsibilities) — single orchestrator for v0.1.
 *
 * Owns the in-memory canonical Idea Case (single case per data dir) and
 * coordinates the loop:
 *   user message → context → AI runtime → envelope validation →
 *   semantic validation → pending proposal → human review → apply → version.
 *
 * The model NEVER mutates state directly; every mutation flows through
 * applyProposal on a validated, accepted proposal.
 */

const MAX_USER_MESSAGE_CHARS = 20_000;

export interface TurnOutcome {
  messageId: string;
  proposalId?: string;
}

export class Orchestrator {
  private caseData!: IdeaCase;
  private loadWarnings: string[] = [];
  /** Serializes state-mutating operations (accept/reject/reset). */
  private opChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: Store,
    private readonly runtime: AIRuntime,
    private readonly clock: Clock,
    private readonly config: IdenoConfig,
    private readonly research: ResearchProvider,
  ) {}

  async init(): Promise<string[]> {
    const loaded = await this.store.load();
    this.caseData = loaded.caseData;
    this.loadWarnings = loaded.warnings;
    return loaded.warnings;
  }

  getCase(): IdeaCase {
    return this.caseData;
  }

  getLoadWarnings(): string[] {
    return this.loadWarnings;
  }

  listMessages(limit?: number): Promise<ChatMessage[]> {
    return this.store.listMessages(limit);
  }

  listProposals(): Promise<StoredProposal[]> {
    return this.store.listProposals();
  }

  listVersions(): Promise<VersionSummary[]> {
    return this.store.listVersions();
  }

  async getVersion(n: number): Promise<VersionRecord | undefined> {
    return this.store.getVersion(n);
  }

  /**
   * External research (§17). Research providers are separate from LLM
   * providers; in v0.1 the configured provider is the explicit
   * NoResearchProvider, so this fails with a classified error instead of
   * pretending to work. When a real research provider is configured, results
   * carry traceable sources and become evidence records.
   */
  researchSearch(query: ResearchQuery) {
    return this.research.search(query);
  }

  // -------------------------------------------------------------------------

  /**
   * Process one user message. Yields streaming events for the UI; persistence
   * of the reply/proposal happens inside so a reload shows the same outcome.
   */
  async *handleUserMessage(
    text: string,
    signal?: AbortSignal,
  ): AsyncGenerator<ChatEvent, TurnOutcome | undefined> {
    const trimmed = text.trim();
    if (!trimmed) {
      yield badRequest('Message is empty.');
      return undefined;
    }
    if (trimmed.length > MAX_USER_MESSAGE_CHARS) {
      yield badRequest(`Message is too long (${trimmed.length} chars; max ${MAX_USER_MESSAGE_CHARS}).`);
      return undefined;
    }

    await this.store.appendMessage({
      id: prefixedId('msg'),
      role: 'user',
      content: trimmed,
      created_at: iso(this.clock),
    });

    yield { type: 'status', phase: 'routing' };

    const system = buildSystemPrompt(this.caseData);
    const recent = await this.store.listMessages(this.config.context.recent_messages + 1);
    const history = recent.slice(0, -1); // exclude the message just appended
    const messages = buildContextMessages(history, trimmed);

    yield { type: 'status', phase: 'generating' };

    let lastPartial = '';
    let envelope: OrchestratorEnvelope | undefined;
    let providerLabel = 'unknown';

    try {
      const gen = this.runtime.streamStructured<OrchestratorEnvelope>({
        task: 'conversation',
        system,
        messages,
        schemaName: 'ideno_turn',
        zodSchema: EnvelopeSchema,
        wireSchema: buildEnvelopeWireSchema(),
        temperature: 0.4,
        signal,
      });
      while (true) {
        const next = await gen.next();
        if (next.done) {
          envelope = next.value.value;
          providerLabel = `${next.value.providerId}/${next.value.model}`;
          break;
        }
        const ev = next.value;
        if (ev.type === 'partial') {
          const partial = extractPartialStringField(ev.accumulated, 'reply');
          if (partial !== null && partial.length > lastPartial.length) {
            yield { type: 'token', text: partial.slice(lastPartial.length) };
            lastPartial = partial;
          }
        }
        // 'repair' events are internal; surfaced via the final result.
      }
    } catch (err) {
      const error = toApiError(err);
      yield { type: 'error', error };
      await this.store.appendMessage(
        systemNotice(this.clock, `Turn failed before completing (${error.code}): ${error.message}`),
      );
      return undefined;
    }

    if (!envelope) {
      const error = toApiError(new AppError('MODEL_ERROR', 'No result produced.'));
      yield { type: 'error', error };
      return undefined;
    }

    // The parsed envelope is authoritative — replace the streamed preview.
    yield { type: 'reply', text: envelope.reply };

    const assistantMessage: ChatMessage = {
      id: prefixedId('msg'),
      role: 'assistant',
      content: envelope.reply,
      created_at: iso(this.clock),
    };

    if (envelope.proposal) {
      yield { type: 'status', phase: 'validating' };
      const validation = validateProposal(this.caseData, envelope.proposal);
      if (validation.errors.length > 0) {
        // Never let a semantically invalid proposal near the state.
        yield {
          type: 'proposal_invalid',
          errors: validation.errors,
          reasoning_summary: envelope.proposal.reasoning_summary || undefined,
        };
        await this.store.appendMessage(assistantMessage);
        await this.store.appendMessage(
          systemNotice(this.clock,
            `A proposed state change was rejected automatically (failed semantic validation): ${validation.errors[0] ?? 'unknown error'} State was not modified.`,
          ),
        );
        yield { type: 'done', message_id: assistantMessage.id };
        return { messageId: assistantMessage.id };
      }

      const stored: StoredProposal = {
        id: prefixedId('prop'),
        status: 'pending',
        created_at: iso(this.clock),
        user_message: trimmed,
        proposal: envelope.proposal,
        provider: providerLabel,
        warnings: validation.warnings,
      };
      await this.store.saveProposal(stored);
      assistantMessage.proposal_id = stored.id;
      await this.store.appendMessage(assistantMessage);
      yield { type: 'proposal', proposal: stored };
      yield { type: 'done', message_id: assistantMessage.id, proposal_id: stored.id };
      return { messageId: assistantMessage.id, proposalId: stored.id };
    }

    await this.store.appendMessage(assistantMessage);
    yield { type: 'done', message_id: assistantMessage.id };
    return { messageId: assistantMessage.id };
  }

  // -------------------------------------------------------------------------

  /** Human accepted a proposal: apply atomically, create a version. */
  async acceptProposal(proposalId: string): Promise<{ caseData: IdeaCase; version: VersionRecord }> {
    const result = await this.serialize(() => this.mutateProposal(proposalId, 'accept'));
    return result as { caseData: IdeaCase; version: VersionRecord };
  }

  /** Human rejected a proposal: record the rejection; state is untouched. */
  async rejectProposal(proposalId: string, reason?: string): Promise<StoredProposal> {
    const result = await this.serialize(() => this.mutateProposal(proposalId, 'reject', reason));
    return result as StoredProposal;
  }

  /** Start a fresh case; previous data is archived, never deleted. */
  async reset(): Promise<IdeaCase> {
    return this.serialize(async () => {
      const loaded = await this.store.reset();
      this.caseData = loaded.caseData;
      this.loadWarnings = loaded.warnings;
      return this.caseData;
    });
  }

  private serialize<T>(op: () => Promise<T>): Promise<T> {
    const next = this.opChain.then(op, op);
    this.opChain = next.catch(() => undefined);
    return next;
  }

  private async mutateProposal(
    proposalId: string,
    action: 'accept' | 'reject',
    reason?: string,
  ): Promise<{ caseData: IdeaCase; version: VersionRecord } | StoredProposal> {
    const stored = await this.store.getProposal(proposalId);
    if (!stored) {
      throw new AppError('PROPOSAL_NOT_FOUND', `Proposal '${proposalId}' does not exist.`);
    }
    if (stored.status !== 'pending') {
      throw new AppError(
        'STATE_CONFLICT',
        `Proposal '${proposalId}' was already ${stored.status}.`,
        {
          detail: action === 'accept' ? ['Only pending proposals can be accepted.'] : undefined,
          recoverable: false,
        },
      );
    }

    if (action === 'reject') {
      stored.status = 'rejected';
      stored.resolved_at = iso(this.clock);
      stored.rejection_reason = reason;
      await this.store.saveProposal(stored);
      await this.store.appendMessage(
        systemNotice(this.clock,
          `Change proposal rejected${reason ? ` (${reason})` : ''}. State unchanged (v${this.caseData.version}).`,
        ),
      );
      return stored;
    }

    // Accept: re-validate against the CURRENT state — it may have moved on.
    const validation = validateProposal(this.caseData, stored.proposal);
    if (validation.errors.length > 0) {
      stored.status = 'invalid';
      stored.resolved_at = iso(this.clock);
      await this.store.saveProposal(stored);
      throw new AppError(
        'PROPOSAL_INVALID',
        `Proposal '${proposalId}' no longer applies to the current state (it was created against an older version).`,
        { detail: validation.errors, recoverable: false },
      );
    }

    const { nextCase, version } = applyProposal(this.caseData, stored, validation, {
      now: iso(this.clock),
      providerLabel: stored.provider,
    });

    // Version first, then case — a crash between the two rolls forward on load.
    await this.store.appendVersion(version);
    await this.store.saveCase(nextCase);
    this.caseData = nextCase;

    stored.status = 'accepted';
    stored.resolved_at = iso(this.clock);
    stored.resulting_version = version.number;
    await this.store.saveProposal(stored);
    await this.store.appendMessage(
      systemNotice(this.clock, `Change proposal accepted → version v${version.number}. ${version.summary}`),
    );
    return { caseData: nextCase, version };
  }
}

function systemNotice(clock: Clock, content: string): ChatMessage {
  return {
    id: prefixedId('msg'),
    role: 'system',
    content,
    created_at: iso(clock),
  };
}

function badRequest(message: string): ChatEvent {
  return { type: 'error', error: { code: 'BAD_REQUEST', message, recoverable: true } };
}

function toApiError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  return new AppError('INTERNAL', 'An unexpected internal error occurred.', {
    detail: [err instanceof Error ? `${err.name}: ${err.message}` : String(err)],
    cause: err,
  });
}
