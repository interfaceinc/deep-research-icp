/**
 * ScrapeCreators Service
 * Reddit search API client
 * Docs: https://docs.scrapecreators.com/v1/reddit/search
 */

import axios, { AxiosError } from 'axios';
import pLimit from 'p-limit';
import { env } from '../config/env.js';
import { ResearchRateLimiter, withRetry } from './rate-limiter.service.js';
import type { RedditSource, QuoteEngagement } from './research.types.js';
import { RESEARCH_DEFAULTS } from './research.types.js';

const SCRAPE_CREATORS_BASE_URL = 'https://api.scrapecreators.com/v1';

interface ScrapeCreatorsSearchParams {
  query: string;
  sort?: 'relevance' | 'hot' | 'new' | 'top';
  timeframe?: 'all' | 'year' | 'month' | 'week' | 'day';
}

interface ScrapeCreatorsPost {
  id: string;
  title: string;
  selftext: string;
  subreddit: string;
  author: string;
  created_utc: number;
  score: number;
  num_comments: number;
  upvote_ratio: number;
  permalink: string;
  url: string;
}

interface ScrapeCreatorsResponse {
  data?: {
    posts?: ScrapeCreatorsPost[];
    comments?: ScrapeCreatorsComment[];
  };
  posts?: ScrapeCreatorsPost[];
  comments?: ScrapeCreatorsComment[];
  error?: string;
}

interface ScrapeCreatorsComment {
  id: string;
  body: string;
  subreddit: string;
  author: string;
  created_utc: number;
  score: number;
  permalink: string;
  link_id: string;
}

export class ScrapeCreatorsService {
  private apiKey: string;
  private rateLimiter: ResearchRateLimiter;
  private concurrencyLimit: ReturnType<typeof pLimit>;

  constructor() {
    const apiKey = env.SCRAPE_CREATORS_API_KEY;
    if (!apiKey) {
      throw new Error('SCRAPE_CREATORS_API_KEY not configured in environment');
    }
    this.apiKey = apiKey;
    this.rateLimiter = new ResearchRateLimiter();
    this.concurrencyLimit = pLimit(RESEARCH_DEFAULTS.SCRAPE_CREATORS_CONCURRENCY);
  }

  /**
   * Search Reddit for posts matching query
   */
  async searchPosts(params: ScrapeCreatorsSearchParams): Promise<ScrapeCreatorsPost[]> {
    await this.rateLimiter.waitForRateLimit();

    const response = await withRetry(
      async () => {
        const result = await axios.get<ScrapeCreatorsResponse>(
          `${SCRAPE_CREATORS_BASE_URL}/reddit/search`,
          {
            headers: {
              'x-api-key': this.apiKey,
              'Content-Type': 'application/json',
            },
            params: {
              query: params.query,
              sort: params.sort || 'relevance',
              timeframe: params.timeframe || 'year',
            },
            timeout: 30000,
          }
        );
        return result;
      },
      {
        maxRetries: 3,
        context: `search_posts:${params.query}`,
        isRetryableError: (error) => {
          if (error instanceof AxiosError) {
            const status = error.response?.status;
            return status === 429 || status === 503 || status === 502;
          }
          return false;
        },
      }
    );

    const posts = response.data.data?.posts || response.data.posts || [];
    return posts;
  }

  /**
   * Transform ScrapeCreators post to RedditSource
   */
  private transformPost(post: ScrapeCreatorsPost): RedditSource {
    const engagement: QuoteEngagement = {
      score: post.score || 0,
      num_comments: post.num_comments || 0,
      upvote_ratio: post.upvote_ratio || null,
    };

    // Combine title and selftext for full content
    const rawText = post.selftext
      ? `${post.title}\n\n${post.selftext}`
      : post.title;

    return {
      source_id: `t3_${post.id}`,
      source_url: `https://reddit.com${post.permalink}`,
      created_at_platform: post.created_utc
        ? new Date(post.created_utc * 1000).toISOString()
        : null,
      subreddit: post.subreddit,
      engagement,
      raw_text: rawText,
      post_type: 'post',
    };
  }

  /**
   * Search Reddit with a query and return normalized sources
   */
  async searchForSources(
    query: string,
    _options: { limit?: number } = {}
  ): Promise<RedditSource[]> {
    const posts = await this.searchPosts({
      query,
      sort: 'relevance',
      timeframe: 'year',
    });

    return posts.map((p) => this.transformPost(p));
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
      if (seen.has(source.source_id)) {
        return false;
      }
      seen.add(source.source_id);
      return true;
    });
  }
}
