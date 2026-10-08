import { z } from 'zod';
import { ModelAssignableClass } from './ideaCase.js';

/**
 * Proposal schema — the ONLY channel through which the model can affect state.
 *
 * The model returns an envelope: a conversational reply plus an optional
 * proposal. A proposal is a *suggestion*; it becomes application state only
 * after schema validation, semantic validation, and human acceptance (§24).
 *
 * Note: added items never carry ids — ids are assigned by the state manager.
 * Modified items reference existing ids the model saw in its context.
 */

const knowledgeClass = ModelAssignableClass;

// ---------------------------------------------------------------------------
// Added items (per collection)
// ---------------------------------------------------------------------------

const GoalAdd = z.object({
  text: z.string().min(1),
  knowledge_class: knowledgeClass,
  success_criteria: z.string().optional(),
});

const RequirementAdd = z.object({
  text: z.string().min(1),
  knowledge_class: knowledgeClass,
  priority: z.enum(['must', 'should', 'could']).optional(),
});

const AssumptionAdd = z.object({
  text: z.string().min(1),
  knowledge_class: knowledgeClass,
  note: z.string().optional(),
});

const ConstraintAdd = z.object({
  text: z.string().min(1),
  knowledge_class: knowledgeClass,
  hard: z.boolean().optional(),
});

const UnknownAdd = z.object({
  text: z.string().min(1),
  knowledge_class: knowledgeClass.optional(),
  priority: z.enum(['high', 'medium', 'low']).optional(),
});

const RiskAdd = z.object({
  text: z.string().min(1),
  knowledge_class: knowledgeClass.optional(),
  severity: z.enum(['high', 'medium', 'low']).optional(),
});

const DependencyAdd = z.object({
  text: z.string().min(1),
  knowledge_class: knowledgeClass.optional(),
});

/**
 * Model-provided evidence is heavily restricted: it may only record what the
 * user said, or flag its own knowledge as unverified. `external` evidence
 * requires a research provider (none is configured in v0.1), and fabricating
 * sources is forbidden — source is overwritten server-side.
 */
const EvidenceAdd = z.object({
  claim: z.string().min(1),
  source_type: z.enum(['user', 'model_knowledge']),
  relevance: z.enum(['high', 'medium', 'low']).optional(),
  confidence: z.number().min(0).max(1).optional(),
  note: z.string().optional(),
  /** Item ids this evidence relates to. */
  supports: z.array(z.string()).optional(),
  contradicts: z.array(z.string()).optional(),
});

const ResearchItemAdd = z.object({
  question: z.string().min(1),
  rationale: z.string().optional(),
  priority: z.enum(['high', 'medium', 'low']).optional(),
});

const AlternativeAdd = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  advantages: z.array(z.string()).default([]),
  disadvantages: z.array(z.string()).default([]),
  requirements: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  dependencies: z.array(z.string()).default([]),
  status: z.enum(['candidate', 'considering']).optional(),
  /** Short key so other parts of the same proposal can reference this alternative. */
  key: z.string().optional(),
});

const DecisionAdd = z
  .object({
    decision: z.string().min(1),
    reason: z.string().default(''),
    basis: z.enum(['user_message', 'model_recommendation', 'evidence']),
    decision_maker: z.enum(['user', 'model']),
    affected_ids: z.array(z.string()).optional(),
    /** Alternative ids, or keys of alternatives added in this same proposal. */
    alternatives_considered: z.array(z.string()).optional(),
  })
  .refine((d) => !(d.decision_maker === 'user' && d.basis !== 'user_message'), {
    message: "A decision attributed to the user must cite basis 'user_message'.",
    path: ['basis'],
  });

const RejectedApproachAdd = z.object({
  text: z.string().min(1),
  reason: z.string().default(''),
  /** Only 'user' when the user explicitly rejected this approach in the conversation. */
  rejected_by: z.enum(['user', 'model']).optional(),
});

const OpenQuestionAdd = z.object({
  text: z.string().min(1),
  asked_to: z.enum(['user', 'research']).optional(),
});

// ---------------------------------------------------------------------------
// Modified items (per collection)
// ---------------------------------------------------------------------------

const ModifiedBase = z.object({
  id: z.string().min(1),
  /** Why this change is proposed. Required for inspection. */
  reason: z.string().min(1),
});

const TextModified = ModifiedBase.extend({
  text: z.string().min(1).optional(),
  note: z.string().optional(),
  knowledge_class: knowledgeClass.optional(),
  status: z.enum(['active', 'superseded', 'invalidated', 'rejected']).optional(),
});

const RequirementModified = TextModified.extend({
  priority: z.enum(['must', 'should', 'could']).optional(),
});

const ConstraintModified = TextModified.extend({
  hard: z.boolean().optional(),
});

const UnknownModified = TextModified.extend({
  priority: z.enum(['high', 'medium', 'low']).optional(),
});

const RiskModified = TextModified.extend({
  severity: z.enum(['high', 'medium', 'low']).optional(),
});

const GoalModified = TextModified.extend({
  success_criteria: z.string().optional(),
});

const AlternativeModified = ModifiedBase.extend({
  name: z.string().optional(),
  description: z.string().optional(),
  advantages: z.array(z.string()).optional(),
  disadvantages: z.array(z.string()).optional(),
  status: z.enum(['candidate', 'considering', 'accepted', 'rejected', 'superseded']).optional(),
});

const OpenQuestionModified = TextModified.extend({
  answer: z.string().optional(),
});

const EvidenceModified = ModifiedBase.extend({
  claim: z.string().optional(),
  relevance: z.enum(['high', 'medium', 'low']).optional(),
  confidence: z.number().min(0).max(1).optional(),
  status: z.enum(['active', 'superseded', 'invalidated', 'rejected']).optional(),
});

const ResearchItemModified = ModifiedBase.extend({
  status: z.enum(['pending', 'in_progress', 'answered', 'blocked']).optional(),
});

function changeSet<A extends z.ZodTypeAny, M extends z.ZodTypeAny>(added: A, modified: M) {
  return z
    .object({
      added: z.array(added).max(20).default([]),
      modified: z.array(modified).max(30).default([]),
    })
    .default({ added: [], modified: [] });
}

// ---------------------------------------------------------------------------
// Proposal
// ---------------------------------------------------------------------------

export const ProposalChanges = z.object({
  goals: changeSet(GoalAdd, GoalModified),
  requirements: changeSet(RequirementAdd, RequirementModified),
  assumptions: changeSet(AssumptionAdd, TextModified),
  constraints: changeSet(ConstraintAdd, ConstraintModified),
  unknowns: changeSet(UnknownAdd, UnknownModified),
  risks: changeSet(RiskAdd, RiskModified),
  dependencies: changeSet(DependencyAdd, TextModified),
  evidence: changeSet(EvidenceAdd, EvidenceModified),
  research_items: changeSet(ResearchItemAdd, ResearchItemModified),
  alternatives: changeSet(AlternativeAdd, AlternativeModified),
  decisions: changeSet(DecisionAdd, ModifiedBase),
  rejected_approaches: changeSet(RejectedApproachAdd, ModifiedBase),
  open_questions: changeSet(OpenQuestionAdd, OpenQuestionModified),
});
export type ProposalChanges = z.infer<typeof ProposalChanges>;

export const ImpactAnalysis = z.object({
  area: z.string().min(1),
  effect: z.string().min(1),
  reason: z.string().default(''),
});
export type ImpactAnalysis = z.infer<typeof ImpactAnalysis>;

export const ConflictReport = z.object({
  description: z.string().min(1),
  affected_ids: z.array(z.string()).default([]),
  suggested_resolutions: z.array(z.string()).default([]),
});
export type ConflictReport = z.infer<typeof ConflictReport>;

export const Proposal = z.object({
  /** New title for the case (usually early in development). */
  title: z.string().min(1).optional(),
  current_intent: z.string().optional(),
  /** May only be set when the case has no original idea yet (validated server-side). */
  original_idea: z.string().optional(),
  changes: ProposalChanges,
  impact_analysis: z.array(ImpactAnalysis).max(20).default([]),
  conflicts: z.array(ConflictReport).max(10).default([]),
  /** At most two high-impact questions (validated; models are told to prefer one). */
  questions: z.array(z.string().min(1)).max(2).default([]),
  reasoning_summary: z.string().default(''),
  confidence: z
    .object({
      overall: z.number().min(0).max(1),
      note: z.string().optional(),
    })
    .optional(),
  current_state: z
    .object({
      summary: z.string(),
      next_steps: z.array(z.string()).max(8).default([]),
    })
    .optional(),
});
export type Proposal = z.infer<typeof Proposal>;

export const OrchestratorEnvelope = z.object({
  /** Plain conversational text shown to the user. First field so it can stream. */
  reply: z.string().min(1),
  proposal: Proposal.optional(),
});
export type OrchestratorEnvelope = z.infer<typeof OrchestratorEnvelope>;
/** Input shape (collections optional, defaults not yet applied) — used by producers like the demo provider. */
export type OrchestratorEnvelopeInput = z.input<typeof OrchestratorEnvelope>;
export type ProposalInput = z.input<typeof Proposal>;

// A stored proposal needs a timestamp but must not fabricate one — the server stamps it.
const isoTimestamp = z.string().min(1);

// ---------------------------------------------------------------------------
// Stored proposal records (server-side persistence)
// ---------------------------------------------------------------------------

export const PROPOSAL_STATUSES = ['pending', 'accepted', 'rejected', 'invalid'] as const;
export const ProposalStatus = z.enum(PROPOSAL_STATUSES);
export type ProposalStatus = z.infer<typeof ProposalStatus>;

/** A proposal as stored/inspected server-side, with lifecycle metadata. */
export const StoredProposal = z.object({
  id: z.string().min(1),
  status: ProposalStatus,
  created_at: isoTimestamp,
  /** User message that triggered the proposal. */
  user_message: z.string(),
  proposal: Proposal,
  /** Provider/model that produced the proposal (provenance). */
  provider: z.string().default('unknown'),
  /** Populated after semantic validation; shown on the review card. */
  warnings: z.array(z.string()).default([]),
  resolved_at: z.string().optional(),
  resulting_version: z.number().int().optional(),
  rejection_reason: z.string().optional(),
});
export type StoredProposal = z.infer<typeof StoredProposal>;
