/**
 * Research Orchestrator Service (V2 - Claude-Controlled Queries)
 * Main pipeline coordinator that runs 4 stages:
 * Stage 2: Reddit Search → Stage 3: Quote Extraction → Stage 4: QC → Stage 5: Enrichment
 * Note: Stage 1 (Query Generation) removed - queries now provided externally by Claude
 *
 * Storage: local SQLite (see src/config/db.ts). Reddit search: SerpAPI (Google).
 */

import crypto from 'crypto';
import * as db from '../config/db.js';
import { GeminiResearchService } from './gemini-research.service.js';
import { SerpApiRedditService } from './serpapi.service.js';
import { ScrapeCreatorsTikTokService } from './scrapecreators-tiktok.service.js';
import { researchEvents } from './research-events.service.js';
import {
  RESEARCH_DEFAULTS,
  getPlatformDefaults,
  type ResearchRunInput,
  type ResearchProject,
  type ResearchJob,
  type RedditSource,
  type PipelineResult,
  type ResearchPlatform,
} from './research.types.js';

interface SearchService {
  searchForSources(query: string): Promise<RedditSource[]>;
}

export class ResearchOrchestratorService {
  private gemini: GeminiResearchService;

  constructor() {
    this.gemini = new GeminiResearchService();
  }

  private createSearchService(platform: ResearchPlatform): SearchService {
    if (platform === 'tiktok') {
      return new ScrapeCreatorsTikTokService();
    }
    return new SerpApiRedditService();
  }

  /**
   * Generate deterministic hash for quote deduplication
   */
  private hashQuote(text: string): string {
    return crypto
      .createHash('sha256')
      .update(text.toLowerCase().trim())
      .digest('hex')
      .slice(0, 16);
  }

  /**
   * Main pipeline entry point
   */
  async runPipeline(input: ResearchRunInput, userId: string): Promise<PipelineResult> {
    const startTime = Date.now();
    const platform: ResearchPlatform = input.platform ?? 'reddit';
    const platformDefaults = getPlatformDefaults(platform);
    const search = this.createSearchService(platform);
    let project: ResearchProject | null = null;
    let job: ResearchJob | null = null;

    // Temporary storage for sources between stages
    let tempSources: RedditSource[] = [];

    try {
      // 1. Create project
      project = db.createProject({
        user_id: userId,
        theme: input.theme,
        theme_definition: input.theme_definition || null,
        client: input.client || null,
        time_window_days: RESEARCH_DEFAULTS.TIME_WINDOW_DAYS,
      });

      // 2. Create job with provided queries (Claude always provides these)
      job = db.createJob({
        project_id: project.id,
        status: 'running',
        current_step: 'search', // Start directly at search (queries provided externally)
        counters: {
          pending_ingested: 0,
          quotes_extracted: 0,
          kept: 0,
          rejected: 0,
          enriched: 0,
        },
        config: { search_queries: input.queries, platform },
        started_at: new Date().toISOString(),
      });

      researchEvents.emitResearchStarted(job.id, project.id, input.theme, platform);
      researchEvents.emitResearchLog(
        job.id,
        project.id,
        `Starting research for theme: "${input.theme}" on ${platform} with ${input.queries.length} queries`
      );

      // Stage 2: Platform search (queries already in job config)
      tempSources = await this.runStage2_Search(
        project,
        job,
        search,
        platform,
        platformDefaults.targetPending
      );

      // Stage 3: Quote extraction
      await this.runStage3_QuoteExtraction(
        project,
        job,
        input,
        tempSources,
        platform,
        platformDefaults.qcMinChars
      );

      // Stage 4: Quality control
      await this.runStage4_QualityControl(project, job, input);

      // Stage 5: Enrichment
      await this.runStage5_Enrichment(project, job);

      // Mark job completed
      const finalCounters = db.getJobCounters(project.id);
      db.updateJob(job.id, {
        status: 'completed',
        counters: finalCounters,
        completed_at: new Date().toISOString(),
      });

      researchEvents.emitResearchCompleted(
        job.id,
        project.id,
        finalCounters,
        'Pipeline completed successfully'
      );

      return {
        success: true,
        projectId: project.id,
        jobId: job.id,
        stats: finalCounters,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      console.error('Pipeline failed:', error);

      if (job && project) {
        const counters = db.getJobCounters(project.id);
        db.updateJob(job.id, {
          status: 'failed',
          last_error: error instanceof Error ? error.message : String(error),
          counters,
        });

        researchEvents.emitResearchError(
          job.id,
          project.id,
          error instanceof Error ? error.message : String(error),
          counters
        );
      }

      return {
        success: false,
        projectId: project?.id || '',
        jobId: job?.id || '',
        stats: {
          pending_ingested: 0,
          quotes_extracted: 0,
          kept: 0,
          rejected: 0,
          enriched: 0,
        },
        duration: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Stage 2: Platform search ingestion
   */
  private async runStage2_Search(
    project: ResearchProject,
    job: ResearchJob,
    search: SearchService,
    platform: ResearchPlatform,
    targetPending: number
  ): Promise<RedditSource[]> {
    const platformLabel = platform === 'tiktok' ? 'TikTok via ScrapeCreators' : 'Reddit via SerpAPI (Google)';
    researchEvents.emitStageStarted(
      job.id,
      project.id,
      'search',
      `Searching ${platformLabel}...`
    );

    // Get queries from job config
    const queries: string[] = db.getJobConfig(job.id).search_queries || [];
    const allSources: RedditSource[] = [];
    const seenSourceIds = new Set<string>();

    for (let i = 0; i < queries.length; i++) {
      const query = queries[i];

      researchEvents.emitStageProgress(
        job.id,
        project.id,
        'search',
        i + 1,
        queries.length,
        Math.round(((i + 1) / queries.length) * 100),
        `Searching: "${query}"`
      );

      try {
        const sources = await search.searchForSources(query);

        // Dedupe by source_id
        for (const source of sources) {
          if (!seenSourceIds.has(source.source_id)) {
            seenSourceIds.add(source.source_id);
            allSources.push(source);
          }
        }
      } catch (error) {
        researchEvents.emitResearchLog(
          job.id,
          project.id,
          `Warning: Failed to search "${query}": ${error instanceof Error ? error.message : String(error)}`,
          'warn'
        );
      }

      // Check if we've reached target_pending
      if (allSources.length >= targetPending) {
        researchEvents.emitResearchLog(
          job.id,
          project.id,
          `Reached target_pending (${targetPending}), stopping search`
        );
        break;
      }
    }

    // Update job counters
    db.updateJob(job.id, {
      current_step: 'extract',
      counters: {
        pending_ingested: allSources.length,
        quotes_extracted: 0,
        kept: 0,
        rejected: 0,
        enriched: 0,
      },
    });

    researchEvents.emitResearchLog(
      job.id,
      project.id,
      `Ingested ${allSources.length} unique ${platform} sources`
    );
    researchEvents.emitStageCompleted(
      job.id,
      project.id,
      'search',
      { pending_ingested: allSources.length },
      `Ingested ${allSources.length} sources`
    );

    return allSources;
  }

  /**
   * Stage 3: Quote extraction
   */
  private async runStage3_QuoteExtraction(
    project: ResearchProject,
    job: ResearchJob,
    input: ResearchRunInput,
    sources: RedditSource[],
    platform: ResearchPlatform,
    qcMinChars: number
  ): Promise<void> {
    researchEvents.emitStageStarted(
      job.id,
      project.id,
      'extract',
      'Extracting quotes from sources...'
    );

    let extractedCount = 0;
    let processedCount = 0;

    for (const source of sources) {
      processedCount++;

      // Skip very short texts
      if (source.raw_text.length < 100) {
        continue;
      }

      try {
        const { quotes } = await this.gemini.extractQuotes(
          source.raw_text,
          input.theme,
          input.theme_definition
        );

        // Insert quotes into database
        for (const q of quotes) {
          if (q.verbatim_text.length < qcMinChars) {
            continue;
          }

          const hash = this.hashQuote(q.verbatim_text);

          const inserted = db.insertQuote({
            project_id: project.id,
            job_id: job.id,
            platform,
            source_id: source.source_id,
            source_url: source.source_url,
            created_at_platform: source.created_at_platform,
            subreddit: source.subreddit,
            engagement: source.engagement,
            quote_text: q.verbatim_text,
            quote_text_hash: hash,
            status: 'pending',
          });

          if (inserted) {
            extractedCount++;
          }
        }
      } catch (error) {
        researchEvents.emitResearchLog(
          job.id,
          project.id,
          `Warning: Failed to extract from source ${source.source_id}: ${error instanceof Error ? error.message : String(error)}`,
          'warn'
        );
      }

      // Progress update every 10 sources
      if (processedCount % 10 === 0) {
        researchEvents.emitStageProgress(
          job.id,
          project.id,
          'extract',
          processedCount,
          sources.length,
          Math.round((processedCount / sources.length) * 100),
          `Extracted ${extractedCount} quotes from ${processedCount} sources`
        );
      }
    }

    db.updateJob(job.id, { current_step: 'qc' });

    researchEvents.emitResearchLog(
      job.id,
      project.id,
      `Extracted ${extractedCount} quote candidates from ${sources.length} sources`
    );
    researchEvents.emitStageCompleted(
      job.id,
      project.id,
      'extract',
      { quotes_extracted: extractedCount },
      `Extracted ${extractedCount} quotes`
    );
  }

  /**
   * Stage 4: Quality Control
   */
  private async runStage4_QualityControl(
    project: ResearchProject,
    job: ResearchJob,
    input: ResearchRunInput
  ): Promise<void> {
    researchEvents.emitStageStarted(
      job.id,
      project.id,
      'qc',
      'Running quality control on quotes...'
    );

    // Get pending quotes ordered by engagement score (highest first)
    const pendingQuotes = db.getPendingQuotesByEngagement(project.id);

    let keptCount = 0;
    let rejectedCount = 0;
    let processedCount = 0;

    for (const quote of pendingQuotes) {
      // Stop when we've reached target_kept
      if (keptCount >= RESEARCH_DEFAULTS.TARGET_KEPT) {
        researchEvents.emitResearchLog(
          job.id,
          project.id,
          `Reached target_kept (${RESEARCH_DEFAULTS.TARGET_KEPT}), stopping QC`
        );
        break;
      }

      try {
        const { result, raw } = await this.gemini.qualityControlQuote(
          quote.quote_text,
          input.theme,
          input.theme_definition
        );

        db.updateQuoteQC(quote.id, {
          status: result.decision === 'keep' ? 'kept' : 'rejected',
          reject_reason: result.reject_reason,
          qc_confidence: result.confidence,
          qc_model_name: this.gemini.getModelName(),
          qc_prompt_version: this.gemini.getPromptVersion('QUALITY_CONTROL'),
          qc_raw: raw as Record<string, unknown>,
          qc_at: new Date().toISOString(),
        });

        if (result.decision === 'keep') {
          keptCount++;
        } else {
          rejectedCount++;
        }
      } catch (error) {
        researchEvents.emitResearchLog(
          job.id,
          project.id,
          `Warning: QC failed for quote ${quote.id}: ${error instanceof Error ? error.message : String(error)}`,
          'warn'
        );
      }

      processedCount++;

      // Progress update every 25 quotes
      if (processedCount % 25 === 0) {
        researchEvents.emitStageProgress(
          job.id,
          project.id,
          'qc',
          keptCount,
          RESEARCH_DEFAULTS.TARGET_KEPT,
          Math.round((keptCount / RESEARCH_DEFAULTS.TARGET_KEPT) * 100),
          `Kept: ${keptCount}, Rejected: ${rejectedCount}`
        );
      }
    }

    db.updateJob(job.id, { current_step: 'enrich' });

    researchEvents.emitResearchLog(
      job.id,
      project.id,
      `QC complete: ${keptCount} kept, ${rejectedCount} rejected`
    );
    researchEvents.emitStageCompleted(
      job.id,
      project.id,
      'qc',
      { kept: keptCount, rejected: rejectedCount },
      `QC: ${keptCount} kept, ${rejectedCount} rejected`
    );
  }

  /**
   * Stage 5: Enrichment
   */
  private async runStage5_Enrichment(
    project: ResearchProject,
    job: ResearchJob
  ): Promise<void> {
    researchEvents.emitStageStarted(
      job.id,
      project.id,
      'enrich',
      'Enriching kept quotes with analytical dimensions...'
    );

    // Get all kept quotes that haven't been enriched
    const keptQuotes = db.getKeptQuotesNotEnriched(project.id);

    let enrichedCount = 0;

    for (const quote of keptQuotes) {
      try {
        const { result, raw } = await this.gemini.enrichQuote(quote.quote_text);

        db.updateQuoteEnrichment(quote.id, {
          dominant_emotion: result.dominant_emotion,
          journey_stage: result.journey_stage,
          villain: result.villain,
          breaking_point: result.breaking_point,
          breaking_point_description: result.breaking_point_description,
          specificity_score: result.specificity_score,
          quote_signal_score: result.quote_signal_score,
          model_name: this.gemini.getModelName(),
          prompt_version: this.gemini.getPromptVersion('ENRICHMENT'),
          llm_raw: raw as Record<string, unknown>,
          enriched_at: new Date().toISOString(),
        });

        enrichedCount++;
      } catch (error) {
        researchEvents.emitResearchLog(
          job.id,
          project.id,
          `Warning: Enrichment failed for quote ${quote.id}: ${error instanceof Error ? error.message : String(error)}`,
          'warn'
        );
      }

      // Progress update every 20 quotes
      if (enrichedCount % 20 === 0) {
        researchEvents.emitStageProgress(
          job.id,
          project.id,
          'enrich',
          enrichedCount,
          keptQuotes.length,
          Math.round((enrichedCount / (keptQuotes.length || 1)) * 100),
          `Enriched ${enrichedCount} of ${keptQuotes.length}`
        );
      }
    }

    researchEvents.emitResearchLog(
      job.id,
      project.id,
      `Enriched ${enrichedCount} quotes`
    );
    researchEvents.emitStageCompleted(
      job.id,
      project.id,
      'enrich',
      { enriched: enrichedCount },
      `Enriched ${enrichedCount} quotes`
    );
  }
}
