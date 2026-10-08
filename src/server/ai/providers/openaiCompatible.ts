import type {
  AIProvider,
  GenerateRequest,
  GenerateResult,
  HealthResult,
  ProviderCapabilities,
  StreamEvent,
} from '../types.js';
import type { OpenAICompatibleProviderConfig } from '../../../shared/config.js';
import {
  CancelledError,
  ProviderError,
  RateLimitError,
  TimeoutError,
  classifyHttpFailure,
  classifyNetworkFailure,
  ModelOutputError,
} from '../errors.js';

/**
 * OpenAI-compatible adapter (§7C) — the primary real provider for v0.1.
 *
 * Works against any endpoint implementing POST /chat/completions and
 * GET /models: OpenAI itself, Ollama, llama.cpp server, vLLM, LM Studio,
 * OpenRouter-style gateways, reverse proxies, self-hosted remote servers.
 * The core never imports this file — only the registry does.
 */

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 5_000;

interface WireMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class OpenAICompatibleProvider implements AIProvider {
  readonly id: string;
  readonly displayName: string;
  readonly model: string;
  readonly capabilities: ProviderCapabilities;
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly apiKeyEnvName?: string;
  private readonly configTimeoutMs: number;
  private readonly includeUsageInStream: boolean;
  private usage = { requests: 0, input_tokens: 0, output_tokens: 0 };

  constructor(id: string, config: OpenAICompatibleProviderConfig, env: Record<string, string | undefined>) {
    this.id = id;
    this.displayName = config.display_name ?? `OpenAI-compatible (${id})`;
    this.model = config.model;
    this.baseUrl = config.base_url.replace(/\/+$/, '');
    this.apiKeyEnvName = config.api_key_env;
    const envKey = config.api_key_env ? env[config.api_key_env] : undefined;
    this.apiKey = envKey && envKey.length > 0 ? envKey : config.api_key;
    this.configTimeoutMs = config.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    this.includeUsageInStream = config.include_usage_in_stream ?? false;
    this.capabilities = {
      structured_output: config.structured_output ?? 'json_schema',
      streaming: config.streaming ?? true,
      privacy: config.privacy,
      is_demo: false,
      vision: false,
    };
  }

  validateConfiguration(): string[] {
    const problems: string[] = [];
    try {
      new URL(this.baseUrl);
    } catch {
      problems.push(`base_url is not a valid URL: ${safeUrl(this.baseUrl)}`);
    }
    if (!this.model) problems.push('model is empty');
    if (!this.apiKey && !this.apiKeyEnvName) {
      problems.push('No API key configured (set api_key_env or api_key). Some local servers accept this.');
    } else if (this.apiKeyEnvName && !this.apiKey) {
      problems.push(`Env var ${this.apiKeyEnvName} is not set.`);
    }
    return problems;
  }

  async healthCheck(timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS): Promise<HealthResult> {
    const started = Date.now();
    try {
      const res = await this.fetchWithTimeout(
        `${this.baseUrl}/models`,
        { method: 'GET', headers: this.headers() },
        timeoutMs,
      );
      const latencyMs = Date.now() - started;
      if (res.status === 401 || res.status === 403) {
        return { ok: false, detail: `Authentication failed (HTTP ${res.status}). Check the API key.`, latencyMs };
      }
      if (res.status === 404) {
        return { ok: true, detail: 'Endpoint reachable; /models is not implemented on this server.', latencyMs };
      }
      if (!res.ok) {
        return { ok: false, detail: `HTTP ${res.status}`, latencyMs };
      }
      let models: string[] | undefined;
      try {
        const body = (await res.json()) as { data?: Array<{ id?: string }> };
        models = (body.data ?? []).map((m) => m.id ?? '').filter(Boolean);
      } catch {
        // reachable but non-JSON body — fine for health purposes
      }
      return { ok: true, detail: `Endpoint reachable; ${models?.length ?? '?'} models listed.`, latencyMs, models };
    } catch (err) {
      return {
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - started,
      };
    }
  }

  async listModels(): Promise<string[]> {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/models`,
      { method: 'GET', headers: this.headers() },
      this.configTimeoutMs,
    );
    if (!res.ok) {
      throw classifyHttpFailure(res.status, await safeText(res), { providerId: this.id, url: safeUrl(this.baseUrl) });
    }
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    return (body.data ?? []).map((m) => m.id ?? '').filter(Boolean);
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const body = this.buildBody(req, false);
    const timeoutMs = req.timeoutMs ?? this.configTimeoutMs;
    const res = await this.doFetch(body, timeoutMs, req.signal);
    this.usage.requests += 1;

    if (!res.ok) {
      throw classifyHttpFailure(res.status, await safeText(res), { providerId: this.id, url: safeUrl(this.baseUrl) });
    }
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch (err) {
      throw new ModelOutputError('Provider returned a non-JSON response body.', [], err);
    }
    const completion = parsed as {
      choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      error?: { message?: string };
    };
    if (completion.error) {
      throw new ModelOutputError(`Provider reported an error: ${completion.error.message ?? 'unknown'}`);
    }
    const choice = completion.choices?.[0];
    const text = choice?.message?.content ?? '';
    if (!text.trim()) {
      throw new ModelOutputError('Model returned empty output.', ['The model produced no content. Try again or use a different model.']);
    }
    if (completion.usage) {
      this.usage.input_tokens += completion.usage.prompt_tokens ?? 0;
      this.usage.output_tokens += completion.usage.completion_tokens ?? 0;
    }
    return {
      text,
      finishReason: choice?.finish_reason ?? 'stop',
      usage: {
        input_tokens: completion.usage?.prompt_tokens,
        output_tokens: completion.usage?.completion_tokens,
      },
      model: this.model,
    };
  }

  async *stream(req: GenerateRequest): AsyncGenerator<StreamEvent> {
    const body = this.buildBody(req, true);
    const timeoutMs = req.timeoutMs ?? this.configTimeoutMs;
    const res = await this.doFetch(body, timeoutMs, req.signal);
    this.usage.requests += 1;

    if (!res.ok) {
      throw classifyHttpFailure(res.status, await safeText(res), { providerId: this.id, url: safeUrl(this.baseUrl) });
    }
    if (!res.body) {
      throw new ProviderError('Streaming response has no body.', [safeUrl(this.baseUrl)]);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let sawContent = false;
    let finishReason = 'stop';
    let usage: { input_tokens?: number; output_tokens?: number } | undefined;

    // Overall stream watchdog: reset on every chunk.
    let timedOut = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const armWatchdog = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
    };
    const onExternalAbort = () => controller.abort();
    req.signal?.addEventListener('abort', onExternalAbort, { once: true });
    armWatchdog();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        armWatchdog();
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newlineIndex).trimEnd();
          buffer = buffer.slice(newlineIndex + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') {
            if (!sawContent) {
              throw new ModelOutputError('Model stream ended without any content.');
            }
            if (usage) {
              this.usage.input_tokens += usage.input_tokens ?? 0;
              this.usage.output_tokens += usage.output_tokens ?? 0;
            }
            yield { type: 'done', finishReason, usage };
            return;
          }
          let chunk: unknown;
          try {
            chunk = JSON.parse(payload);
          } catch {
            continue; // tolerate keepalive/invalid lines
          }
          const evt = chunk as {
            choices?: Array<{ delta?: { content?: string | null }; finish_reason?: string | null }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
            error?: { message?: string; code?: string };
          };
          if (evt.error) {
            const msg = evt.error.message ?? 'unknown stream error';
            if (/rate.?limit/i.test(msg)) throw new RateLimitError(`Provider rate limited mid-stream: ${msg}`);
            throw new ModelOutputError(`Provider error mid-stream: ${msg}`);
          }
          if (evt.usage) {
            usage = { input_tokens: evt.usage.prompt_tokens, output_tokens: evt.usage.completion_tokens };
          }
          const delta = evt.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta.length > 0) {
            sawContent = true;
            yield { type: 'text', text: delta };
          }
          const fr = evt.choices?.[0]?.finish_reason;
          if (fr) finishReason = fr;
        }
      }
      // Stream ended without [DONE] — some servers do this.
      if (!sawContent) {
        throw new ModelOutputError('Model stream ended without any content.');
      }
      if (usage) {
        this.usage.input_tokens += usage.input_tokens ?? 0;
        this.usage.output_tokens += usage.output_tokens ?? 0;
      }
      yield { type: 'done', finishReason, usage };
    } catch (err) {
      if (timedOut) {
        throw new TimeoutError(`Stream from ${this.id} stalled for over ${timeoutMs}ms.`);
      }
      if (req.signal?.aborted) {
        throw new CancelledError('Generation cancelled.');
      }
      if (err instanceof Error && err.name === 'AbortError') {
        throw new CancelledError('Generation cancelled.');
      }
      throw err;
    } finally {
      if (watchdog) clearTimeout(watchdog);
      req.signal?.removeEventListener('abort', onExternalAbort);
      reader.releaseLock();
    }
  }

  getUsage() {
    return { ...this.usage };
  }

  // -------------------------------------------------------------------------

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  private buildBody(req: GenerateRequest, stream: boolean): Record<string, unknown> {
    const messages: WireMessage[] = [{ role: 'system', content: req.system }, ...req.messages];
    let systemSuffix = '';
    const body: Record<string, unknown> = {
      model: req.model ?? this.model,
      messages,
      stream,
    };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;

    if (req.jsonSchema) {
      switch (this.capabilities.structured_output) {
        case 'json_schema':
          body.response_format = {
            type: 'json_schema',
            json_schema: {
              name: req.jsonSchema.name,
              strict: req.jsonSchema.strict ?? true,
              schema: req.jsonSchema.schema,
            },
          };
          break;
        case 'json_object':
          // json_object mode requires the word "JSON" in the messages for OpenAI.
          systemSuffix =
            '\n\nRespond with a single JSON object only. It must match the JSON structure described in the instructions.';
          body.response_format = { type: 'json_object' };
          break;
        case 'none':
          // Runtime already appended prompt instructions for this mode.
          break;
      }
    }
    if (systemSuffix && messages.length > 0) {
      (messages[0] as WireMessage).content += systemSuffix;
    }
    if (stream && this.includeUsageInStream) {
      body.stream_options = { include_usage: true };
    }
    return body;
  }

  /**
   * Fetch with a timeout that combines the request timeout with an external
   * cancellation signal. Throws classified AppErrors, never raw AbortErrors.
   */
  private async doFetch(
    body: Record<string, unknown>,
    timeoutMs: number,
    externalSignal: AbortSignal | undefined,
  ): Promise<Response> {
    let timedOut = false;
    const timeoutController = new AbortController();
    const timer = setTimeout(() => {
      timedOut = true;
      timeoutController.abort();
    }, timeoutMs);
    const onExternalAbort = () => timeoutController.abort();
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: timeoutController.signal,
      });
      return res;
    } catch (err) {
      if (timedOut) {
        throw new TimeoutError(`Request to ${this.id} timed out after ${timeoutMs}ms.`);
      }
      if (externalSignal?.aborted) {
        throw new CancelledError('Generation cancelled.');
      }
      throw classifyNetworkFailure(err, { providerId: this.id, url: safeUrl(this.baseUrl), timeoutMs });
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
        throw new TimeoutError(`Request to ${safeUrl(url)} timed out after ${timeoutMs}ms.`);
      }
      throw classifyNetworkFailure(err, { providerId: this.id, url: safeUrl(url), timeoutMs });
    } finally {
      clearTimeout(timer);
    }
  }
}

function safeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '<invalid url>';
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
