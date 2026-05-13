/**
 * Research Orchestrator Service (V2 - Claude-Controlled Queries)
 * Main pipeline coordinator that runs 4 stages:
 * Stage 2: Reddit Search → Stage 3: Quote Extraction → Stage 4: QC → Stage 5: Enrichment
 * Note: Stage 1 (Query Generation) removed - queries now provided externally by Claude
 */

import crypto from 'crypto';
import { supabase } from '../config/supabase.js';
import { GeminiResearchService } from './gemini-research.service.js';
import { ScrapeCreatorsService } from './scrape-creators.service.js';
import { researchEvents } from './research-events.service.js';
import {
  RESEARCH_DEFAULTS,
  type ResearchRunInput,
  type ResearchProject,
  type ResearchJob,
  type ResearchQuote,
  type RedditSource,
  type PipelineResult,
  type ResearchJobCounters,
} from './research.types.js';

export class ResearchOrchestratorService {
  private gemini: GeminiResearchService;
  private scrapeCreators: ScrapeCreatorsService;

  constructor() {
    this.gemini = new GeminiResearchService();
    this.scrapeCreators = new ScrapeCreatorsService();
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
    let project: ResearchProject | null = null;
    let job: ResearchJob | null = null;

    // Temporary storage for sources between stages
    let tempSources: RedditSource[] = [];

    try {
      // 1. Create project
      const { data: projectData, error: projectError } = await supabase
        .from('research_projects')
        .insert({
          user_id: userId,
          theme: input.theme,
          theme_definition: input.theme_definition || null,
          client: input.client || null,
          time_window_days: RESEARCH_DEFAULTS.TIME_WINDOW_DAYS,
        })
        .select()
        .single();

      if (projectError) {
        throw new Error(`Failed to create project: ${projectError.message}`);
      }
      project = projectData as ResearchProject;

      // 2. Create job with provided queries (Claude always provides these)
      const { data: jobData, error: jobError } = await supabase
        .from('research_jobs')
        .insert({
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
          config: { search_queries: input.queries }, // Use provided queries
          started_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (jobError) {
        throw new Error(`Failed to create job: ${jobError.message}`);
      }
      job = jobData as ResearchJob;

      researchEvents.emitResearchStarted(job.id, project.id, input.theme);
      researchEvents.emitResearchLog(
        job.id,
        project.id,
        `Starting research for theme: "${input.theme}" with ${input.queries.length} queries`
      );

      // Stage 2: Reddit search (queries already in job config)
      tempSources = await this.runStage2_RedditSearch(project, job);

      // Stage 3: Quote extraction
      await this.runStage3_QuoteExtraction(project, job, input, tempSources);

      // Stage 4: Quality control
      await this.runStage4_QualityControl(project, job, input);

      // Stage 5: Enrichment
      await this.runStage5_Enrichment(project, job);

      // Mark job completed
      const finalCounters = await this.getJobCounters(project.id);
      await supabase
        .from('research_jobs')
        .update({
          status: 'completed',
          counters: finalCounters,
          completed_at: new Date().toISOString(),
        })
        .eq('id', job.id);

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
        const counters = await this.getJobCounters(project.id);
        await supabase
          .from('research_jobs')
          .update({
            status: 'failed',
            last_error: error instanceof Error ? error.message : String(error),
            counters,
          })
          .eq('id', job.id);

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
   * Stage 2: Reddit search ingestion
   * (Stage 1 removed - queries now provided externally by Claude)
   */
  private async runStage2_RedditSearch(
    project: ResearchProject,
    job: ResearchJob
  ): Promise<RedditSource[]> {
    researchEvents.emitStageStarted(
      job.id,
      project.id,
      'search',
      'Searching Reddit via ScrapeCreators...'
    );

    // Get queries from job config
    const { data: jobData } = await supabase
      .from('research_jobs')
      .select('config')
      .eq('id', job.id)
      .single();

    const queries: string[] = (jobData?.config as { search_queries?: string[] })?.search_queries || [];
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
        const sources = await this.scrapeCreators.searchForSources(query);

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
      if (allSources.length >= RESEARCH_DEFAULTS.TARGET_PENDING) {
        researchEvents.emitResearchLog(
          job.id,
          project.id,
          `Reached target_pending (${RESEARCH_DEFAULTS.TARGET_PENDING}), stopping search`
        );
        break;
      }
    }

    // Update job counters
    await supabase
      .from('research_jobs')
      .update({
        current_step: 'extract',
        counters: {
          pending_ingested: allSources.length,
          quotes_extracted: 0,
          kept: 0,
          rejected: 0,
          enriched: 0,
        },
      })
      .eq('id', job.id);

    researchEvents.emitResearchLog(
      job.id,
      project.id,
      `Ingested ${allSources.length} unique Reddit sources`
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
    sources: RedditSource[]
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
          if (q.verbatim_text.length < RESEARCH_DEFAULTS.QC_MIN_CHARS) {
            continue;
          }

          const hash = this.hashQuote(q.verbatim_text);

          const { error } = await supabase.from('research_quotes').upsert(
            {
              project_id: project.id,
              job_id: job.id,
              platform: 'reddit',
              source_id: source.source_id,
              source_url: source.source_url,
              created_at_platform: source.created_at_platform,
              subreddit: source.subreddit,
              engagement: source.engagement,
              quote_text: q.verbatim_text,
              quote_text_hash: hash,
              status: 'pending',
            },
            {
              onConflict: 'platform,source_id,quote_text_hash',
              ignoreDuplicates: true,
            }
          );

          if (!error) {
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

    await supabase
      .from('research_jobs')
      .update({ current_step: 'qc' })
      .eq('id', job.id);

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
    const { data: pendingQuotes, error } = await supabase
      .from('research_quotes')
      .select('*')
      .eq('project_id', project.id)
      .eq('status', 'pending')
      .order('engagement->score', { ascending: false });

    if (error) {
      throw new Error(`Failed to fetch quotes: ${error.message}`);
    }

    let keptCount = 0;
    let rejectedCount = 0;
    let processedCount = 0;

    for (const quote of pendingQuotes || []) {
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

        const updateData: Partial<ResearchQuote> = {
          status: result.decision === 'keep' ? 'kept' : 'rejected',
          reject_reason: result.reject_reason,
          qc_confidence: result.confidence,
          qc_model_name: this.gemini.getModelName(),
          qc_prompt_version: this.gemini.getPromptVersion('QUALITY_CONTROL'),
          qc_raw: raw as Record<string, unknown>,
          qc_at: new Date().toISOString(),
        };

        await supabase
          .from('research_quotes')
          .update(updateData)
          .eq('id', quote.id);

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

    await supabase
      .from('research_jobs')
      .update({ current_step: 'enrich' })
      .eq('id', job.id);

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
    const { data: keptQuotes, error } = await supabase
      .from('research_quotes')
      .select('*')
      .eq('project_id', project.id)
      .eq('status', 'kept')
      .is('enriched_at', null);

    if (error) {
      throw new Error(`Failed to fetch kept quotes: ${error.message}`);
    }

    let enrichedCount = 0;

    for (const quote of keptQuotes || []) {
      try {
        const { result, raw } = await this.gemini.enrichQuote(quote.quote_text);

        const updateData: Partial<ResearchQuote> = {
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
        };

        await supabase
          .from('research_quotes')
          .update(updateData)
          .eq('id', quote.id);

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
          keptQuotes?.length || 0,
          Math.round((enrichedCount / (keptQuotes?.length || 1)) * 100),
          `Enriched ${enrichedCount} of ${keptQuotes?.length}`
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

  /**
   * Get current job counters from database
   */
  private async getJobCounters(projectId: string): Promise<ResearchJobCounters> {
    const { data: quotes } = await supabase
      .from('research_quotes')
      .select('status, enriched_at')
      .eq('project_id', projectId);

    if (!quotes) {
      return {
        pending_ingested: 0,
        quotes_extracted: 0,
        kept: 0,
        rejected: 0,
        enriched: 0,
      };
    }

    return {
      pending_ingested: quotes.length,
      quotes_extracted: quotes.length,
      kept: quotes.filter((q) => q.status === 'kept').length,
      rejected: quotes.filter((q) => q.status === 'rejected').length,
      enriched: quotes.filter((q) => q.enriched_at).length,
    };
  }
}
