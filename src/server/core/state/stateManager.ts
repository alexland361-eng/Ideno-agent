import type {
  CollectionKey,
  IdeaCase,
  StateDiff,
  VersionRecord,
  FieldChange,
} from '../../../shared/schemas/ideaCase.js';
import { nextItemId } from '../../../shared/schemas/ideaCase.js';
import type { StoredProposal } from '../../../shared/schemas/proposal.js';
import { prefixedId } from '../../util/ids.js';
import { normalizeText } from './semanticValidation.js';
import type { ValidationOutcome } from './semanticValidation.js';

/**
 * State manager (§4, §24, §27).
 *
 * applyProposal is PURE: it clones the case, applies the validated proposal,
 * and returns the next case + a version record. The caller persists both.
 * Because it operates on a clone, a throw anywhere leaves the canonical
 * in-memory state untouched — malformed or conflicting updates can never
 * partially apply.
 *
 * Deterministic integrity rules applied here (never trusted to the model):
 *   - item ids are generated server-side
 *   - evidence sources are overwritten server-side (model cannot fabricate)
 *   - decisions get knowledge_class USER_DECIDED/MODEL_SUGGESTED by maker
 *   - rejected/superseded alternatives are mirrored into rejected_approaches
 *     and never deleted
 */

export interface ApplyOptions {
  now: string;
  /** Label of the provider that produced the proposal, for provenance. */
  providerLabel: string;
}

export interface ApplyResult {
  nextCase: IdeaCase;
  version: VersionRecord;
}

// Internal loose item view — shapes were validated by Zod beforehand.
type Item = Record<string, unknown> & { id: string };

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v)) : [];
}

export function applyProposal(
  caseData: IdeaCase,
  stored: StoredProposal,
  validation: ValidationOutcome,
  opts: ApplyOptions,
): ApplyResult {
  const proposal = stored.proposal;
  const next = structuredClone(caseData) as IdeaCase;
  const diff: StateDiff = { collections: {}, warnings: [...validation.warnings] };
  const { now } = opts;

  // --- scalar fields ---
  if (proposal.title !== undefined && proposal.title !== next.title) {
    diff.title = { from: next.title, to: proposal.title };
    next.title = proposal.title;
  }
  if (proposal.current_intent !== undefined && proposal.current_intent !== next.current_intent) {
    diff.current_intent = { from: next.current_intent, to: proposal.current_intent };
    next.current_intent = proposal.current_intent;
  }
  if (proposal.original_idea !== undefined && next.original_idea === '') {
    diff.original_idea_set = proposal.original_idea;
    next.original_idea = proposal.original_idea;
  }
  if (proposal.confidence !== undefined && proposal.confidence.overall !== next.confidence.overall) {
    diff.confidence = { from: next.confidence.overall, to: proposal.confidence.overall };
    next.confidence = {
      overall: proposal.confidence.overall,
      note: proposal.confidence.note ?? next.confidence.note,
    };
  }
  if (proposal.current_state !== undefined) {
    next.current_state = {
      summary: proposal.current_state.summary,
      next_steps: [...proposal.current_state.next_steps],
    };
  }

  const appliedAltStatusChanges: Array<{ alt: Item; status: string; reason: string }> = [];

  for (const collection of Object.keys(proposal.changes) as CollectionKey[]) {
    const changes = proposal.changes[collection];
    const addedItems = changes?.added ?? [];
    const modifiedItems = changes?.modified ?? [];
    if (addedItems.length === 0 && modifiedItems.length === 0) continue;
    const items = next[collection] as unknown as Item[];
    const skip = validation.skipAdd[collection] ?? new Set<number>();
    const collectionDiff = { added: [] as Array<{ id: string; text: string }>, modified: [] as Array<{ id: string; text?: string; changes: FieldChange[] }> };

    // --- adds ---
    addedItems.forEach((add, index) => {
      if (skip.has(index)) return;
      const item = buildItem(next, collection, add, opts, stored);
      items.push(item as never);
      collectionDiff.added.push({ id: item.id, text: itemText(item) });
    });

    // --- modifications ---
    const mods = modifiedItems as Array<Record<string, unknown> & { id: string; reason: string }>;
    for (const mod of mods) {
      const item = items.find((i) => i.id === mod.id);
      if (!item) continue; // validation already blocked this case
      const changesMade: FieldChange[] = [];
      const patch: Record<string, unknown> = mod;
      for (const [field, value] of Object.entries(patch)) {
        if (field === 'id' || field === 'reason') continue;
        const before = item[field];
        if (JSON.stringify(before) === JSON.stringify(value)) continue;
        changesMade.push({ field, from: before ?? null, to: value });
        item[field] = value;
      }
      if (mod.status === 'rejected' || mod.status === 'superseded' || mod.status === 'invalidated') {
        // status changes always recorded even if identical (explicit invalidation)
        if (!changesMade.some((c) => c.field === 'status')) {
          changesMade.push({ field: 'status', from: item.status, to: mod.status });
        }
        item.status = mod.status;
      }
      item.updated_at = now;
      item.last_change_reason = mod.reason;
      if (collection === 'open_questions' && patch.answer !== undefined) {
        item.answered_at = now;
      }
      if (collection === 'alternatives' && typeof patch.status === 'string') {
        const alt = item as unknown as { id: string; name: string; description: string };
        appliedAltStatusChanges.push({ alt: item, status: patch.status, reason: mod.reason });
        void alt;
      }
      collectionDiff.modified.push({
        id: mod.id,
        text: typeof item.text === 'string' ? item.text : undefined,
        changes: changesMade,
      });
    }

    if (collectionDiff.added.length > 0 || collectionDiff.modified.length > 0) {
      diff.collections[collection] = collectionDiff;
    }
  }

  // --- deterministic mirrors ---

  // Rejected/superseded alternatives are preserved in rejected_approaches.
  const rejectedList = next.rejected_approaches as unknown as Item[];
  const existingRejected = new Set(
    rejectedList.map((r) => r.related_alternative_id ?? normalizeText(String(r.text ?? ''))),
  );
  for (const { alt, status, reason } of appliedAltStatusChanges) {
    if (status !== 'rejected' && status !== 'superseded') continue;
    const key = alt.id;
    if (existingRejected.has(key)) continue;
    const id = nextItemId(next, 'rejected_approaches');
    const text = `${String(alt.name)} — ${String(alt.description ?? '')}`.trim();
    rejectedList.push({
      id,
      text,
      reason,
      rejected_by: 'user' as const,
      related_alternative_id: alt.id,
      knowledge_class: 'REJECTED',
      status: 'active',
      created_at: now,
      updated_at: now,
      provenance: { source: 'system', note: 'Auto-recorded when the alternative was rejected/superseded.' },
      last_change_reason: reason,
    } as never);
    existingRejected.add(key);
    const rejDiff = diff.collections.rejected_approaches ?? { added: [], modified: [] };
    rejDiff.added.push({ id, text });
    diff.collections.rejected_approaches = rejDiff;
  }

  next.updated_at = now;
  next.version = caseData.version + 1;

  const summary = buildSummary(proposal.reasoning_summary, diff);
  const version: VersionRecord = {
    number: next.version,
    id: prefixedId('ver'),
    parent_version: caseData.version,
    created_at: now,
    trigger: {
      kind: 'user_acceptance',
      user_message: stored.user_message,
      proposal_id: stored.id,
    },
    summary,
    diff,
    snapshot: next,
  };

  return { nextCase: next, version };
}

// ---------------------------------------------------------------------------

function buildItem(
  caseData: IdeaCase,
  collection: CollectionKey,
  add: Record<string, unknown>,
  opts: ApplyOptions,
  stored: StoredProposal,
): Item {
  const { now } = opts;
  const id = nextItemId(caseData, collection);
  const base = {
    id,
    status: 'active',
    created_at: now,
    updated_at: now,
    provenance: { source: 'model', note: `From proposal ${stored.id} (${opts.providerLabel}).` },
  };

  switch (collection) {
    case 'goals':
      return {
        ...base,
        text: add.text,
        knowledge_class: add.knowledge_class,
        success_criteria: add.success_criteria,
      } as Item;
    case 'requirements':
      return {
        ...base,
        text: add.text,
        knowledge_class: add.knowledge_class,
        priority: add.priority ?? 'should',
      } as Item;
    case 'assumptions':
    case 'constraints': {
      const item: Item = {
        ...base,
        text: add.text,
        knowledge_class: add.knowledge_class,
        note: add.note,
      };
      if (collection === 'constraints') item.hard = add.hard ?? true;
      return item;
    }
    case 'unknowns':
      return {
        ...base,
        text: add.text,
        knowledge_class: add.knowledge_class ?? 'UNKNOWN',
        priority: add.priority ?? 'medium',
      } as Item;
    case 'risks':
      return {
        ...base,
        text: add.text,
        knowledge_class: add.knowledge_class ?? 'MODEL_SUGGESTED',
        severity: add.severity ?? 'medium',
      } as Item;
    case 'dependencies':
      return {
        ...base,
        text: add.text,
        knowledge_class: add.knowledge_class ?? 'MODEL_SUGGESTED',
      } as Item;
    case 'evidence': {
      const sourceType = add.source_type;
      // Server-side source overwrite: the model can never fabricate sources.
      const source =
        sourceType === 'user'
          ? 'User statement (conversation)'
          : `Model internal knowledge (${opts.providerLabel}) — unverified`;
      return {
        ...base,
        claim: add.claim,
        source_type: sourceType,
        source,
        relevance: add.relevance ?? 'medium',
        confidence: add.confidence ?? 0.3,
        supports: add.supports ?? [],
        contradicts: add.contradicts ?? [],
        knowledge_class: sourceType === 'user' ? 'USER_PROVIDED' : 'MODEL_SUGGESTED',
        provenance: {
          source: sourceType === 'user' ? 'user' : 'model',
          note: sourceType === 'model_knowledge' ? 'Unverified model statement — NOT external research.' : 'From the user message.',
        },
      } as Item;
    }
    case 'research_items':
      return {
        ...base,
        question: add.question,
        rationale: add.rationale,
        priority: add.priority ?? 'medium',
        status: 'pending',
        evidence_ids: [],
        knowledge_class: 'UNKNOWN',
      } as Item;
    case 'alternatives':
      return {
        ...base,
        name: add.name,
        description: add.description ?? '',
        advantages: strArray(add.advantages),
        disadvantages: strArray(add.disadvantages),
        requirements: strArray(add.requirements),
        risks: strArray(add.risks),
        dependencies: strArray(add.dependencies),
        evidence_ids: [],
        status: String(add.status ?? 'candidate'),
        knowledge_class: 'MODEL_SUGGESTED',
      } as Item;
    case 'decisions': {
      const maker = add.decision_maker;
      return {
        ...base,
        decision: add.decision,
        reason: add.reason ?? '',
        basis: add.basis,
        decision_maker: maker,
        affected_ids: strArray(add.affected_ids),
        alternatives_considered: strArray(add.alternatives_considered),
        evidence_ids: [],
        knowledge_class: maker === 'user' ? 'USER_DECIDED' : 'MODEL_SUGGESTED',
        provenance: {
          source: maker === 'user' ? 'user' : 'model',
          note: maker === 'user' ? 'Recorded from the user message via proposal review.' : 'Model recommendation; user reviewed it.',
        },
      } as Item;
    }
    case 'rejected_approaches':
      return {
        ...base,
        text: add.text,
        reason: add.reason ?? '',
        rejected_by: add.rejected_by ?? 'model',
        knowledge_class: 'REJECTED',
      } as Item;
    case 'open_questions':
      return {
        ...base,
        text: add.text,
        knowledge_class: 'UNKNOWN',
        asked_to: add.asked_to ?? 'user',
      } as Item;
  }
}

function itemText(item: Item): string {
  return String(item.text ?? item.claim ?? item.decision ?? item.question ?? item.name ?? item.id);
}

function buildSummary(reasoning: string, diff: StateDiff): string {
  const parts: string[] = [];
  for (const [collection, d] of Object.entries(diff.collections)) {
    const bits: string[] = [];
    if (d.added.length > 0) bits.push(`+${d.added.length}`);
    if (d.modified.length > 0) bits.push(`~${d.modified.length}`);
    if (bits.length > 0) parts.push(`${collection} ${bits.join(' ')}`);
  }
  if (diff.title) parts.push('title');
  if (diff.current_intent) parts.push('intent');
  if (diff.original_idea_set) parts.push('original idea captured');
  const counts = parts.length > 0 ? parts.join(', ') : 'no state changes';
  return reasoning ? `${reasoning} (${counts})` : `Idea state updated: ${counts}.`;
}
