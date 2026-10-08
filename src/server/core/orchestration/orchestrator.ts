import type { z } from 'zod';
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
import { buildEnvelopeWireSchema, buildCritiqueWireSchema } from '../../ai/wireSchema.js';
import { validateProposal } from '../state/semanticValidation.js';
import { applyProposal } from '../state/stateManager.js';
import { buildSystemPrompt, buildContextMessages, buildCritiqueMessages } from './prompts.js';
import { CritiqueResult as CritiqueSchema } from '../../../shared/schemas/proposal.js';
type CritiqueType = z.infer<typeof CritiqueSchema>;
import { extractPartialStringField } from './partialJson.js';
import type { ResearchProvider, ResearchQuery, ResearchResult } from '../../research/interface.js';

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

  /**
   * Run external research and propose recording the findings (§17 + §27).
   *
   * Sources come from the configured research provider — never from the
   * model. The proposal adds research ITEMS (questions to investigate); the
   * sourced results themselves are listed in the assistant reply and remain
   * reviewable in the Research view. Nothing enters the Idea State until the
   * human accepts the proposal, exactly like any model-proposed change.
   */
  async proposeResearchFindings(
    question: string,
  ): Promise<{ message: ChatMessage; proposal: StoredProposal }> {
    const trimmed = question.trim();
    if (!trimmed) {
      throw new AppError('BAD_REQUEST', 'Research question is empty.');
    }
    const result = await this.research.search({ question: trimmed, max_results: 5 });
    if (result.sources.length === 0) {
      throw new AppError('RESEARCH_UNAVAILABLE', 'The research provider returned no usable sources.', {
        recoverable: true,
      });
    }

    const sourceLines = result.sources.map(
      (src, i) =>
        `${i + 1}. ${src.title}${src.publication_date ? ` (${src.publication_date})` : ''} — ${src.url}`,
    );
    const reply = [
      `Research: “${trimmed}”`,
      '',
      `Retrieved ${result.sources.length} sourced result(s) via ${this.research.displayName}. Sources:`,
      ...sourceLines,
      '',
      'I propose recording this as a research item in the Idea State. Review the sources before accepting — I did not verify their claims.',
    ].join('\n');

    const emptySet = { added: [], modified: [] };
    const proposal = {
      changes: {
        goals: emptySet,
        requirements: emptySet,
        assumptions: emptySet,
        constraints: emptySet,
        unknowns: emptySet,
        risks: emptySet,
        dependencies: emptySet,
        evidence: emptySet,
        research_items: {
          added: [
            {
              question: trimmed,
              rationale: `External research via ${this.research.displayName}: ${result.sources.length} sources retrieved ${result.retrieved_at}.`,
              priority: 'medium' as const,
            },
          ],
          modified: [],
        },
        alternatives: emptySet,
        decisions: emptySet,
        rejected_approaches: emptySet,
        open_questions: emptySet,
      },
      impact_analysis: [
        {
          area: 'Research',
          effect: 'Adds one research question with sourced context to investigate.',
          reason: 'Human-initiated research; sources are external and unverified by the model.',
        },
      ],
      conflicts: [],
      questions: [],
      reasoning_summary: `Sourced research via ${this.research.displayName} — ${result.sources.length} results. Model statements are not evidence; only provider-returned sources are cited.`,
    };

    const validation = validateProposal(this.caseData, proposal);
    if (validation.errors.length > 0) {
      throw new AppError('VALIDATION_FAILED', 'Research proposal failed semantic validation.', {
        detail: validation.errors,
      });
    }

    const stored: StoredProposal = {
      id: prefixedId('prop'),
      status: 'pending',
      created_at: iso(this.clock),
      user_message: `[research] ${trimmed}`,
      proposal,
      provider: this.research.id,
      warnings: validation.warnings,
    };
    await this.store.saveProposal(stored);

    const message: ChatMessage = {
      id: prefixedId('msg'),
      role: 'assistant',
      content: reply,
      created_at: iso(this.clock),
      proposal_id: stored.id,
    };
    await this.store.appendMessage(message);
    return { message, proposal: stored };
  }

  // -------------------------------------------------------------------------

  /**
   * Process one user message. Yields streaming events for the UI; persistence
   * of the reply/proposal happens inside so a reload shows the same outcome.
   */
  async *handleUserMessage(
    text: string,
    signal?: AbortSignal,
    opts?: { deep?: boolean },
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

      const warnings = [...validation.warnings];
      let critique: z.infer<typeof CritiqueSchema> | undefined;

      if (opts?.deep) {
        // Deep analysis: adversarial second pass over the draft. Findings
        // are surfaced to the human; they never mutate the proposal.
        yield { type: 'status', phase: 'critiquing' };
        try {
          const crit = buildCritiqueMessages(this.caseData, envelope.proposal, trimmed);
          const critRun = await this.runtime.runStructured<CritiqueType>({
            task: 'critique',
            system: crit.system,
            messages: crit.messages,
            schemaName: 'ideno_critique',
            zodSchema: CritiqueSchema,
            wireSchema: buildCritiqueWireSchema(),
            temperature: 0.3,
            signal,
          });
          const found: CritiqueType = critRun.value;
          critique = found;
          for (const issue of found.issues) {
            warnings.push(`Critique (${issue.severity}) — ${issue.area}: ${issue.description}`);
          }
          for (const m of found.missing_considerations) {
            warnings.push(`Critique — possibly missing: ${m}`);
          }
        } catch (err) {
          // A failed critique must not lose the user's turn: the proposal
          // proceeds with a warning that the deep pass did not complete.
          warnings.push(
            `Deep-analysis pass failed (${err instanceof Error ? err.message : String(err)}); proposal was not adversarially reviewed.`,
          );
        }
      }

      const stored: StoredProposal = {
        id: prefixedId('prop'),
        status: 'pending',
        created_at: iso(this.clock),
        user_message: trimmed,
        proposal: envelope.proposal,
        provider: providerLabel,
        warnings,
        ...(critique ? { critique } : {}),
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
