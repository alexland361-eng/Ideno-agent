import type { AIProvider } from './types.js';
import type { GenerateRequest } from './types.js';
import type { AITask } from '../../shared/config.js';

/**
 * Capability negotiation (§9).
 *
 * Tasks declare required capabilities; the runtime selects a provider that
 * declares them. Unsupported capabilities are reported explicitly — never
 * faked.
 */

interface TaskRequirements {
  structuredOutput: boolean;
  streaming: boolean;
}

const TASK_REQUIREMENTS: Record<AITask, TaskRequirements> = {
  conversation: { structuredOutput: true, streaming: false },
};

/** Returns an explanation string for each unmet requirement. */
export function unmetRequirements(task: AITask, provider: AIProvider): string[] {
  const req = TASK_REQUIREMENTS[task] as TaskRequirements;
  const caps = provider.capabilities;
  const problems: string[] = [];
  if (req.structuredOutput && caps.structured_output === 'none') {
    problems.push(
      `Task '${task}' requires structured output, but provider '${provider.id}' declares structured_output: none.`,
    );
  }
  if (req.streaming && !caps.streaming) {
    problems.push(`Task '${task}' requires streaming, but provider '${provider.id}' cannot stream.`);
  }
  return problems;
}

/**
 * Negotiate the structured-output mode for a request that carries a JSON
 * schema. Providers declaring json_schema use native structured outputs;
 * json_object providers get valid-JSON-but-unverified mode; providers with
 * no structured output get explicit prompt instructions. In the latter two
 * modes the runtime validates afterwards and repairs once on mismatch.
 */
export function negotiateStructuredOutput(
  provider: AIProvider,
  req: Omit<GenerateRequest, 'messages'>,
): { request: Omit<GenerateRequest, 'messages'>; mode: 'json_schema' | 'json_object' | 'prompt_only' } {
  const caps = provider.capabilities;
  if (req.jsonSchema && caps.structured_output === 'json_schema') {
    return { request: req, mode: 'json_schema' };
  }
  if (req.jsonSchema && caps.structured_output === 'json_object') {
    // json_object mode guarantees valid JSON, but not our schema — validation
    // happens after; a repair pass follows on mismatch (see runtime.ts).
    return { request: req, mode: 'json_object' };
  }
  if (!req.jsonSchema) {
    return { request: req, mode: 'json_schema' };
  }
  // No native structured output: instruct via prompt and validate afterwards.
  return {
    request: {
      ...req,
      system: `${req.system}\n\nCRITICAL OUTPUT REQUIREMENT: Respond with ONLY a single JSON object matching the requested structure. No prose, no code fences.`,
    },
    mode: 'prompt_only',
  };
}
