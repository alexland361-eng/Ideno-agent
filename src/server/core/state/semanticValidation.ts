import type { CollectionKey, IdeaCase } from '../../../shared/schemas/ideaCase.js';
import { COLLECTIONS } from '../../../shared/schemas/ideaCase.js';
import type { Proposal } from '../../../shared/schemas/proposal.js';

/**
 * Semantic validation (§4 State Integrity, §24).
 *
 * Structural validation is done by Zod before this runs. Semantic validation
 * checks references and invariants against the CURRENT case state:
 *   - modified ids must exist
 *   - no ambiguous double-modification of the same item
 *   - decisions claiming user authority must cite the user message
 *   - duplicate adds are skipped with a warning (never silently mutated)
 *
 * Result: errors block the proposal entirely; warnings are surfaced on the
 * review card; skipAdd tells the state manager which adds to drop.
 */

export interface ValidationOutcome {
  errors: string[];
  warnings: string[];
  /** Collection -> set of indexes into `added` that must be skipped (duplicates). */
  skipAdd: Partial<Record<CollectionKey, Set<number>>>;
}

const MODIFIABLE_FIELDS = new Set([
  'text', 'note', 'knowledge_class', 'status', 'priority', 'hard', 'severity',
  'success_criteria', 'answer', 'name', 'description', 'advantages', 'disadvantages',
  'claim', 'relevance', 'confidence', 'question',
]);

export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').replace(/[.!?,;:]+$/, '').trim();
}

export function validateProposal(caseData: IdeaCase, proposal: Proposal): ValidationOutcome {
  const errors: string[] = [];
  const warnings: string[] = [];
  const skipAdd: Partial<Record<CollectionKey, Set<number>>> = {};

  // The original idea is history — it may only be set once.
  if (proposal.original_idea !== undefined && caseData.original_idea.length > 0) {
    errors.push('original_idea may only be set when the case has no original idea yet.');
  }

  for (const collection of COLLECTIONS) {
    const changes = proposal.changes[collection];
    if (!changes?.added?.length && !changes?.modified?.length) continue;
    const existing = caseData[collection] as Array<{ id: string; text?: string; claim?: string; status: string }>;
    const existingById = new Map(existing.map((item) => [item.id, item]));
    const activeTexts = new Set(
      existing.filter((i) => i.status === 'active').map((i) => normalizeText(i.text ?? i.claim ?? '')),
    );

    // --- modified ---
    const seenIds = new Set<string>();
    const modifiedIds = new Set<string>();
    for (const mod of changes.modified ?? []) {
      if (seenIds.has(mod.id)) {
        errors.push(`${collection}: item ${mod.id} is modified more than once in this proposal.`);
        continue;
      }
      seenIds.add(mod.id);
      const item = existingById.get(mod.id);
      if (!item) {
        errors.push(`${collection}: modified item ${mod.id} does not exist in the current state.`);
        continue;
      }
      modifiedIds.add(mod.id);
      const patchKeys = Object.keys(mod).filter((k) => k !== 'id' && k !== 'reason');
      if (patchKeys.length === 0) {
        errors.push(`${collection}: modification of ${mod.id} contains no fields to change.`);
      }
      for (const key of patchKeys) {
        if (!MODIFIABLE_FIELDS.has(key)) {
          errors.push(`${collection}: field '${key}' of ${mod.id} cannot be modified.`);
        }
      }
      // Reactivating an invalidated item is allowed only with a reason (which
      // is required by the schema for all modifications) — no extra check.
    }

    // --- added: duplicate detection against active items and each other ---
    const addedTexts: Array<{ index: number; text: string }> = [];
    (changes.added ?? []).forEach((add, index) => {
      const text = 'text' in add && typeof add.text === 'string' ? add.text
        : 'claim' in add && typeof add.claim === 'string' ? add.claim
        : 'question' in add && typeof add.question === 'string' ? add.question
        : 'decision' in add && typeof add.decision === 'string' ? add.decision
        : 'name' in add && typeof add.name === 'string' ? add.name
        : '';
      const normalized = normalizeText(text);
      if (!normalized) {
        return; // no comparable text (e.g. structured items) — skip duplicate detection
      }
      if (activeTexts.has(normalized)) {
        warnings.push(`${collection}: skipped adding duplicate of an existing active item ("${truncate(text)}").`);
        markSkip(skipAdd, collection, index);
        return;
      }
      const duplicateInProposal = addedTexts.find((a) => a.text === normalized);
      if (duplicateInProposal) {
        warnings.push(`${collection}: skipped duplicate add within the proposal ("${truncate(text)}").`);
        markSkip(skipAdd, collection, index);
        return;
      }
      addedTexts.push({ index, text: normalized });
    });

    // --- collection-specific invariants ---
    if (collection === 'alternatives') {
      const keys = new Set<string>();
      for (const add of changes.added ?? []) {
        if ('key' in add && typeof add.key === 'string' && add.key) {
          if (keys.has(add.key)) {
            errors.push(`alternatives: duplicate key '${add.key}' in added alternatives.`);
          }
          keys.add(add.key);
        }
      }
    }
    if (collection === 'decisions') {
      const decisionsAdded = (changes.added ?? []) as Array<{
        decision: string;
        basis: string;
        decision_maker: string;
        alternatives_considered?: string[];
      }>;
      for (const add of decisionsAdded) {
        if (add.decision_maker === 'user' && add.basis !== 'user_message') {
          errors.push(
            `decisions: a decision attributed to the user must cite basis 'user_message' (got '${add.basis}').`,
          );
        }
        if (add.decision_maker === 'user') {
          warnings.push(
            `decisions: "${truncate(add.decision)}" is attributed to YOU — verify this reflects what you actually decided before accepting.`,
          );
        }
      }
      // References: alternative ids or in-proposal keys.
      const altIds = new Set((caseData.alternatives as Array<{ id: string }>).map((a) => a.id));
      const altKeys = new Set(
        proposal.changes.alternatives?.added
          .map((a) => (typeof a.key === 'string' ? a.key : undefined))
          .filter((k): k is string => !!k) ?? [],
      );
      for (const add of decisionsAdded) {
        for (const ref of add.alternatives_considered ?? []) {
          if (!altIds.has(ref) && !altKeys.has(ref)) {
            errors.push(`decisions: alternatives_considered references unknown alternative '${ref}'.`);
          }
        }
      }
    }
    if (collection === 'research_items') {
      // Research questions are never claimed answered by a model proposal.
      for (const mod of changes.modified ?? []) {
        if ('status' in mod && mod.status === 'answered') {
          errors.push(`research_items: ${mod.id} cannot be marked answered without evidence from a research provider.`);
        }
      }
    }
  }

  // Conflicts must reference existing items (if they reference any).
  for (const conflict of proposal.conflicts) {
    for (const id of conflict.affected_ids) {
      const exists = COLLECTIONS.some((c) =>
        (caseData[c] as Array<{ id: string }>).some((item) => item.id === id),
      );
      if (!exists) {
        errors.push(`conflicts: affected id '${id}' does not exist in the current state.`);
      }
    }
  }

  return { errors, warnings, skipAdd };
}

function markSkip(
  skipAdd: Partial<Record<CollectionKey, Set<number>>>,
  collection: CollectionKey,
  index: number,
): void {
  const set = skipAdd[collection] ?? new Set<number>();
  set.add(index);
  skipAdd[collection] = set;
}

function truncate(text: string): string {
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}
