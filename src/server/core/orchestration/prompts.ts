import type { ChatCompletionMessage } from '../../ai/types.js';
import type { IdeaCase } from '../../../shared/schemas/ideaCase.js';
import type { ChatMessage } from '../../../shared/chat.js';

/**
 * Context construction (§14 Conversation Context).
 *
 * The model receives: system instructions + the serialized Idea State +
 * recent conversation + the current user message. The Idea State is the
 * authority; the conversation is supporting context. Nothing else is sent.
 */

export function buildSystemPrompt(caseData: IdeaCase): string {
  return [SYSTEM_INSTRUCTIONS, '', serializeState(caseData)].join('\n');
}

export function buildContextMessages(
  recent: ChatMessage[],
  currentUserMessage: string,
): ChatCompletionMessage[] {
  const messages: ChatCompletionMessage[] = [];
  for (const msg of recent) {
    if (msg.role === 'user') {
      messages.push({ role: 'user', content: msg.content });
    } else if (msg.role === 'assistant') {
      messages.push({ role: 'assistant', content: msg.content });
    } else {
      // System notices (proposal accepted/rejected, errors) are supporting
      // context, delivered as bracketed user-role lines.
      messages.push({ role: 'user', content: `[Ideno system notice] ${msg.content}` });
    }
  }
  messages.push({ role: 'user', content: currentUserMessage });
  return messages;
}

// ---------------------------------------------------------------------------

const SYSTEM_INSTRUCTIONS = `You are Ideno, an idea-development system. Your job is NOT to answer questions — it is to help the human take their idea further. The structured Idea State (below) is the product; the conversation is only the interface.

OPERATING PRINCIPLES

1. Human authority: you propose; the human decides. Never silently decide for the user.
2. Epistemic discipline: classify every claim. "USER_PROVIDED" = the user said it. "ASSUMED" = unverified working assumption. "INFERRED" = you deduced it. "UNKNOWN" = an open gap. "MODEL_SUGGESTED" = your own unverified suggestion. Never present a suggestion as fact.
3. Research integrity: never invent sources, URLs, citations, or data. Evidence you add may only be source_type "user" (something the user just stated) or "model_knowledge" (your internal knowledge, explicitly unverified). External evidence is impossible for you.
4. Question discipline: ask AT MOST one question per turn, and only when the missing information materially changes the recommended direction. Never interrogate. If enough information exists, continue without asking.
5. Impact awareness: when the user adds a constraint or new information, identify downstream effects in impact_analysis (which areas of the design are affected and why), and propose invalidating (status change) for assumptions that no longer hold.
6. Conflict detection: if the user's new information contradicts existing state (a constraint vs. an existing decision, etc.), report it in conflicts with suggested resolutions. Never silently resolve a conflict.
7. Preservation: never delete or restate history. Modify existing items by their id. Rejected and superseded alternatives must keep status "rejected"/"superseded", not disappear.
8. Decisions: only set decision_maker "user" when the user explicitly made this decision in the conversation (e.g. picked an alternative). Otherwise use decision_maker "model" with basis "model_recommendation".
9. Replies: plain text, concise (under ~200 words), no markdown headers. Put the reply field FIRST in your JSON.

WHEN TO PROPOSE CHANGES
Include "proposal" only when the user's message (or your analysis of it) genuinely adds, changes, or invalidates state — e.g. new requirements/constraints, new unknowns worth tracking, requested alternatives, an explicit user decision, invalidations caused by new constraints. If the user just asks a question or chats, omit "proposal" and reply only.

RESPONSE FORMAT
Respond with a single JSON object:
{
  "reply": "conversational text for the user",
  "proposal": {
    "title": "optional new case title (early development)",
    "current_intent": "optional updated one-sentence intent",
    "original_idea": "the user's original idea — ONLY allowed while the state shows no original idea",
    "changes": {
      "goals": { "added": [{ "text", "knowledge_class", "success_criteria"? }], "modified": [{ "id", "reason", ...fields }] },
      "requirements": { "added": [{ "text", "knowledge_class", "priority"? }], "modified": [{ "id", "reason", "priority"?|"text"?|"status"? }] },
      "assumptions": { "added": [{ "text", "knowledge_class", "note"? }], "modified": [{ "id", "reason", "text"?|"status"? }] },
      "constraints": { "added": [{ "text", "knowledge_class", "hard"? }], "modified": [{ "id", "reason", ... }] },
      "unknowns": { "added": [{ "text", "priority"? }], "modified": [{ "id", "reason", "priority"?|"status"? }] },
      "risks": { "added": [{ "text", "severity"? }], "modified": [{ "id", "reason", ... }] },
      "dependencies": { "added": [{ "text" }], "modified": [{ "id", "reason", ... }] },
      "evidence": { "added": [{ "claim", "source_type": "user"|"model_knowledge", "relevance"?, "confidence"? }], "modified": [...] },
      "research_items": { "added": [{ "question", "rationale"?, "priority"? }], "modified": [{ "id", "reason", "status"? }] },
      "alternatives": { "added": [{ "name", "description", "advantages", "disadvantages", "requirements", "risks", "dependencies", "key"? }], "modified": [{ "id", "reason", "status"?|"description"? }] },
      "decisions": { "added": [{ "decision", "reason", "basis", "decision_maker", "affected_ids"?, "alternatives_considered"? }], "modified": [] },
      "rejected_approaches": { "added": [{ "text", "reason", "rejected_by"? }], "modified": [] },
      "open_questions": { "added": [{ "text", "asked_to"? }], "modified": [{ "id", "reason", "answer"?|"status"? }] }
    },
    "impact_analysis": [{ "area", "effect", "reason" }],
    "conflicts": [{ "description", "affected_ids", "suggested_resolutions" }],
    "questions": ["at most 1-2 high-impact questions"],
    "reasoning_summary": "1-3 sentence factual summary of why these changes are proposed (not a chain of thought)",
    "confidence": { "overall": 0.0, "note": "..." },
    "current_state": { "summary": "...", "next_steps": ["..."] }
  }
}
All collections in "changes" are optional; include only what changes. Added items never have ids — the system assigns them. Modified items must reference existing ids from the state below. knowledge_class may only be USER_PROVIDED, ASSUMED, INFERRED, UNKNOWN, or MODEL_SUGGESTED.`;

// ---------------------------------------------------------------------------
// State serialization. This exact format is also parsed by the scripted demo
// provider — keep both in sync (covered by tests).
// ---------------------------------------------------------------------------

export function serializeState(caseData: IdeaCase): string {
  const lines: string[] = [];
  lines.push(`=== CURRENT IDEA STATE (v${caseData.version}) ===`);
  lines.push(`Title: ${caseData.title}`);
  if (caseData.original_idea) lines.push(`Original idea: ${caseData.original_idea}`);
  if (caseData.current_intent) lines.push(`Current intent: ${caseData.current_intent}`);
  lines.push(
    `Confidence: ${caseData.confidence.overall.toFixed(2)}${caseData.confidence.note ? ` (${caseData.confidence.note})` : ''}`,
  );
  if (caseData.current_state.summary) {
    lines.push(`Current state: ${caseData.current_state.summary}`);
  }
  lines.push('');

  const sections: Array<[string, string[]]> = [
    ['goals', caseData.goals.filter((g) => g.status === 'active').map((g) => itemLine(g.id, g.knowledge_class, g.status, g.success_criteria ? `${g.text} [success: ${g.success_criteria}]` : g.text))],
    ['requirements', caseData.requirements.filter((r) => r.status === 'active').map((r) => itemLine(r.id, r.knowledge_class, r.status, `(${r.priority}) ${r.text}`))],
    ['assumptions', caseData.assumptions.filter((a) => a.status === 'active').map((a) => itemLine(a.id, a.knowledge_class, a.status, a.note ? `${a.text} [note: ${a.note}]` : a.text))],
    ['constraints', caseData.constraints.filter((c) => c.status === 'active').map((c) => itemLine(c.id, c.knowledge_class, c.status, `${c.hard ? '(hard) ' : '(soft) '}${c.text}`))],
    ['unknowns', caseData.unknowns.filter((u) => u.status === 'active').map((u) => itemLine(u.id, u.knowledge_class, u.status, `(${u.priority}) ${u.text}`))],
    ['risks', caseData.risks.filter((r) => r.status === 'active').map((r) => itemLine(r.id, r.knowledge_class, r.status, `(${r.severity}) ${r.text}`))],
    ['dependencies', caseData.dependencies.filter((d) => d.status === 'active').map((d) => itemLine(d.id, d.knowledge_class, d.status, d.text))],
    ['evidence', caseData.evidence.filter((e) => e.status === 'active').map((e) => itemLine(e.id, e.knowledge_class, e.status, `${e.claim} — source: ${e.source} [${e.source_type}]`))],
    ['research_items', caseData.research_items.filter((r) => r.status !== 'answered').map((r) => itemLine(r.id, r.knowledge_class, r.status === 'pending' ? 'active' : r.status, `${r.question}${r.rationale ? ` [why: ${r.rationale}]` : ''}`))],
    ['alternatives', caseData.alternatives.filter((a) => a.status === 'candidate' || a.status === 'considering' || a.status === 'accepted').map((a) => `  [${a.id}|${a.status}] ${a.name} — ${a.description}`)],
    ['decisions', caseData.decisions.filter((d) => d.status === 'active').map((d) => itemLine(d.id, d.knowledge_class, d.status, `${d.decision} [by ${d.decision_maker}, basis: ${d.basis}${d.reason ? `, reason: ${d.reason}` : ''}]`))],
    ['rejected_approaches', caseData.rejected_approaches.filter((r) => r.status === 'active').map((r) => itemLine(r.id, r.knowledge_class, r.status, `${r.text} [rejected by ${r.rejected_by}${r.reason ? `: ${r.reason}` : ''}]`))],
    ['open_questions', caseData.open_questions.filter((q) => !q.answer).map((q) => itemLine(q.id, q.knowledge_class, q.status, `${q.text}${q.asked_to === 'research' ? ' [for research]' : ''}`))],
  ];

  for (const [name, items] of sections) {
    lines.push(`## ${name} (${items.length})`);
    if (items.length === 0) {
      lines.push('  (none)');
    } else {
      lines.push(...items);
    }
    lines.push('');
  }

  const history: string[] = [];
  for (const collection of [
    caseData.goals, caseData.requirements, caseData.assumptions, caseData.constraints,
    caseData.unknowns, caseData.risks, caseData.dependencies, caseData.alternatives,
    caseData.decisions, caseData.open_questions,
  ]) {
    for (const item of collection) {
      if (item.status !== 'active') {
        const text = 'text' in item && typeof item.text === 'string' ? item.text
          : 'name' in item && typeof item.name === 'string' ? item.name : item.id;
        history.push(`  [${item.id}|${item.status}] ${text}${item.last_change_reason ? ` — ${item.last_change_reason}` : ''}`);
      }
    }
  }
  lines.push(`## history (${history.length})`);
  lines.push(...(history.length ? history : ['  (none)']));

  return lines.join('\n');
}

function itemLine(id: string, knowledgeClass: string, status: string, text: string): string {
  return `  [${id}|${knowledgeClass}|${status}] ${text.replace(/\n+/g, ' ')}`;
}
