import { AppError } from '../../shared/errors.js';

/**
 * Research provider interface (§17 Research Integrity).
 *
 * Research is a SEPARATE system concern from LLM inference. A model may
 * summarize research, but it must not invent the underlying evidence. Only a
 * research provider can create `external` evidence records, and every external
 * claim must carry a traceable source.
 *
 * Since v0.3 the HTTP provider (httpProvider.ts) implements Tavily, Brave,
 * and self-hosted SearXNG. When none is configured this NoResearchProvider
 * fails explicitly rather than pretending to work.
 */

export interface ResearchQuery {
  question: string;
  /** Terms to search for, if the provider needs them. */
  keywords?: string[];
  max_results?: number;
}

export interface ResearchSource {
  title: string;
  url: string;
  source_type: 'web' | 'documentation' | 'paper' | 'forum' | 'other';
  author?: string;
  publication_date?: string;
  excerpt?: string;
}

export interface ResearchResult {
  query: ResearchQuery;
  sources: ResearchSource[];
  retrieved_at: string;
}

export interface ResearchProvider {
  readonly id: string;
  readonly displayName: string;
  search(query: ResearchQuery): Promise<ResearchResult>;
}

/**
 * The provider used when no research backend is configured. It never returns
 * data; it throws a classified error so the UI can state plainly that
 * research is unavailable in this configuration.
 */
export class NoResearchProvider implements ResearchProvider {
  readonly id = 'none';
  readonly displayName = 'No research provider configured';

  async search(): Promise<ResearchResult> {
    throw new AppError(
      'RESEARCH_UNAVAILABLE',
      'No research provider is configured, so external research is unavailable in this Ideno instance.',
      {
        detail: [
          'Research is intentionally not faked: model statements are never presented as external evidence.',
          'Configure a research provider in config/ideno.config.json (tavily, brave, or searxng) to enable sourced evidence.',
        ],
        recoverable: false,
      },
    );
  }
}
