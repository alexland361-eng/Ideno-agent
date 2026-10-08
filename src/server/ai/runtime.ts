import type { z } from 'zod';
import type { AITask, IdenoConfig, PrivacyMode } from '../../shared/config.js';
import { AppError } from '../../shared/errors.js';
import type { AIProvider, ChatCompletionMessage, GenerateUsage } from './types.js';
import type { HealthResult } from './types.js';
import { ModelOutputError } from './errors.js';
import { negotiateStructuredOutput, unmetRequirements } from './capabilities.js';
import { resolveRoute } from './routing.js';
import { normalizeNulls } from './wireSchema.js';

/**
 * AI Runtime facade — what Ideno Core calls instead of any provider.
 *
 * Responsibilities: route the task to a compatible provider (privacy-filtered),
 * negotiate structured output, validate model output against the Zod schema,
 * and attempt exactly one bounded repair pass when the provider's structured
 * output mode cannot guarantee the schema. Malformed output never reaches
 * callers as "success".
 */

export interface StructuredRunOptions {
  task: AITask;
  system: string;
  messages: ChatCompletionMessage[];
  schemaName: string;
  /** Zod schema used for authoritative validation of the parsed value. */
  zodSchema: z.ZodType;
  /** JSON Schema (draft 2020-12) handed to the provider wire format. */
  wireSchema: Record<string, unknown>;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Force non-streaming even when the provider supports streaming. */
  noStream?: boolean;
}

/** Events yielded while a structured run streams. */
export type RuntimeStreamEvent =
  | { type: 'partial'; accumulated: string; providerId: string; model: string }
  | { type: 'repair'; reason: string };

export interface StructuredRunResult<T> {
  value: T;
  providerId: string;
  model: string;
  mode: 'json_schema' | 'json_object' | 'prompt_only';
  streamed: boolean;
  repairAttempts: number;
  usage?: GenerateUsage;
}

export interface ProviderHealthReport {
  id: string;
  display_name: string;
  model: string;
  privacy: 'local' | 'cloud';
  is_demo: boolean;
  health: HealthResult;
  /** Best-effort usage counters since process start. */
  usage: { requests: number; input_tokens: number; output_tokens: number };
}

export class AIRuntime {
  constructor(
    private readonly providers: Map<string, AIProvider>,
    private readonly config: Pick<IdenoConfig, 'privacy_mode' | 'routing'>,
  ) {}

  get privacyMode(): PrivacyMode {
    return this.config.privacy_mode;
  }

  providerIds(): string[] {
    return [...this.providers.keys()];
  }

  /**
   * Stream a structured generation. Yields partial raw output events (callers
   * may extract preview fields from the accumulated text), repairs once on
   * schema mismatch when the provider mode cannot guarantee the schema, and
   * RETURNS the validated result (or throws a classified AppError).
   */
  async *streamStructured<T>(
    opts: StructuredRunOptions,
  ): AsyncGenerator<RuntimeStreamEvent, StructuredRunResult<T>> {
    const route = resolveRoute(opts.task, this.config.privacy_mode, this.providers, this.config.routing);
    const provider = route.provider;

    const baseRequest = {
      task: opts.task,
      system: opts.system,
      jsonSchema: { name: opts.schemaName, schema: opts.wireSchema, strict: true },
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    };
    const { request, mode } = negotiateStructuredOutput(provider, baseRequest);

    let conversation: ChatCompletionMessage[] = [...opts.messages];
    let attempt = 0;

    while (true) {
      attempt += 1;
      const exec = this.execute(provider, request, conversation, opts);
      let execResult: { text: string; usage?: GenerateUsage; streamed: boolean } | undefined;
      while (true) {
        const next = await exec.next();
        if (next.done) {
          execResult = next.value;
          break;
        }
        yield next.value;
      }
      const { text, usage, streamed } = execResult;

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = extractJsonObject(text);
      }
      if (parsed === undefined) {
        if (mode !== 'json_schema' && attempt === 1) {
          const reason = 'Output was not valid JSON.';
          yield { type: 'repair', reason };
          conversation = repairConversation(conversation, text, [reason]);
          continue;
        }
        throw new ModelOutputError(
          `Model output could not be parsed as JSON (provider: ${provider.id}).`,
          [snippet(text)],
        );
      }

      const normalized = normalizeNulls(parsed);
      const result = opts.zodSchema.safeParse(normalized);
      if (result.success) {
        return {
          value: result.data as T,
          providerId: provider.id,
          model: provider.model,
          mode,
          streamed,
          repairAttempts: attempt - 1,
          usage,
        };
      }

      if (mode !== 'json_schema' && attempt === 1) {
        const problems = issues(result.error);
        yield { type: 'repair', reason: `Schema validation failed: ${problems[0] ?? 'unknown'}` };
        conversation = repairConversation(conversation, text, problems);
        continue;
      }
      throw new AppError('VALIDATION_FAILED', `Model output failed schema validation (provider: ${provider.id}).`, {
        detail: issues(result.error),
        recoverable: true,
      });
    }
  }

  /** Non-streaming convenience wrapper. */
  async runStructured<T>(opts: StructuredRunOptions): Promise<StructuredRunResult<T>> {
    const gen = this.streamStructured<T>(opts);
    while (true) {
      const next = await gen.next();
      if (next.done) return next.value;
    }
  }

  private async *execute(
    provider: AIProvider,
    request: Omit<Parameters<AIProvider['generate']>[0], 'messages'>,
    conversation: ChatCompletionMessage[],
    opts: StructuredRunOptions,
  ): AsyncGenerator<RuntimeStreamEvent, { text: string; usage?: GenerateUsage; streamed: boolean }> {
    const fullRequest = { ...request, messages: conversation };
    const wantStream = !opts.noStream && provider.capabilities.streaming;
    if (wantStream) {
      let accumulated = '';
      let usage: GenerateUsage | undefined;
      let finishReason = 'stop';
      for await (const event of provider.stream(fullRequest)) {
        if (event.type === 'text') {
          accumulated += event.text;
          yield { type: 'partial', accumulated, providerId: provider.id, model: provider.model };
        } else {
          finishReason = event.finishReason;
          usage = event.usage;
        }
      }
      if (finishReason === 'length') {
        throw new ModelOutputError(
          'Model output was truncated (finish_reason: length). The response may be incomplete.',
          ['Increase max tokens or reduce the size of the state context.'],
        );
      }
      return { text: accumulated, usage, streamed: true };
    }
    const result = await provider.generate(fullRequest);
    if (result.finishReason === 'length') {
      throw new ModelOutputError(
        'Model output was truncated (finish_reason: length). The response may be incomplete.',
        ['Increase max tokens or reduce the size of the state context.'],
      );
    }
    return { text: result.text, usage: result.usage, streamed: false };
  }

  /** Health report across all providers (used by /api/health). */
  async healthReport(timeoutMs = 5000): Promise<ProviderHealthReport[]> {
    const entries = await Promise.all(
      [...this.providers.values()].map(async (p) => ({
        id: p.id,
        display_name: p.displayName,
        model: p.model,
        privacy: p.capabilities.privacy,
        is_demo: p.capabilities.is_demo,
        health: await p.healthCheck(timeoutMs),
        usage: p.getUsage(),
      })),
    );
    return entries;
  }

  /** Config problems per provider (for diagnostics; never includes secrets). */
  configurationProblems(): Array<{ providerId: string; problems: string[] }> {
    return [...this.providers.values()].map((p) => ({
      providerId: p.id,
      problems: p.validateConfiguration(),
    }));
  }

  /** Which providers could serve a task right now (capability + privacy view). */
  routingPreview(task: AITask): Array<{ providerId: string; eligible: boolean; reasons: string[] }> {
    return [...this.providers.values()].map((p) => {
      const reasons: string[] = [];
      const isLocal = p.capabilities.privacy === 'local';
      const privacyOk =
        this.config.privacy_mode === 'LOCAL_ONLY'
          ? isLocal
          : this.config.privacy_mode === 'CLOUD_ONLY'
            ? !isLocal
            : true;
      if (!privacyOk) reasons.push(`Excluded by privacy mode ${this.config.privacy_mode}.`);
      reasons.push(...unmetRequirements(task, p));
      return { providerId: p.id, eligible: reasons.length === 0, reasons };
    });
  }
}

function issues(error: z.ZodError): string[] {
  return error.issues.slice(0, 10).map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`);
}

function snippet(text: string): string {
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

function repairConversation(
  conversation: ChatCompletionMessage[],
  badOutput: string,
  problems: string[],
): ChatCompletionMessage[] {
  return [
    ...conversation,
    { role: 'assistant', content: snippet(badOutput) },
    {
      role: 'user',
      content: `Your previous response was invalid:\n${problems.map((p) => `- ${p}`).join('\n')}\n\nRespond again with ONLY a corrected JSON object matching the required structure. No prose, no code fences.`,
    },
  ];
}

/**
 * Extract the outermost JSON object from text that may be wrapped in prose or
 * code fences (common for json_object/prompt_only modes).
 */
export function extractJsonObject(text: string): unknown | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidates: string[] = [];
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // keep trying
    }
  }
  return undefined;
}
