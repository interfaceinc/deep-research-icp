/**
 * SerpAPI Reddit Search Service
 * Replaces ScrapeCreators. Uses SerpAPI's Google engine scoped to reddit.com
 * to discover relevant threads. Each organic result (title + snippet) becomes a
 * RedditSource. Snippets are genuine first-person excerpts Google surfaces from
 * the post/comments.
 *
 * NOTE: This yields shorter source text than full-post scraping. For deeper
 * extraction (full bodies + comments), swap this for the official Reddit API.
 * Docs: https://serpapi.com/search-api
 */

import axios, { AxiosError } from 'axios';
import pLimit from 'p-limit';
import { env } from '../config/env.js';
import { ResearchRateLimiter, withRetry } from './rate-limiter.service.js';
import type { RedditSource, QuoteEngagement } from './research.types.js';
import { RESEARCH_DEFAULTS } from './research.types.js';

const SERPAPI_BASE_URL = 'https://serpapi.com/search.json';

interface SerpApiOrganicResult {
  title?: string;
  link?: string;
  snippet?: string;
  displayed_link?: string;
}

interface SerpApiResponse {
  organic_results?: SerpApiOrganicResult[];
  error?: string;
}

export class SerpApiRedditService {
  private apiKey: string;
  private rateLimiter: ResearchRateLimiter;
  private concurrencyLimit: ReturnType<typeof pLimit>;

  constructor() {
    const apiKey = env.SERPAPI_KEY;
    if (!apiKey) {
      throw new Error('SERPAPI_KEY not configured in environment');
    }
    this.apiKey = apiKey;
    this.rateLimiter = new ResearchRateLimiter();
    this.concurrencyLimit = pLimit(RESEARCH_DEFAULTS.SEARCH_CONCURRENCY);
  }

  /**
   * Parse a Reddit permalink into subreddit + post id.
   * e.g. https://www.reddit.com/r/workingmoms/comments/1abc23/title_slug/
   */
  private parseRedditUrl(url: string): { subreddit: string | null; postId: string | null } {
    try {
      const u = new URL(url);
      const subMatch = u.pathname.match(/\/r\/([^/]+)/i);
      const idMatch = u.pathname.match(/\/comments\/([a-z0-9]+)/i);
      return {
        subreddit: subMatch ? subMatch[1] : null,
        postId: idMatch ? idMatch[1] : null,
      };
    } catch {
      return { subreddit: null, postId: null };
    }
  }

  /**
   * Extract an approximate comment count from displayed_link
   * e.g. "20+ comments · 1 year ago" -> 20
   */
  private parseCommentCount(displayedLink?: string): number {
    if (!displayedLink) return 0;
    const m = displayedLink.match(/([\d,]+)\+?\s*comments?/i);
    if (!m) return 0;
    return parseInt(m[1].replace(/,/g, ''), 10) || 0;
  }

  private async searchPage(query: string, start: number): Promise<SerpApiOrganicResult[]> {
    await this.rateLimiter.waitForRateLimit();

    const response = await withRetry(
      async () => {
        const result = await axios.get<SerpApiResponse>(SERPAPI_BASE_URL, {
          params: {
            engine: 'google',
            q: `${query} site:reddit.com`,
            num: 10,
            start,
            api_key: this.apiKey,
          },
          timeout: 30000,
        });
        if (result.data.error) {
          throw new Error(`SerpAPI error: ${result.data.error}`);
        }
        return result;
      },
      {
        maxRetries: 3,
        context: `serpapi_search:${query}:${start}`,
        isRetryableError: (error) => {
          if (error instanceof AxiosError) {
            const status = error.response?.status;
            return status === 429 || status === 503 || status === 502;
          }
          return false;
        },
      }
    );

    return response.data.organic_results || [];
  }

  private transformResult(result: SerpApiOrganicResult): RedditSource | null {
    if (!result.link || !result.link.includes('reddit.com')) return null;
    const { subreddit, postId } = this.parseRedditUrl(result.link);
    if (!postId) return null;

    const title = result.title?.replace(/\s*:\s*r\/\S+\s*$/i, '').trim() || '';
    const snippet = result.snippet?.trim() || '';
    // Combine title + snippet as the source text to extract quotes from.
    const rawText = snippet ? `${title}\n\n${snippet}` : title;

    const engagement: QuoteEngagement = {
      score: 0,
      num_comments: this.parseCommentCount(result.displayed_link),
      upvote_ratio: null,
    };

    return {
      source_id: `t3_${postId}`,
      source_url: result.link,
      created_at_platform: null,
      subreddit: subreddit || 'unknown',
      engagement,
      raw_text: rawText,
      post_type: 'post',
    };
  }

  /**
   * Search Reddit (via Google) for a query, paginating a few pages deep.
   */
  async searchForSources(
    query: string,
    _options: { limit?: number } = {}
  ): Promise<RedditSource[]> {
    const sources: RedditSource[] = [];
    for (let page = 0; page < RESEARCH_DEFAULTS.SEARCH_PAGES_PER_QUERY; page++) {
      const results = await this.searchPage(query, page * 10);
      if (results.length === 0) break;
      for (const r of results) {
        const source = this.transformResult(r);
        if (source) sources.push(source);
      }
      if (results.length < 10) break; // no more pages
    }
    return sources;
  }

  /**
   * Search multiple queries with concurrency control
   */
  async searchMultipleQueries(
    queries: string[],
    onProgress?: (completed: number, total: number, query: string) => void
  ): Promise<Map<string, RedditSource[]>> {
    const results = new Map<string, RedditSource[]>();
    let completed = 0;

    await Promise.all(
      queries.map((query) =>
        this.concurrencyLimit(async () => {
          try {
            const sources = await this.searchForSources(query);
            results.set(query, sources);
          } catch (error) {
            console.error(`Failed to search query "${query}":`, error);
            results.set(query, []);
          }
          completed++;
          onProgress?.(completed, queries.length, query);
        })
      )
    );

    return results;
  }

  /**
   * Deduplicate sources by source_id
   */
  deduplicateSources(sources: RedditSource[]): RedditSource[] {
    const seen = new Set<string>();
    return sources.filter((source) => {
      if (seen.has(source.source_id)) return false;
      seen.add(source.source_id);
      return true;
    });
  }
}
