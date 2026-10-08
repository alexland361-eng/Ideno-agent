import type { StructuredOutputMode } from '../../shared/config.js';

/**
 * AI Runtime interface (§8).
 *
 * Ideno Core depends ONLY on this abstraction. Provider adapters implement it;
 * the core never imports provider-specific code.
 */

export interface ProviderCapabilities {
  /** How strictly structured output is supported. */
  structured_output: StructuredOutputMode;
  streaming: boolean;
  /** 'local' providers run on the user's own infrastructure. */
  privacy: 'local' | 'cloud';
  /** True for the scripted demo provider (labeled everywhere; never AI). */
  is_demo: boolean;
  /** Vision/multimodal support is declared, not assumed. */
  vision: boolean;
  /** Rough context window estimate in tokens, if known. */
  context_estimate_tokens?: number;
}

export interface ChatCompletionMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface JsonSchemaSpec {
  name: string;
  /** JSON Schema (draft 2020-12 subset understood by OpenAI-compatible servers). */
  schema: Record<string, unknown>;
  strict?: boolean;
}

export interface GenerateRequest {
  task: string;
  system: string;
  messages: ChatCompletionMessage[];
  /** When present, request structured output conforming to this schema. */
  jsonSchema?: JsonSchemaSpec;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Overrides the provider default model for this request. */
  model?: string;
}

export interface GenerateUsage {
  input_tokens?: number;
  output_tokens?: number;
}

export interface GenerateResult {
  text: string;
  finishReason: string;
  usage?: GenerateUsage;
  model: string;
}

export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'done'; finishReason: string; usage?: GenerateUsage };

export interface HealthResult {
  ok: boolean;
  detail: string;
  latencyMs?: number;
  models?: string[];
}

/**
 * A provider adapter. `generate` and `stream` must both exist; providers that
 * cannot stream implement `stream` by delegating to `generate` and yielding
 * the whole text at once (capabilities.streaming reports the truth).
 */
export interface AIProvider {
  readonly id: string;
  readonly displayName: string;
  readonly model: string;
  readonly capabilities: ProviderCapabilities;

  validateConfiguration(): string[];
  healthCheck(timeoutMs?: number): Promise<HealthResult>;
  listModels(): Promise<string[]>;
  generate(req: GenerateRequest): Promise<GenerateResult>;
  stream(req: GenerateRequest): AsyncGenerator<StreamEvent>;
  /** In-memory usage counters since process start (best effort). */
  getUsage(): { requests: number; input_tokens: number; output_tokens: number };
}
