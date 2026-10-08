import { z } from 'zod';

/**
 * Canonical Idea Case schema — the single source of truth for an idea.
 *
 * Design principles:
 * - Every item has a stable identity (id) so change classes are expressible:
 *   new / modified / invalidated / superseded / accepted / rejected.
 * - Every item carries an *epistemic* classification (knowledge_class) and a
 *   *lifecycle* status. These are orthogonal axes and must not be conflated.
 * - Strong epistemic classes (SUPPORTED_BY_EVIDENCE, CONTRADICTED_BY_EVIDENCE,
 *   KNOWN, USER_DECIDED, REJECTED) are only ever assigned by the system
 *   (evidence pipeline, decision records) — never by model output.
 * - Items are never hard-deleted in v0.1; they transition status. Rejected
 *   alternatives are preserved (mirrored into rejected_approaches).
 */

// ---------------------------------------------------------------------------
// Epistemic classification (§16 Knowledge Classification)
// ---------------------------------------------------------------------------

export const MODEL_ASSIGNABLE_CLASSES = [
  'USER_PROVIDED',
  'ASSUMED',
  'INFERRED',
  'UNKNOWN',
  'MODEL_SUGGESTED',
] as const;

/** Classes the model may propose. */
export const ModelAssignableClass = z.enum(MODEL_ASSIGNABLE_CLASSES);
export type ModelAssignableClass = z.infer<typeof ModelAssignableClass>;

/** Classes only the system may assign (evidence pipeline, decisions, review). */
export const SYSTEM_ONLY_CLASSES = [
  'KNOWN',
  'SUPPORTED_BY_EVIDENCE',
  'CONTRADICTED_BY_EVIDENCE',
  'USER_DECIDED',
  'REJECTED',
] as const;

export const KNOWLEDGE_CLASSES = [
  ...MODEL_ASSIGNABLE_CLASSES,
  ...SYSTEM_ONLY_CLASSES,
] as const;

export const KnowledgeClass = z.enum(KNOWLEDGE_CLASSES);
export type KnowledgeClass = z.infer<typeof KnowledgeClass>;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export const ITEM_STATUSES = ['active', 'superseded', 'invalidated', 'rejected'] as const;
export const ItemStatus = z.enum(ITEM_STATUSES);
export type ItemStatus = z.infer<typeof ItemStatus>;

export const ALTERNATIVE_STATUSES = [
  'candidate',
  'considering',
  'accepted',
  'rejected',
  'superseded',
] as const;
export const AlternativeStatus = z.enum(ALTERNATIVE_STATUSES);
export type AlternativeStatus = z.infer<typeof AlternativeStatus>;

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

export const COLLECTIONS = [
  'goals',
  'requirements',
  'assumptions',
  'constraints',
  'unknowns',
  'risks',
  'dependencies',
  'evidence',
  'research_items',
  'alternatives',
  'decisions',
  'rejected_approaches',
  'open_questions',
] as const;
export const Collection = z.enum(COLLECTIONS);
export type Collection = z.infer<typeof Collection>;
export type CollectionKey = (typeof COLLECTIONS)[number];

const isoTimestamp = z.string().min(1);

const Provenance = z.object({
  /** Where this item came from. */
  source: z.enum(['user', 'model', 'system']),
  note: z.string().optional(),
});
export type Provenance = z.infer<typeof Provenance>;

/** Fields shared by all state items. */
const ItemBase = {
  id: z.string().min(1),
  text: z.string().min(1),
  knowledge_class: KnowledgeClass,
  status: ItemStatus,
  created_at: isoTimestamp,
  updated_at: isoTimestamp,
  provenance: Provenance,
  /** Why the last change happened (kept for inspection; full history lives in versions). */
  last_change_reason: z.string().optional(),
};

export const GoalItem = z.object({
  ...ItemBase,
  success_criteria: z.string().optional(),
});
export type GoalItem = z.infer<typeof GoalItem>;

export const RequirementItem = z.object({
  ...ItemBase,
  priority: z.enum(['must', 'should', 'could']).default('should'),
});
export type RequirementItem = z.infer<typeof RequirementItem>;

export const AssumptionItem = z.object({ ...ItemBase, note: z.string().optional() });
export type AssumptionItem = z.infer<typeof AssumptionItem>;

export const ConstraintItem = z.object({
  ...ItemBase,
  /** Hard constraints must hold; soft ones are preferences that may be traded off. */
  hard: z.boolean().default(true),
});
export type ConstraintItem = z.infer<typeof ConstraintItem>;

export const UnknownItem = z.object({
  ...ItemBase,
  priority: z.enum(['high', 'medium', 'low']).default('medium'),
});
export type UnknownItem = z.infer<typeof UnknownItem>;

export const RiskItem = z.object({
  ...ItemBase,
  severity: z.enum(['high', 'medium', 'low']).default('medium'),
});
export type RiskItem = z.infer<typeof RiskItem>;

export const DependencyItem = z.object({ ...ItemBase });
export type DependencyItem = z.infer<typeof DependencyItem>;

/**
 * Evidence records are separate from model guesses (§17 Research Integrity).
 * `external` evidence can only be created by a research provider; the model
 * can only record what the user said (`user`) or flag its own knowledge as
 * unverified (`model_knowledge`). Source is overwritten server-side.
 */
export const SOURCE_TYPES = ['user', 'model_knowledge', 'external'] as const;
export const SourceType = z.enum(SOURCE_TYPES);
export type SourceType = z.infer<typeof SourceType>;

export const EvidenceItem = z.object({
  id: z.string().min(1),
  claim: z.string().min(1),
  source_type: SourceType,
  /** Description of the source. For model_knowledge this is set to the provider/model. */
  source: z.string().min(1),
  url: z.string().optional(),
  author: z.string().optional(),
  publication_date: z.string().optional(),
  retrieved_at: isoTimestamp.optional(),
  excerpt: z.string().optional(),
  relevance: z.enum(['high', 'medium', 'low']).default('medium'),
  /** 0..1 — confidence that the source supports the claim. */
  confidence: z.number().min(0).max(1).default(0.5),
  /** Item ids this evidence supports / contradicts. */
  supports: z.array(z.string()).default([]),
  contradicts: z.array(z.string()).default([]),
  knowledge_class: KnowledgeClass,
  status: ItemStatus,
  created_at: isoTimestamp,
  updated_at: isoTimestamp,
  provenance: Provenance,
  last_change_reason: z.string().optional(),
});
export type EvidenceItem = z.infer<typeof EvidenceItem>;

export const ResearchItem = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  rationale: z.string().optional(),
  priority: z.enum(['high', 'medium', 'low']).default('medium'),
  status: z.enum(['pending', 'in_progress', 'answered', 'blocked']).default('pending'),
  evidence_ids: z.array(z.string()).default([]),
  knowledge_class: KnowledgeClass,
  created_at: isoTimestamp,
  updated_at: isoTimestamp,
  provenance: Provenance,
  last_change_reason: z.string().optional(),
});
export type ResearchItem = z.infer<typeof ResearchItem>;

export const AlternativeItem = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(''),
  advantages: z.array(z.string()).default([]),
  disadvantages: z.array(z.string()).default([]),
  requirements: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  dependencies: z.array(z.string()).default([]),
  evidence_ids: z.array(z.string()).default([]),
  status: AlternativeStatus,
  knowledge_class: KnowledgeClass,
  created_at: isoTimestamp,
  updated_at: isoTimestamp,
  provenance: Provenance,
  last_change_reason: z.string().optional(),
});
export type AlternativeItem = z.infer<typeof AlternativeItem>;

export const DecisionItem = z.object({
  id: z.string().min(1),
  decision: z.string().min(1),
  reason: z.string().default(''),
  basis: z.enum(['user_message', 'model_recommendation', 'evidence']),
  decision_maker: z.enum(['user', 'model']),
  affected_ids: z.array(z.string()).default([]),
  alternatives_considered: z.array(z.string()).default([]),
  evidence_ids: z.array(z.string()).default([]),
  knowledge_class: KnowledgeClass,
  status: ItemStatus,
  created_at: isoTimestamp,
  updated_at: isoTimestamp,
  provenance: Provenance,
  last_change_reason: z.string().optional(),
});
export type DecisionItem = z.infer<typeof DecisionItem>;

export const RejectedApproachItem = z.object({
  ...ItemBase,
  reason: z.string().default(''),
  rejected_by: z.enum(['user', 'model']).default('model'),
  related_alternative_id: z.string().optional(),
});
export type RejectedApproachItem = z.infer<typeof RejectedApproachItem>;

export const OpenQuestionItem = z.object({
  ...ItemBase,
  asked_to: z.enum(['user', 'research']).default('user'),
  answer: z.string().optional(),
  answered_at: isoTimestamp.optional(),
});
export type OpenQuestionItem = z.infer<typeof OpenQuestionItem>;

// ---------------------------------------------------------------------------
// Idea Case
// ---------------------------------------------------------------------------

export const CurrentState = z.object({
  summary: z.string().default(''),
  next_steps: z.array(z.string()).default([]),
});
export type CurrentState = z.infer<typeof CurrentState>;

export const Confidence = z.object({
  /** 0..1 subjective assessment of how well-specified the idea currently is. */
  overall: z.number().min(0).max(1).default(0),
  note: z.string().default(''),
});
export type Confidence = z.infer<typeof Confidence>;

export const IdeaCase = z.object({
  id: z.string().min(1),
  title: z.string().default('Untitled idea'),
  original_idea: z.string().default(''),
  current_intent: z.string().default(''),
  goals: z.array(GoalItem).default([]),
  requirements: z.array(RequirementItem).default([]),
  assumptions: z.array(AssumptionItem).default([]),
  constraints: z.array(ConstraintItem).default([]),
  unknowns: z.array(UnknownItem).default([]),
  risks: z.array(RiskItem).default([]),
  dependencies: z.array(DependencyItem).default([]),
  evidence: z.array(EvidenceItem).default([]),
  research_items: z.array(ResearchItem).default([]),
  alternatives: z.array(AlternativeItem).default([]),
  decisions: z.array(DecisionItem).default([]),
  rejected_approaches: z.array(RejectedApproachItem).default([]),
  open_questions: z.array(OpenQuestionItem).default([]),
  current_state: CurrentState,
  confidence: Confidence,
  /** Per-collection id counters for generating stable short ids. */
  id_counters: z.record(z.string(), z.number().int().min(0)).default({}),
  /** Current version number; history lives in immutable version records. */
  version: z.number().int().min(0),
  created_at: isoTimestamp,
  updated_at: isoTimestamp,
});
export type IdeaCase = z.infer<typeof IdeaCase>;

// ---------------------------------------------------------------------------
// Diffs & versions
// ---------------------------------------------------------------------------

export const FieldChange = z.object({
  field: z.string(),
  from: z.unknown(),
  to: z.unknown(),
});
export type FieldChange = z.infer<typeof FieldChange>;

export const CollectionDiff = z.object({
  added: z.array(z.object({ id: z.string(), text: z.string() })).default([]),
  modified: z
    .array(
      z.object({
        id: z.string(),
        text: z.string().optional(),
        changes: z.array(FieldChange).default([]),
      }),
    )
    .default([]),
});
export type CollectionDiff = z.infer<typeof CollectionDiff>;

export const StateDiff = z.object({
  title: z.object({ from: z.string(), to: z.string() }).optional(),
  current_intent: z.object({ from: z.string(), to: z.string() }).optional(),
  original_idea_set: z.string().optional(),
  confidence: z.object({ from: z.number(), to: z.number() }).optional(),
  collections: z.record(z.string(), CollectionDiff).default({}),
  /** Non-fatal notes from semantic validation (e.g. duplicate adds skipped). */
  warnings: z.array(z.string()).default([]),
});
export type StateDiff = z.infer<typeof StateDiff>;

export const VersionTrigger = z.object({
  kind: z.enum(['initialization', 'user_acceptance', 'user_rejection', 'reset']),
  user_message: z.string().optional(),
  proposal_id: z.string().optional(),
});
export type VersionTrigger = z.infer<typeof VersionTrigger>;

export const VersionRecord = z.object({
  number: z.number().int().min(0),
  id: z.string().min(1),
  parent_version: z.number().int().min(0).nullable(),
  created_at: isoTimestamp,
  trigger: VersionTrigger,
  summary: z.string().default(''),
  diff: StateDiff,
  /** Full snapshot of the case at this version (enables future branching). */
  snapshot: IdeaCase,
});
export type VersionRecord = z.infer<typeof VersionRecord>;

// ---------------------------------------------------------------------------
// Construction helpers
// ---------------------------------------------------------------------------

export function emptyCase(id: string, now: string): IdeaCase {
  const counters: Record<string, number> = {};
  for (const c of COLLECTIONS) counters[c] = 0;
  return {
    id,
    title: 'Untitled idea',
    original_idea: '',
    current_intent: '',
    goals: [],
    requirements: [],
    assumptions: [],
    constraints: [],
    unknowns: [],
    risks: [],
    dependencies: [],
    evidence: [],
    research_items: [],
    alternatives: [],
    decisions: [],
    rejected_approaches: [],
    open_questions: [],
    current_state: { summary: '', next_steps: [] },
    confidence: { overall: 0, note: '' },
    id_counters: counters,
    version: 0,
    created_at: now,
    updated_at: now,
  };
}

/** Short id prefixes per collection (stable, human-referencable). */
export const ID_PREFIXES: Record<CollectionKey, string> = {
  goals: 'goal',
  requirements: 'req',
  assumptions: 'asm',
  constraints: 'cst',
  unknowns: 'unk',
  risks: 'risk',
  dependencies: 'dep',
  evidence: 'ev',
  research_items: 'res',
  alternatives: 'alt',
  decisions: 'dec',
  rejected_approaches: 'rej',
  open_questions: 'oq',
};

export function nextItemId(caseData: IdeaCase, collection: CollectionKey): string {
  const counters = caseData.id_counters;
  const n = (counters[collection] ?? 0) + 1;
  counters[collection] = n;
  const prefix = ID_PREFIXES[collection];
  if (!prefix) throw new Error(`No id prefix for collection ${collection}`);
  return `${prefix}${n}`;
}

/** Collections whose items are rendered generically (text-first). */
export const TEXT_COLLECTIONS: CollectionKey[] = [
  'goals',
  'requirements',
  'assumptions',
  'constraints',
  'unknowns',
  'risks',
  'dependencies',
  'rejected_approaches',
  'open_questions',
];
