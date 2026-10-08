import { AppError } from '../../shared/errors.js';
import { NoResearchProvider } from './interface.js';
import type {
  ResearchProvider,
  ResearchQuery,
  ResearchResult,
  ResearchSource,
} from './interface.js';
import type { ResearchProviderConfig } from '../../shared/config.js';

/**
 * HTTP research providers (§17 Research Integrity).
 *
 * Three shapes are supported, all config-driven (no vendor is hard-coded in
 * the core): Tavily, Brave Search API, and self-hosted SearXNG. The provider
 * returns SOURCED results only — the LLM never generates these records
 * (that is the entire point of the research/conversation split).
 *
 * Secrets are read from the environment (api_key_env); keys never appear in
 * the config file, logs, or API responses. Base URLs can be overridden to
 * point at mirrors or self-hosted instances.
 */

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_EXCERPT_CHARS = 600;

interface ResearchHttpDeps {
  fetchFn?: typeof fetch;
  now?: () => string;
}

function classifySource(url: string): ResearchSource['source_type'] {
  const u = url.toLowerCase();
  if (/arxiv\.org|doi\.org|\.edu\/|biorxiv|ssrn/.test(u)) return 'paper';
  if (/docs?\.|developer\.|documentation|\/wiki\//.test(u)) return 'documentation';
  if (/forum|discuss|reddit|stackexchange|stackoverflow|news\.ycombinator/.test(u)) return 'forum';
  return 'web';
}

function makeSource(input: { title?: unknown; url?: unknown; content?: unknown; published_date?: unknown }): ResearchSource | null {
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  const url = typeof input.url === 'string' ? input.url.trim() : '';
  if (!title || !/^https?:\/\//i.test(url)) return null; // a source without a traceable URL is not evidence
  const excerpt = typeof input.content === 'string' ? input.content.slice(0, MAX_EXCERPT_CHARS) : undefined;
  const date = typeof input.published_date === 'string' && input.published_date ? input.published_date : undefined;
  return { title, url, source_type: classifySource(url), excerpt, publication_date: date };
}

async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new AppError(
        'PROVIDER_UNAVAILABLE',
        `Research provider returned HTTP ${res.status}.`,
        { detail: body ? [body.slice(0, 300)] : undefined, recoverable: true },
      );
    }
    return await res.json();
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new AppError('TIMEOUT', `Research provider timed out after ${timeoutMs}ms.`, {
        recoverable: true,
      });
    }
    throw new AppError(
      'PROVIDER_UNAVAILABLE',
      `Could not reach the research provider: ${err instanceof Error ? err.message : String(err)}.`,
      { recoverable: true },
    );
  } finally {
    clearTimeout(timer);
  }
}

function readEnvKey(name: string, providerLabel: string): string {
  const key = process.env[name];
  if (!key) {
    throw new AppError(
      'CONFIG_INVALID',
      `Research provider '${providerLabel}' requires the ${name} environment variable.`,
      { detail: [`Set ${name} to enable this provider. Keys are never stored in config files.`] },
    );
  }
  return key;
}

export class HttpResearchProvider implements ResearchProvider {
  readonly id: string;
  readonly displayName: string;

  constructor(
    private readonly cfg: ResearchProviderConfig,
    private readonly deps: ResearchHttpDeps = {},
  ) {
    this.id = `research-${cfg.type}`;
    this.displayName =
      cfg.type === 'searxng' ? `SearXNG (${new URL(cfg.base_url).host})` : cfg.type === 'tavily' ? 'Tavily' : 'Brave Search';
  }

  async search(query: ResearchQuery): Promise<ResearchResult> {
    const max = Math.min(Math.max(query.max_results ?? 5, 1), 10);
    const keywords = query.keywords?.length
      ? `${query.question} ${query.keywords.join(' ')}`
      : query.question;
    const timeout = this.cfg.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    const fetchFn = this.deps.fetchFn ?? fetch;

    let raw: { title?: unknown; url?: unknown; content?: unknown; published_date?: unknown }[] = [];

    if (this.cfg.type === 'tavily') {
      const key = readEnvKey(this.cfg.api_key_env, 'tavily');
      const body = (await fetchJson(
        `${this.cfg.base_url ?? 'https://api.tavily.com'}/search`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ api_key: key, query: keywords, max_results: max, search_depth: 'basic' }),
        },
        timeout,
        fetchFn,
      )) as { results?: unknown[] } | null;
      raw = (body?.results ?? []) as typeof raw;
    } else if (this.cfg.type === 'brave') {
      const key = readEnvKey(this.cfg.api_key_env, 'brave');
      const url = `${this.cfg.base_url ?? 'https://api.search.brave.com'}/res/v1/web/search?q=${encodeURIComponent(keywords)}&count=${max}`;
      const body = (await fetchJson(
        url,
        { headers: { Accept: 'application/json', 'X-Subscription-Token': key } },
        timeout,
        fetchFn,
      )) as { web?: { results?: unknown[] } } | null;
      raw = (body?.web?.results ?? []) as typeof raw;
    } else {
      // SearXNG: self-hosted, no key. publishedDate is the SearXNG field name.
      const url = `${this.cfg.base_url}/search?q=${encodeURIComponent(keywords)}&format=json&language=en`;
      const body = (await fetchJson(url, { headers: { Accept: 'application/json' } }, timeout, fetchFn)) as {
        results?: { title?: unknown; url?: unknown; content?: unknown; publishedDate?: unknown }[];
      } | null;
      raw = (body?.results ?? []).map((r) => ({
        title: r.title,
        url: r.url,
        content: r.content,
        published_date: r.publishedDate,
      }));
    }

    const sources = raw
      .map((r) => makeSource(r))
      .filter((s): s is ResearchSource => s !== null)
      .slice(0, max);

    return {
      query,
      sources,
      retrieved_at: this.deps.now ? this.deps.now() : new Date().toISOString(),
    };
  }
}

/** Build the configured research provider, or the explicit "unavailable" one. */
export function buildResearchProvider(
  cfg: ResearchProviderConfig | undefined,
): ResearchProvider {
  if (!cfg) return new NoResearchProvider();
  return new HttpResearchProvider(cfg);
}
