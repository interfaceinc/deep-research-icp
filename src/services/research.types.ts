/**
 * Research Engine Type Definitions
 * Tables: research_projects, research_jobs, research_quotes
 */

import { z } from 'zod';

// =============================================================================
// Fixed Defaults (Hardcoded as per spec)
// =============================================================================

export const RESEARCH_DEFAULTS = {
  TIME_WINDOW_DAYS: 180,
  TARGET_PENDING: 1500,
  TARGET_KEPT: 1000,
  QC_MIN_SENTENCES: 1,
  // Google snippets run ~120-150 chars; keep the floor at extraction min.
  QC_MIN_CHARS: 100,
  GEMINI_MODEL: 'gemini-2.5-flash',
  GEMINI_CONCURRENCY: 1,
  // SerpAPI Google search settings
  SEARCH_CONCURRENCY: 3,
  SEARCH_PAGES_PER_QUERY: 3,
  // TikTok / ScrapeCreators settings (credit-conscious defaults)
  TIKTOK_SEARCH_PAGES_PER_QUERY: 2,
  TIKTOK_MAX_VIDEOS_PER_QUERY: 8,
  TIKTOK_MIN_COMMENT_COUNT: 15,
  TIKTOK_COMMENT_PAGES_PER_VIDEO: 2,
  TIKTOK_QC_MIN_CHARS: 80,
  TIKTOK_TARGET_PENDING: 150,
  TIKTOK_MIN_COMMENT_TEXT_CHARS: 30,
} as const;

export type ResearchPlatform = 'reddit' | 'tiktok';

// =============================================================================
// Enums (Fixed Sets for Gemini Structured Output)
// =============================================================================

export const DOMINANT_EMOTIONS = [
  'anger',
  'fear',
  'guilt',
  'shame',
  'grief',
  'urgency',
  'hope',
  'relief',
  'resignation',
  'pride',
  'mixed',
] as const;

export const JOURNEY_STAGES = ['shock', 'struggle', 'desperation'] as const;

export const REJECT_REASONS = [
  'not_first_person',
  'off_topic',
  'promotional',
  'too_short',
  'spam',
  'duplicate_content',
  'not_self_contained',
] as const;

export type DominantEmotion = (typeof DOMINANT_EMOTIONS)[number];
export type JourneyStage = (typeof JOURNEY_STAGES)[number];
export type RejectReason = (typeof REJECT_REASONS)[number];

export type ResearchJobStatus = 'queued' | 'running' | 'completed' | 'failed';
export type ResearchJobStep = 'queries' | 'search' | 'extract' | 'qc' | 'enrich';
export type QuoteStatus = 'pending' | 'kept' | 'rejected';

// =============================================================================
// Database Entity Types
// =============================================================================

export interface ResearchProject {
  id: string;
  user_id: string;
  client: string | null;
  theme: string;
  theme_definition: string | null;
  time_window_days: number;
  created_at: string;
  updated_at: string;
}

export interface ResearchJobCounters {
  pending_ingested: number;
  quotes_extracted: number;
  kept: number;
  rejected: number;
  enriched: number;
}

export interface ResearchJobConfig {
  search_queries: string[];
  platform?: ResearchPlatform;
}

export interface ResearchJob {
  id: string;
  project_id: string;
  status: ResearchJobStatus;
  current_step: ResearchJobStep | null;
  counters: ResearchJobCounters;
  config: ResearchJobConfig;
  last_error: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface QuoteEngagement {
  score: number;
  num_comments: number;
  upvote_ratio: number | null;
}

export interface ResearchQuote {
  id: string;
  project_id: string;
  job_id: string | null;

  // Source
  platform: string;
  source_id: string;
  source_url: string;
  created_at_platform: string | null;
  subreddit: string | null;
  engagement: QuoteEngagement | null;

  // Quote content
  quote_text: string;
  quote_text_hash: string;

  // QC
  status: QuoteStatus;
  reject_reason: RejectReason | null;
  qc_confidence: number | null;
  qc_model_name: string | null;
  qc_prompt_version: string | null;
  qc_raw: Record<string, unknown> | null;
  qc_at: string | null;

  // Enrichment
  dominant_emotion: DominantEmotion | null;
  journey_stage: JourneyStage | null;
  villain: string | null;
  breaking_point: boolean | null;
  breaking_point_description: string | null;
  specificity_score: number | null;
  quote_signal_score: number | null;
  confidence: number | null;
  model_name: string | null;
  prompt_version: string | null;
  llm_raw: Record<string, unknown> | null;
  enriched_at: string | null;

  created_at: string;
  updated_at: string;
}

// =============================================================================
// View Types (Read-only for Claude Desktop)
// =============================================================================

export interface DimensionCount {
  project_id: string;
  dimension_name: 'dominant_emotion' | 'journey_stage' | 'villain' | 'subreddit';
  dimension_value: string;
  count: number;
}

export interface TopQuote {
  id: string;
  theme: string;
  client: string | null;
  project_id: string;
  quote_text: string;
  source_url: string;
  subreddit: string | null;
  dominant_emotion: DominantEmotion | null;
  journey_stage: JourneyStage | null;
  villain: string | null;
  breaking_point: boolean | null;
  breaking_point_description: string | null;
  specificity_score: number | null;
  quote_signal_score: number | null;
  engagement: QuoteEngagement | null;
  created_at_platform: string | null;
}

// =============================================================================
// Reddit/ScrapeCreators Types
// =============================================================================

export interface RedditSource {
  source_id: string;
  source_url: string;
  created_at_platform: string | null;
  subreddit: string;
  engagement: QuoteEngagement;
  raw_text: string;
  post_type: 'post' | 'comment';
}

// =============================================================================
// Gemini Structured Output Schemas
// =============================================================================

// Stage 1: Query Generation
export const QueryGenerationSchema = z.object({
  search_queries: z.array(z.string().min(3).max(100)).min(5).max(15),
});
export type QueryGenerationResult = z.infer<typeof QueryGenerationSchema>;

// Stage 3: Quote Extraction
export const QuoteExtractionSchema = z.object({
  quotes: z.array(
    z.object({
      verbatim_text: z.string().min(100),
    })
  ),
});
export type QuoteExtractionResult = z.infer<typeof QuoteExtractionSchema>;

// Stage 4: Quality Control
export const QualityControlSchema = z.object({
  decision: z.enum(['keep', 'reject']),
  reject_reason: z.enum(REJECT_REASONS).nullable(),
  confidence: z.number().min(0).max(1),
});
export type QualityControlResult = z.infer<typeof QualityControlSchema>;

// Stage 5: Enrichment
export const EnrichmentSchema = z.object({
  dominant_emotion: z.enum(DOMINANT_EMOTIONS),
  journey_stage: z.enum(JOURNEY_STAGES),
  villain: z.string().max(200),
  breaking_point: z.boolean(),
  breaking_point_description: z.string().max(200).nullable(),
  specificity_score: z.number().int().min(0).max(100),
  quote_signal_score: z.number().min(0).max(1),
});
export type EnrichmentResult = z.infer<typeof EnrichmentSchema>;

// =============================================================================
// CLI Input Types
// =============================================================================

export interface ResearchRunInput {
  theme: string;
  theme_definition?: string;
  client?: string;
  queries: string[]; // REQUIRED - Claude always provides search queries
  platform?: ResearchPlatform;
}

export function getPlatformDefaults(platform: ResearchPlatform = 'reddit') {
  if (platform === 'tiktok') {
    return {
      targetPending: RESEARCH_DEFAULTS.TIKTOK_TARGET_PENDING,
      qcMinChars: RESEARCH_DEFAULTS.TIKTOK_QC_MIN_CHARS,
    };
  }
  return {
    targetPending: RESEARCH_DEFAULTS.TARGET_PENDING,
    qcMinChars: RESEARCH_DEFAULTS.QC_MIN_CHARS,
  };
}

// =============================================================================
// Pipeline Result Types
// =============================================================================

export interface PipelineResult {
  success: boolean;
  projectId: string;
  jobId: string;
  stats: ResearchJobCounters;
  duration: number;
  error?: string;
}

// =============================================================================
// Event Types (for progress tracking)
// =============================================================================

export type ResearchStage = 'queries' | 'search' | 'extract' | 'qc' | 'enrich';

export interface ResearchEventBase {
  jobId: string;
  projectId: string;
  timestamp: string;
}

export interface ResearchStartedEvent extends ResearchEventBase {
  type: 'research:started';
  theme: string;
  platform: ResearchPlatform;
}

export interface ResearchStageStartedEvent extends ResearchEventBase {
  type: 'research:stage_started';
  stage: ResearchStage;
  message: string;
}

export interface ResearchStageProgressEvent extends ResearchEventBase {
  type: 'research:stage_progress';
  stage: ResearchStage;
  processed: number;
  total: number;
  percentage: number;
  message?: string;
}

export interface ResearchStageCompletedEvent extends ResearchEventBase {
  type: 'research:stage_completed';
  stage: ResearchStage;
  stats: Partial<ResearchJobCounters>;
  message?: string;
}

export interface ResearchLogEvent extends ResearchEventBase {
  type: 'research:log';
  message: string;
  level: 'info' | 'warn' | 'error';
}

export interface ResearchCompletedEvent extends ResearchEventBase {
  type: 'research:completed';
  stats: ResearchJobCounters;
  message?: string;
}

export interface ResearchErrorEvent extends ResearchEventBase {
  type: 'research:error';
  error: string;
  stats?: Partial<ResearchJobCounters>;
}

export type ResearchEvent =
  | ResearchStartedEvent
  | ResearchStageStartedEvent
  | ResearchStageProgressEvent
  | ResearchStageCompletedEvent
  | ResearchLogEvent
  | ResearchCompletedEvent
  | ResearchErrorEvent;
