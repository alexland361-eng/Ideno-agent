import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { OpenAICompatibleProvider } from '../src/server/ai/providers/openaiCompatible.js';
import type { OpenAICompatibleProviderConfig } from '../src/shared/config.js';
import {
  AuthError,
  RateLimitError,
  TimeoutError,
  ProviderError,
  ContextOverflowError,
  ModelOutputError,
} from '../src/server/ai/errors.js';
import type { GenerateRequest } from '../src/server/ai/types.js';

/**
 * TEST DOUBLE — MockOpenAIEndpoint
 *
 * This is an in-process fake of an OpenAI-compatible HTTP server used ONLY to
 * verify the adapter's wire behavior (request shape, SSE parsing, error
 * classification, timeouts, cancellation). It is NOT a real provider and
 * passing these tests does NOT constitute verification against any real
 * inference service. Real-provider verification requires configuring an
 * actual endpoint and is documented as not performed in this environment.
 */

type MockBehavior =
  | { kind: 'json'; body: unknown }
  | { kind: 'stream'; chunks: string[]; sendDone: boolean }
  | { kind: 'error'; status: number; body: string }
  | { kind: 'hang' }
  | { kind: 'garbage' }
  | { kind: 'empty' };

class MockOpenAIEndpoint {
  server: http.Server;
  url = '';
  behavior: MockBehavior = { kind: 'json', body: {} };
  apiKey?: string;
  lastRequest: { path: string; auth?: string; body: any } | null = null;
  modelsEnabled = true;
  streamOptionsSeen: unknown = undefined;

  constructor() {
    this.server = http.createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        this.lastRequest = {
          path: req.url ?? '/',
          auth: req.headers.authorization,
          body: data ? JSON.parse(data) : undefined,
        };
        if (req.method === 'GET' && req.url === '/v1/models') {
          if (!this.modelsEnabled) {
            res.writeHead(404).end('{}');
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: [{ id: 'mock-model-a' }, { id: 'mock-model-b' }] }));
          return;
        }
        if (req.method === 'POST' && req.url === '/v1/chat/completions') {
          this.streamOptionsSeen = this.lastRequest?.body?.stream_options;
          if (this.apiKey && req.headers.authorization !== `Bearer ${this.apiKey}`) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'bad key' } }));
            return;
          }
          this.handleCompletion(res);
          return;
        }
        res.writeHead(404).end();
      });
    });
  }

  private handleCompletion(res: http.ServerResponse) {
    const b = this.behavior;
    switch (b.kind) {
      case 'json': {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(b.body));
        return;
      }
      case 'stream': {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const chunk of b.chunks) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
        }
        if (b.sendDone) res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      case 'error': {
        res.writeHead(b.status, { 'Content-Type': 'application/json' });
        res.end(b.body);
        return;
      }
      case 'hang': {
        // Accept the request, never respond.
        return;
      }
      case 'garbage': {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('not json at all');
        return;
      }
      case 'empty': {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] }));
        return;
      }
    }
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

function makeProvider(mock: MockOpenAIEndpoint, overrides: Partial<OpenAICompatibleProviderConfig> = {}) {
  const config = {
    type: 'openai_compatible' as const,
    base_url: `${mock.url}/v1`,
    model: 'mock-model-a',
    timeout_ms: 1500,
    ...overrides,
  } as OpenAICompatibleProviderConfig;
  return new OpenAICompatibleProvider('testprov', config, {});
}

const REQ: Omit<GenerateRequest, 'system'> = {
  task: 'conversation',
  messages: [{ role: 'user', content: 'hello' }],
};

beforeEach(async () => {
  mock = new MockOpenAIEndpoint();
  await mock.start();
});

afterEach(async () => {
  await mock.stop();
});

let mock: MockOpenAIEndpoint;

describe('OpenAICompatibleProvider (against an explicit TEST DOUBLE — see file header)', () => {
  it('sends a correct chat completion request', async () => {
    const provider = makeProvider(mock);
    mock.behavior = {
      kind: 'json',
      body: { choices: [{ message: { content: 'hi there' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } },
    };
    const result = await provider.generate({ ...REQ, system: 'sys' });
    expect(result.text).toBe('hi there');
    expect(result.usage?.input_tokens).toBe(3);
    expect(mock.lastRequest?.path).toBe('/v1/chat/completions');
    expect(mock.lastRequest?.body.model).toBe('mock-model-a');
    expect(mock.lastRequest?.body.messages[0]).toEqual({ role: 'system', content: 'sys' });
    expect(mock.lastRequest?.body.messages[1]).toEqual({ role: 'user', content: 'hello' });
    expect(mock.lastRequest?.body.stream).toBe(false);
  });

  it('passes a strict json_schema response_format when the capability is json_schema', async () => {
    const provider = makeProvider(mock);
    mock.behavior = { kind: 'json', body: { choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] } };
    await provider.generate({
      ...REQ,
      system: 'sys',
      jsonSchema: { name: 'ideno_turn', schema: { type: 'object' }, strict: true },
    });
    expect(mock.lastRequest?.body.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'ideno_turn', strict: true, schema: { type: 'object' } },
    });
  });

  it('uses json_object mode when configured (some servers reject json_schema)', async () => {
    const provider = makeProvider(mock, { structured_output: 'json_object' });
    mock.behavior = { kind: 'json', body: { choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] } };
    await provider.generate({
      ...REQ,
      system: 'sys',
      jsonSchema: { name: 'ideno_turn', schema: { type: 'object' } },
    });
    expect(mock.lastRequest?.body.response_format).toEqual({ type: 'json_object' });
    // OpenAI requires the word JSON in messages for json_object mode:
    expect(JSON.stringify(mock.lastRequest?.body.messages)).toContain('JSON');
  });

  it('streams SSE deltas and completes on [DONE]', async () => {
    const provider = makeProvider(mock);
    mock.behavior = { kind: 'stream', chunks: ['{"re', 'ply": "hel', 'lo"}'], sendDone: true };
    let text = '';
    let done = false;
    for await (const ev of provider.stream({ ...REQ, system: 'sys' })) {
      if (ev.type === 'text') text += ev.text;
      else done = true;
    }
    expect(text).toBe('{"reply": "hello"}');
    expect(done).toBe(true);
    expect(mock.lastRequest?.body.stream).toBe(true);
  });

  it('tolerates stream ending without [DONE] and skips invalid lines', async () => {
    const provider = makeProvider(mock);
    // We simulate no-[DONE] by using a raw behavior via custom chunks:
    mock.behavior = { kind: 'stream', chunks: ['abc'], sendDone: false };
    let text = '';
    for await (const ev of provider.stream({ ...REQ, system: 'sys' })) {
      if (ev.type === 'text') text += ev.text;
    }
    expect(text).toBe('abc');
  });

  it('classifies 401 as AuthError', async () => {
    const provider = makeProvider(mock, { api_key: 'secret-key' });
    mock.behavior = { kind: 'error', status: 401, body: JSON.stringify({ error: { message: 'bad key' } }) };
    await expect(provider.generate({ ...REQ, system: 'sys' })).rejects.toThrow(AuthError);
  });

  it('classifies 429 as RateLimitError', async () => {
    const provider = makeProvider(mock);
    mock.behavior = { kind: 'error', status: 429, body: JSON.stringify({ error: { message: 'slow down' } }) };
    await expect(provider.generate({ ...REQ, system: 'sys' })).rejects.toThrow(RateLimitError);
  });

  it('classifies 404 as ProviderError (endpoint or model missing)', async () => {
    const provider = makeProvider(mock);
    mock.behavior = { kind: 'error', status: 404, body: '{}' };
    await expect(provider.generate({ ...REQ, system: 'sys' })).rejects.toThrow(ProviderError);
  });

  it('classifies 400 context-length errors as ContextOverflowError', async () => {
    const provider = makeProvider(mock);
    mock.behavior = { kind: 'error', status: 400, body: JSON.stringify({ error: { message: "This model's maximum context length is 4096 tokens" } }) };
    await expect(provider.generate({ ...REQ, system: 'sys' })).rejects.toThrow(ContextOverflowError);
  });

  it('classifies 500 as ProviderError', async () => {
    const provider = makeProvider(mock);
    mock.behavior = { kind: 'error', status: 500, body: 'oops' };
    await expect(provider.generate({ ...REQ, system: 'sys' })).rejects.toThrow(ProviderError);
  });

  it('times out when the endpoint hangs', async () => {
    const provider = makeProvider(mock, { timeout_ms: 300 });
    mock.behavior = { kind: 'hang' };
    await expect(provider.generate({ ...REQ, system: 'sys' })).rejects.toThrow(TimeoutError);
  });

  it('classifies empty model output as ModelOutputError', async () => {
    const provider = makeProvider(mock);
    mock.behavior = { kind: 'empty' };
    await expect(provider.generate({ ...REQ, system: 'sys' })).rejects.toThrow(ModelOutputError);
  });

  it('classifies non-JSON success bodies as ModelOutputError', async () => {
    const provider = makeProvider(mock);
    mock.behavior = { kind: 'garbage' };
    await expect(provider.generate({ ...REQ, system: 'sys' })).rejects.toThrow(ModelOutputError);
  });

  it('reports unreachable endpoints in health checks without throwing', async () => {
    const provider = makeProvider(mock);
    await mock.stop();
    const health = await provider.healthCheck(500);
    expect(health.ok).toBe(false);
  });

  it('lists models from /models', async () => {
    const provider = makeProvider(mock);
    const models = await provider.listModels();
    expect(models).toEqual(['mock-model-a', 'mock-model-b']);
  });

  it('health check reports ok when endpoint is reachable even if /models is missing', async () => {
    const provider = makeProvider(mock);
    mock.modelsEnabled = false;
    const health = await provider.healthCheck(500);
    expect(health.ok).toBe(true);
    expect(health.detail).toContain('/models is not implemented');
  });

  it('cancels generation through an external signal', async () => {
    const provider = makeProvider(mock);
    mock.behavior = { kind: 'hang' };
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    await expect(
      provider.generate({ ...REQ, system: 'sys', signal: controller.signal, timeoutMs: 10_000 }),
    ).rejects.toThrow(/cancel/i);
  });
});
