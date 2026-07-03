/**
 * ScrapeCreators TikTok Search Service
 * Keyword search → comment-count pre-filter → batched comments per video.
 * One Source per video (caption + top comments) to minimize Gemini calls.
 *
 * Docs: https://docs.scrapecreators.com/v1/tiktok/search/keyword
 *       https://docs.scrapecreators.com/v1/tiktok/video/comments
 */

import axios, { AxiosError } from 'axios';
import pLimit from 'p-limit';
import { env } from '../config/env.js';
import { ResearchRateLimiter, withRetry } from './rate-limiter.service.js';
import type { QuoteEngagement, RedditSource } from './research.types.js';
import { RESEARCH_DEFAULTS } from './research.types.js';

const SCRAPECREATORS_BASE_URL = 'https://api.scrapecreators.com';

interface TikTokAuthor {
  unique_id?: string;
}

interface TikTokStatistics {
  comment_count?: number;
  digg_count?: number;
}

interface TikTokAwemeInfo {
  aweme_id?: string;
  desc?: string;
  share_url?: string;
  create_time?: number;
  author?: TikTokAuthor;
  statistics?: TikTokStatistics;
}

interface TikTokSearchItem extends Partial<TikTokAwemeInfo> {
  aweme_info?: TikTokAwemeInfo;
}

interface TikTokSearchResponse {
  search_item_list?: TikTokSearchItem[];
  cursor?: number;
  has_more?: number | boolean;
  error?: string;
}

interface TikTokComment {
  cid?: string;
  text?: string;
  digg_count?: number;
}

interface TikTokCommentsResponse {
  comments?: TikTokComment[];
  cursor?: number;
  has_more?: number | boolean;
  error?: string;
}

interface VideoCandidate {
  aweme_id: string;
  desc: string;
  share_url: string;
  create_time: number | null;
  author_handle: string;
  comment_count: number;
  digg_count: number;
}

export class ScrapeCreatorsTikTokService {
  private apiKey: string;
  private rateLimiter: ResearchRateLimiter;
  private concurrencyLimit: ReturnType<typeof pLimit>;

  constructor() {
    const apiKey = env.SCRAPECREATORS_API_KEY;
    if (!apiKey) {
      throw new Error('SCRAPECREATORS_API_KEY not configured in environment');
    }
    this.apiKey = apiKey;
    this.rateLimiter = new ResearchRateLimiter();
    this.concurrencyLimit = pLimit(RESEARCH_DEFAULTS.SEARCH_CONCURRENCY);
  }

  private get headers() {
    return { 'x-api-key': this.apiKey };
  }

  private isRetryableError(error: unknown): boolean {
    if (error instanceof AxiosError) {
      const status = error.response?.status;
      return status === 429 || status === 503 || status === 502;
    }
    return false;
  }

  private async apiGet<T>(
    path: string,
    params: Record<string, string | number | boolean>,
    context: string
  ): Promise<T> {
    await this.rateLimiter.waitForRateLimit();

    const response = await withRetry(
      async () => {
        const result = await axios.get<T & { error?: string }>(
          `${SCRAPECREATORS_BASE_URL}${path}`,
          {
            params: { ...params, trim: true },
            headers: this.headers,
            timeout: 30000,
          }
        );
        if (result.data.error) {
          throw new Error(`ScrapeCreators error: ${result.data.error}`);
        }
        return result;
      },
      {
        maxRetries: 3,
        context,
        isRetryableError: this.isRetryableError.bind(this),
      }
    );

    return response.data;
  }

  private buildShareUrl(aweme: TikTokAwemeInfo): string | null {
    if (aweme.share_url) return aweme.share_url;
    const awemeId = aweme.aweme_id;
    const handle = aweme.author?.unique_id;
    if (awemeId && handle) {
      return `https://www.tiktok.com/@${handle}/video/${awemeId}`;
    }
    return null;
  }

  private normalizeAweme(item: TikTokSearchItem): TikTokAwemeInfo | null {
    if (item.aweme_info?.aweme_id) return item.aweme_info;
    if (item.aweme_id) {
      return {
        aweme_id: item.aweme_id,
        desc: item.desc,
        share_url: item.share_url,
        create_time: item.create_time,
        author: item.author,
        statistics: item.statistics,
      };
    }
    return null;
  }

  private parseVideoCandidate(item: TikTokSearchItem): VideoCandidate | null {
    const aweme = this.normalizeAweme(item);
    if (!aweme?.aweme_id) return null;

    const shareUrl = this.buildShareUrl(aweme);
    if (!shareUrl) return null;

    const handle = aweme.author?.unique_id || 'unknown';
    const stats = aweme.statistics || {};

    return {
      aweme_id: aweme.aweme_id,
      desc: aweme.desc?.trim() || '',
      share_url: shareUrl,
      create_time: aweme.create_time ?? null,
      author_handle: handle,
      comment_count: stats.comment_count ?? 0,
      digg_count: stats.digg_count ?? 0,
    };
  }

  private async searchKeywordPage(
    query: string,
    cursor?: number
  ): Promise<{ videos: VideoCandidate[]; nextCursor?: number; hasMore: boolean }> {
    const params: Record<string, string | number | boolean> = {
      query,
      date_posted: 'last-3-months',
      sort_by: 'relevance',
    };
    if (cursor !== undefined) {
      params.cursor = cursor;
    }

    const data = await this.apiGet<TikTokSearchResponse>(
      '/v1/tiktok/search/keyword',
      params,
      `tiktok_search:${query}:${cursor ?? 0}`
    );

    const videos: VideoCandidate[] = [];
    for (const item of data.search_item_list || []) {
      const candidate = this.parseVideoCandidate(item);
      if (candidate) videos.push(candidate);
    }

    const hasMore = Boolean(data.has_more);
    return {
      videos,
      nextCursor: data.cursor,
      hasMore,
    };
  }

  private async fetchCommentsForVideo(
    shareUrl: string
  ): Promise<TikTokComment[]> {
    const allComments: TikTokComment[] = [];
    let cursor: number | undefined;
    const maxPages = RESEARCH_DEFAULTS.TIKTOK_COMMENT_PAGES_PER_VIDEO;

    for (let page = 0; page < maxPages; page++) {
      const params: Record<string, string | number | boolean> = { url: shareUrl };
      if (cursor !== undefined) {
        params.cursor = cursor;
      }

      const data = await this.apiGet<TikTokCommentsResponse>(
        '/v1/tiktok/video/comments',
        params,
        `tiktok_comments:${shareUrl}:${cursor ?? 0}`
      );

      const batch = data.comments || [];
      allComments.push(...batch);

      if (!data.has_more || batch.length === 0) break;
      cursor = data.cursor;
    }

    return allComments;
  }

  private buildRawText(caption: string, comments: TikTokComment[]): string {
    const minLen = RESEARCH_DEFAULTS.TIKTOK_MIN_COMMENT_TEXT_CHARS;
    const lines: string[] = [];

    if (caption) {
      lines.push(`Caption: ${caption}`);
      lines.push('');
    }

    const commentLines = comments
      .filter((c) => (c.text?.trim().length ?? 0) >= minLen)
      .map((c) => `- ${c.text!.trim()} (${c.digg_count ?? 0} likes)`);

    if (commentLines.length > 0) {
      lines.push('Comments:');
      lines.push(...commentLines);
    }

    return lines.join('\n');
  }

  private platformTimestamp(unixSeconds: number | null): string | null {
    if (unixSeconds == null) return null;
    return new Date(unixSeconds * 1000).toISOString();
  }

  private async videoToSource(video: VideoCandidate): Promise<RedditSource | null> {
    try {
      const comments = await this.fetchCommentsForVideo(video.share_url);
      const rawText = this.buildRawText(video.desc, comments);

      if (rawText.length < 100) {
        return null;
      }

      const engagement: QuoteEngagement = {
        score: video.digg_count,
        num_comments: video.comment_count,
        upvote_ratio: null,
      };

      return {
        source_id: video.aweme_id,
        source_url: video.share_url,
        created_at_platform: this.platformTimestamp(video.create_time),
        subreddit: `@${video.author_handle}`,
        engagement,
        raw_text: rawText,
        post_type: 'post',
      };
    } catch (error) {
      console.error(
        `Failed to fetch comments for video ${video.aweme_id}:`,
        error instanceof Error ? error.message : error
      );
      return null;
    }
  }

  /**
   * Search TikTok by keyword, pre-filter by comment count, fetch comments for top videos.
   */
  async searchForSources(
    query: string,
    _options: { limit?: number } = {}
  ): Promise<RedditSource[]> {
    const seenIds = new Set<string>();
    const candidates: VideoCandidate[] = [];
    let cursor: number | undefined;
    const maxPages = RESEARCH_DEFAULTS.TIKTOK_SEARCH_PAGES_PER_QUERY;

    for (let page = 0; page < maxPages; page++) {
      const result = await this.searchKeywordPage(query, cursor);

      for (const video of result.videos) {
        if (seenIds.has(video.aweme_id)) continue;
        seenIds.add(video.aweme_id);
        candidates.push(video);
      }

      if (!result.hasMore || result.videos.length === 0) break;
      cursor = result.nextCursor;
    }

    const qualifying = candidates
      .filter((v) => v.comment_count >= RESEARCH_DEFAULTS.TIKTOK_MIN_COMMENT_COUNT)
      .sort((a, b) => b.comment_count - a.comment_count)
      .slice(0, RESEARCH_DEFAULTS.TIKTOK_MAX_VIDEOS_PER_QUERY);

    const sources: RedditSource[] = [];

    for (const video of qualifying) {
      const source = await this.videoToSource(video);
      if (source) sources.push(source);
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
