import type {
  AIProvider,
  GenerateRequest,
  GenerateResult,
  HealthResult,
  ProviderCapabilities,
  StreamEvent,
} from '../types.js';
import type { DemoProviderConfig } from '../../../shared/config.js';
import type { OrchestratorEnvelopeInput as OrchestratorEnvelope, ProposalInput as Proposal } from '../../../shared/schemas/proposal.js';

/**
 * Scripted DEMO provider — NOT AN AI MODEL.
 *
 * This adapter exists so the full Ideno pipeline (proposal → validation →
 * review → versioning) can be demonstrated and integration-tested without a
 * real model. It follows deterministic template rules over the serialized
 * Idea State in its context. It is labeled as a demo everywhere it appears:
 * display name, UI badge, and every reply it produces. It must never be
 * presented as real AI. For real inference configure an `openai_compatible`
 * provider in config/ideno.config.json.
 *
 * The rules below encode a generic "greenhouse-style" development scenario:
 * initial structuring, constraint handling with impact analysis and
 * invalidations, alternative generation, and decision recording.
 */

const DEMO_BANNER = '(scripted demo provider — not an AI model)';

interface ParsedItem {
  id: string;
  knowledge_class: string;
  status: string;
  text: string;
}

interface ParsedState {
  title: string;
  originalIdea: string;
  currentIntent: string;
  items: Map<string, ParsedItem[]>; // collection -> items
  alternatives: Array<ParsedItem & { name: string; status: string }>;
}

/** Parse the serialized state block the orchestrator puts in the system prompt. */
function parseStateContext(system: string): ParsedState {
  const state: ParsedState = {
    title: '',
    originalIdea: '',
    currentIntent: '',
    items: new Map(),
    alternatives: [],
  };
  let collection: string | undefined;
  for (const line of system.split('\n')) {
    const titleMatch = /^Title: (.*)$/.exec(line);
    if (titleMatch) state.title = titleMatch[1] ?? '';
    const ideaMatch = /^Original idea: (.*)$/.exec(line);
    if (ideaMatch) state.originalIdea = ideaMatch[1] ?? '';
    const intentMatch = /^Current intent: (.*)$/.exec(line);
    if (intentMatch) state.currentIntent = intentMatch[1] ?? '';
    const sectionMatch = /^## ([a-z_]+) \(/.exec(line);
    if (sectionMatch?.[1]) {
      collection = sectionMatch[1];
      if (!state.items.has(collection)) state.items.set(collection, []);
      continue;
    }
    const itemMatch = /^  \[([a-z]+\d+)\|([A-Z_]+)\|([a-z]+)\] (.*)$/.exec(line);
    if (itemMatch && collection) {
      const item: ParsedItem = {
        id: itemMatch[1] ?? '',
        knowledge_class: itemMatch[2] ?? '',
        status: itemMatch[3] ?? '',
        text: itemMatch[4] ?? '',
      };
      state.items.get(collection)?.push(item);
    }
    const altMatch = /^  \[(alt\d+)\|([a-z]+)\] (.*)$/.exec(line);
    if (altMatch && collection === 'alternatives') {
      state.alternatives.push({
        id: altMatch[1] ?? '',
        knowledge_class: '',
        status: altMatch[2] ?? 'candidate',
        name: altMatch[3] ?? '',
        text: altMatch[3] ?? '',
      });
    }
  }
  return state;
}

const TOPIC_MAP: Array<{
  keywords: RegExp;
  area: string;
  effects: string[];
  invalidates: RegExp;
}> = [
  {
    keywords: /electric|mains|power|battery|outlet|plug|grid|solar|energy/i,
    area: 'Power architecture',
    effects: ['Power architecture', 'Energy budget', 'Component selection', 'Operating schedule'],
    invalidates: /mains|outlet|plug|grid|wall power| wired power/i,
  },
  {
    keywords: /internet|cloud|wifi|wi-fi|network|online|connectivity|api/i,
    area: 'Network architecture',
    effects: ['Network architecture', 'Remote monitoring', 'Software dependencies', 'Update mechanism'],
    invalidates: /cloud|internet|online|remote api|web service|server/i,
  },
  {
    keywords: /balcony|size|small|space|fit|indoor|apartment|compact|desk/i,
    area: 'Physical dimensions',
    effects: ['Physical footprint', 'Component selection', 'Structural load', 'Cost'],
    invalidates: /large|big|field|greenhouse room|spacious/i,
  },
  {
    keywords: /cheap|budget|cost|affordable|expensive|money/i,
    area: 'Cost envelope',
    effects: ['Component selection', 'Material choices', 'Build vs. buy decisions'],
    invalidates: /expensive|premium|commercial/i,
  },
  {
    keywords: /waterproof|weather|rain|outdoor|humidity/i,
    area: 'Environmental protection',
    effects: ['Enclosure requirements', 'Material selection', 'Component ratings'],
    invalidates: /indoor only|climate controlled room/i,
  },
];

function detectTopic(text: string) {
  return TOPIC_MAP.find((t) => t.keywords.test(text));
}

const ALTERNATIVE_WORD = /alternative|option|approach|way of doing|architecture/i;
const SELECT_WORD =
  /(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th|last|option (\d)|alternative (\d)|number (\d))/i;

function ordinalIndex(text: string): number | undefined {
  const map: Record<string, number> = {
    first: 0, '1st': 0, one: 0,
    second: 1, '2nd': 1, two: 1,
    third: 2, '3rd': 2, three: 2,
    fourth: 3, '4th': 3, five: 4, fifth: 4, '5th': 4,
  };
  const m = /(?:use|go with|pick|choose|take|let'?s|select|prefer)[^.?!]*?\b(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th|one|two|three)\b/i.exec(
    text,
  );
  if (m?.[1]) {
    const idx = map[m[1].toLowerCase()];
    if (idx !== undefined) return idx;
  }
  const num = /(?:option|alternative|number)\s+(\d)/i.exec(text);
  if (num?.[1]) return parseInt(num[1], 10) - 1;
  return undefined;
}

function titleFromIdea(idea: string): string {
  const cleaned = idea.replace(/^(i want to|id like to|i'd like to|i would like to|lets|let's)\s+/i, '')
    .replace(/[.?!]+$/, '')
    .trim();
  const words = cleaned.split(/\s+/).slice(0, 8).join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export class DemoProvider implements AIProvider {
  readonly id: string;
  readonly displayName: string;
  readonly model = 'scripted-demo-v0';
  readonly capabilities: ProviderCapabilities;

  constructor(id: string, _config: DemoProviderConfig) {
    this.id = id;
    this.displayName = `DEMO — scripted (not AI): ${id}`;
    this.capabilities = {
      structured_output: 'json_schema',
      streaming: true,
      privacy: 'local',
      is_demo: true,
      vision: false,
    };
  }

  validateConfiguration(): string[] {
    return [];
  }

  async healthCheck(): Promise<HealthResult> {
    return { ok: true, detail: 'Scripted demo provider is always available (it runs no model).' };
  }

  async listModels(): Promise<string[]> {
    return [this.model];
  }

  getUsage() {
    return { requests: 0, input_tokens: 0, output_tokens: 0 };
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const text = JSON.stringify(this.buildEnvelope(req));
    return { text, finishReason: 'stop', usage: { input_tokens: 0, output_tokens: 0 }, model: this.model };
  }

  async *stream(req: GenerateRequest): AsyncGenerator<StreamEvent> {
    const text = JSON.stringify(this.buildEnvelope(req));
    // Yield in chunks to exercise the streaming path realistically.
    const chunkSize = 24;
    for (let i = 0; i < text.length; i += chunkSize) {
      yield { type: 'text', text: text.slice(i, i + chunkSize) };
    }
    yield { type: 'done', finishReason: 'stop', usage: { input_tokens: 0, output_tokens: 0 } };
  }

  // -------------------------------------------------------------------------

  /** Deterministic critique for the deep-analysis pass (demo). */
  private demoCritique(req: GenerateRequest): unknown {
    const userMessage = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    return {
      issues: [
        {
          severity: 'low',
          area: 'review completeness',
          description:
            'Scripted demo critique: a real model would adversarially check this change against the current state (conflicts, unsupported assumptions, missing considerations).',
        },
      ],
      missing_considerations: [
        'Scripted demo critique: a real model would list considerations the draft may have missed.',
      ],
      questions: [`Demo: what should be double-checked before accepting changes related to "${userMessage.slice(0, 60)}"?`],
      summary: 'Scripted demo critique (deterministic template, not AI reasoning).',
    };
  }

  private buildEnvelope(req: GenerateRequest): OrchestratorEnvelope {
    // Deep-analysis pass: a deterministic, clearly-labeled critique.
    if (req.jsonSchema?.name === 'ideno_critique') {
      return this.demoCritique(req) as unknown as OrchestratorEnvelope;
    }
    const state = parseStateContext(req.system);
    const userMessage = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';

    let envelope: OrchestratorEnvelope;
    if (!state.originalIdea) {
      envelope = this.initialProposal(userMessage);
    } else if (ALTERNATIVE_WORD.test(userMessage) && /\b(show|list|give|what|generate|compare)\b/i.test(userMessage)) {
      envelope = this.alternativesProposal(state, userMessage);
    } else if (SELECT_WORD.test(userMessage)) {
      envelope = this.selectionProposal(state, userMessage);
    } else {
      const topic = detectTopic(userMessage);
      envelope = topic
        ? this.constraintProposal(state, userMessage, topic)
        : this.genericFollowUp(state, userMessage);
    }

    // The demo provider must never claim to be an AI reasoning about the idea.
    if (envelope.proposal) {
      envelope.proposal.reasoning_summary = `Scripted demo rules (deterministic templates, not AI reasoning).`;
    }
    return envelope;
  }

  private baseReply(lines: string[]): string {
    return `${DEMO_BANNER}\n${lines.join('\n')}`;
  }

  /** Turn 1: structure the original idea. */
  private initialProposal(userMessage: string): OrchestratorEnvelope {
    const title = titleFromIdea(userMessage);
    const proposal: Proposal = {
      title,
      original_idea: userMessage,
      current_intent: userMessage.trim(),
      changes: {
        goals: {
          added: [
            {
              text: `Deliver: ${title.toLowerCase()}`,
              knowledge_class: 'USER_PROVIDED',
              success_criteria: 'The user considers the idea well-defined enough to start building.',
            },
          ],
          modified: [],
        },
        assumptions: {
          added: [
            {
              text: 'The idea will be developed incrementally by one person.',
              knowledge_class: 'ASSUMED',
              note: 'Assumed from the conversational context; not verified.',
            },
            {
              text: 'Cloud services and internet connectivity are available if needed.',
              knowledge_class: 'ASSUMED',
              note: 'Assumed for the demo scenario so a later offline constraint has something to invalidate.',
            },
          ],
          modified: [],
        },
        unknowns: {
          added: [
            {
              text: 'What budget is available for this idea?',
              priority: 'high',
            },
            {
              text: 'What scale and environment is this for?',
              priority: 'high',
            },
          ],
          modified: [],
        },
        open_questions: {
          added: [{ text: 'What does success look like for this idea — what should it do first?' }],
          modified: [],
        },
      },
      impact_analysis: [
        {
          area: 'Overall structure',
          effect: 'Idea captured as a structured case; development can now be tracked.',
          reason: 'Initial structuring.',
        },
      ],
      conflicts: [],
      questions: ['What matters most for the first version — cost, size, or capability?'],
      reasoning_summary: 'Scripted demo: initial structuring.',
      confidence: { overall: 0.15, note: 'Early stage; almost nothing is specified yet.' },
      current_state: {
        summary: 'Idea captured and structured. Very early: scale, budget, and environment are unknown.',
        next_steps: ['Clarify the highest-impact unknowns', 'Identify hard constraints'],
      },
    };
    return {
      reply: this.baseReply([
        `I've captured the idea and drafted the initial structure: a goal, one assumption, and the two unknowns that most affect any design.`,
        '',
        'Review the proposed changes on the card below. Accept to create version 1 of the Idea State, or reject to keep it as is.',
      ]),
      proposal,
    };
  }

  /** Constraint-style message: add constraint, invalidate contradicting assumptions, analyze impact. */
  private constraintProposal(
    state: ParsedState,
    userMessage: string,
    topic: (typeof TOPIC_MAP)[number],
  ): OrchestratorEnvelope {
    const affected = (state.items.get('assumptions') ?? []).filter(
      (a) => a.status === 'active' && topic.invalidates.test(a.text),
    );
    const proposal: Proposal = {
      changes: {
        constraints: {
          added: [
            {
              text: userMessage.trim().replace(/^(it |the system |this )?(must|has to|should|needs to|cannot|can't|will not|won't)\s+/i, (m) => m),
              knowledge_class: 'USER_PROVIDED',
              hard: true,
            },
          ],
          modified: [],
        },
        assumptions: {
          added: [],
          modified: affected.map((a) => ({
            id: a.id,
            reason: `Invalidated by the new constraint (${topic.area.toLowerCase()}).`,
            status: 'invalidated',
          })),
        },
        unknowns: {
          added: [
            {
              text: `How does the new constraint (${topic.area.toLowerCase()}) change the feasibility of the current direction?`,
              priority: 'high',
            },
          ],
          modified: [],
        },
      },
      impact_analysis: topic.effects.map((effect) => ({
        area: effect,
        effect: `Must be reconsidered under the new constraint.`,
        reason: `The user's message constrains ${topic.area.toLowerCase()}.`,
      })),
      conflicts: [],
      questions: [],
      reasoning_summary: `Scripted demo: constraint detected affecting ${topic.area.toLowerCase()}.`,
      confidence: { overall: 0.35, note: 'A hard constraint narrowed the design space.' },
    };
    return {
      reply: this.baseReply([
        `Understood — I've recorded that as a hard constraint.`,
        '',
        affected.length > 0
          ? `It invalidates ${affected.length} existing assumption${affected.length > 1 ? 's' : ''}, and it affects: ${topic.effects.join(', ')}.`
          : `It affects: ${topic.effects.join(', ')}.`,
        '',
        'Review the proposed changes below.',
      ]),
      proposal,
    };
  }

  /** "Show me alternatives" — generate three templated alternatives. */
  private alternativesProposal(state: ParsedState, userMessage: string): OrchestratorEnvelope {
    const subject = state.currentIntent || state.title || 'the idea';
    const constraints = (state.items.get('constraints') ?? []).filter((c) => c.status === 'active');
    const constraintNote = constraints.map((c) => c.text).join('; ');
    const proposal: Proposal = {
      changes: {
        alternatives: {
          added: [
            {
              name: 'A — Minimal build',
              description: `Simplest version of ${subject} that could work, using off-the-shelf parts only.`,
              advantages: ['Lowest cost', 'Fastest to build', 'Easiest to repair'],
              disadvantages: ['Fewer capabilities', 'Less headroom for growth'],
              requirements: ['Basic components only'],
              risks: ['May not satisfy future requirements'],
              dependencies: [],
              status: 'candidate',
              key: 'a',
            },
            {
              name: 'B — Balanced build',
              description: `Mid-range version of ${subject}: capable core with room to extend later.`,
              advantages: ['Good capability-to-cost ratio', 'Modular', 'Reasonable complexity'],
              disadvantages: ['More components', 'Some assembly effort'],
              requirements: ['Core components plus expansion interfaces'],
              risks: ['Slightly higher cost'],
              dependencies: [],
              status: 'candidate',
              key: 'b',
            },
            {
              name: 'C — Ambitious build',
              description: `Fully featured version of ${subject} with monitoring and automation from day one.`,
              advantages: ['Most capable', 'Best long-term headroom', 'Rich data'],
              disadvantages: ['Highest cost', 'Most complex to build and maintain', 'Longest time to first result'],
              requirements: ['Advanced components', 'More integration work'],
              risks: ['Overengineering for the actual need', 'Complexity-driven failures'],
              dependencies: [],
              status: 'candidate',
              key: 'c',
            },
          ],
          modified: [],
        },
      },
      impact_analysis: [
        {
          area: 'Solution space',
          effect: 'Three concrete candidate architectures added for comparison.',
          reason: 'The user asked for alternatives.',
        },
      ],
      conflicts: [],
      questions: [],
      reasoning_summary: 'Scripted demo: templated alternatives.',
      current_state: {
        summary: `Comparing candidate approaches${constraintNote ? ` under the constraints: ${constraintNote}` : ''}.`,
        next_steps: ['Compare candidates', 'Select one to pursue'],
      },
    };
    return {
      reply: this.baseReply([
        'Here are three candidate approaches (templated by the demo rules):',
        '',
        'A — Minimal build: cheapest and fastest, fewer capabilities.',
        'B — Balanced build: good capability-to-cost ratio, modular.',
        'C — Ambitious build: most capable, highest cost and complexity.',
        '',
        constraintNote
          ? `All candidates must respect your constraints: ${constraintNote}.`
          : 'Tell me which one to pursue, or what trade-offs matter to you.',
        '',
        'The alternatives are added to the Idea State below — accepting them lets you select one next.',
      ]),
      proposal,
    };
  }

  /** "Let's use the second one" — record the user's decision. */
  private selectionProposal(state: ParsedState, userMessage: string): OrchestratorEnvelope {
    const candidates = state.alternatives.filter((a) => a.status === 'candidate' || a.status === 'considering');
    if (candidates.length === 0) {
      return this.genericFollowUp(state, userMessage);
    }
    const idx = ordinalIndex(userMessage) ?? 0;
    const selected = candidates[idx] ?? candidates[candidates.length - 1];
    if (!selected) {
      return this.genericFollowUp(state, userMessage);
    }
    const others = candidates.filter((a) => a.id !== selected.id);
    const proposal: Proposal = {
      changes: {
        alternatives: {
          added: [],
          modified: [
            {
              id: selected.id,
              reason: 'User selected this alternative.',
              status: 'accepted',
            },
            ...others.map((a) => ({
              id: a.id,
              reason: `Superseded: the user selected ${selected.name}.`,
              status: 'superseded' as const,
            })),
          ],
        },
        decisions: {
          added: [
            {
              decision: `Selected alternative: ${selected.name}`,
              reason: 'The user explicitly selected it in the conversation.',
              basis: 'user_message',
              decision_maker: 'user',
              alternatives_considered: candidates.map((a) => a.id),
            },
          ],
          modified: [],
        },
      },
      impact_analysis: [
        {
          area: 'Architecture',
          effect: `Development now follows "${selected.name}"; other candidates are preserved but superseded.`,
          reason: 'User decision.',
        },
      ],
      conflicts: [],
      questions: [],
      reasoning_summary: 'Scripted demo: user decision recorded.',
      confidence: { overall: 0.5, note: 'A direction was chosen; remaining unknowns still matter.' },
      current_state: {
        summary: `Pursuing "${selected.name}".`,
        next_steps: ['Refine requirements for the selected approach', 'Resolve high-priority unknowns'],
      },
    };
    return {
      reply: this.baseReply([
        `Recorded your decision: "${selected.name}" is accepted, and the other candidates are preserved as superseded (nothing is deleted).`,
        '',
        'Accept the changes below to make this decision part of the Idea State.',
      ]),
      proposal,
    };
  }

  /** Fallback: acknowledge, surface a risk and an open question. */
  private genericFollowUp(state: ParsedState, userMessage: string): OrchestratorEnvelope {
    const known = state.items.get('requirements')?.length ?? 0;
    const proposal: Proposal = {
      changes: {
        risks: {
          added: [
            {
              text: 'Scope may drift as the idea develops — revisit goals after each constraint change.',
              knowledge_class: 'MODEL_SUGGESTED',
              severity: 'low',
            },
          ],
          modified: [],
        },
        open_questions: {
          added: [{ text: 'Is there anything about this idea that is still vague to you?' }],
          modified: [],
        },
      },
      impact_analysis: [],
      conflicts: [],
      questions: ['What would you like to develop next — requirements, constraints, or unknowns?'],
      reasoning_summary: 'Scripted demo: generic follow-up.',
    };
    return {
      reply: this.baseReply([
        `Noted. The Idea State currently has ${known} tracked requirement${known === 1 ? '' : 's'}.`,
        '',
        'I am a scripted demo, so I respond with templates rather than reasoning — configure a real model in config/ideno.config.json for actual idea development.',
      ]),
      proposal,
    };
  }
}
