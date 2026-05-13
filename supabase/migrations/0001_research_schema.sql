-- Reddit Research Toolkit — initial schema
-- Run this in your Supabase project (Dashboard → SQL Editor → New Query → paste → Run)
-- or via the Supabase CLI: `supabase db push`

-- =====================================================================
-- research_projects
-- =====================================================================
CREATE TABLE research_projects (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL,
  client            text,
  theme             text NOT NULL,
  theme_definition  text,
  time_window_days  integer NOT NULL DEFAULT 180,
  created_at        timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now()
);

CREATE INDEX idx_research_projects_user_id    ON research_projects (user_id);
CREATE INDEX idx_research_projects_created_at ON research_projects (created_at DESC);

-- =====================================================================
-- research_jobs
-- =====================================================================
CREATE TABLE research_jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  status        text NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  current_step  text
                  CHECK (current_step IN ('queries', 'search', 'extract', 'qc', 'enrich')),
  counters      jsonb NOT NULL DEFAULT
                  '{"kept": 0, "enriched": 0, "rejected": 0, "pending_ingested": 0, "quotes_extracted": 0}'::jsonb,
  config        jsonb NOT NULL DEFAULT '{"search_queries": []}'::jsonb,
  last_error    text,
  started_at    timestamptz,
  completed_at  timestamptz,
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now()
);

CREATE INDEX idx_research_jobs_project_id ON research_jobs (project_id);
CREATE INDEX idx_research_jobs_status     ON research_jobs (status);
CREATE INDEX idx_research_jobs_created_at ON research_jobs (created_at DESC);

-- =====================================================================
-- research_quotes
-- =====================================================================
CREATE TABLE research_quotes (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id                  uuid NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  job_id                      uuid REFERENCES research_jobs(id) ON DELETE SET NULL,

  -- Source
  platform                    text NOT NULL DEFAULT 'reddit',
  source_id                   text NOT NULL,
  source_url                  text NOT NULL,
  created_at_platform         timestamptz,
  subreddit                   text,
  engagement                  jsonb DEFAULT
                                '{"score": 0, "num_comments": 0, "upvote_ratio": null}'::jsonb,

  -- Quote
  quote_text                  text NOT NULL,
  quote_text_hash             text NOT NULL,

  -- QC
  status                      text NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'kept', 'rejected')),
  reject_reason               text
                                CHECK (reject_reason IN (
                                  'not_first_person','off_topic','promotional',
                                  'too_short','spam','duplicate_content','not_self_contained'
                                )),
  qc_confidence               numeric,
  qc_model_name               text,
  qc_prompt_version           text,
  qc_raw                      jsonb,
  qc_at                       timestamptz,

  -- Enrichment
  dominant_emotion            text
                                CHECK (dominant_emotion IN (
                                  'anger','fear','guilt','shame','grief',
                                  'urgency','hope','relief','resignation','pride','mixed'
                                )),
  journey_stage               text
                                CHECK (journey_stage IN ('shock','struggle','desperation')),
  villain                     text,
  breaking_point              boolean,
  breaking_point_description  text,
  specificity_score           integer
                                CHECK (specificity_score >= 0 AND specificity_score <= 100),
  quote_signal_score          numeric
                                CHECK (quote_signal_score >= 0 AND quote_signal_score <= 1),
  confidence                  numeric,
  model_name                  text,
  prompt_version              text,
  llm_raw                     jsonb,
  enriched_at                 timestamptz,

  created_at                  timestamptz DEFAULT now(),
  updated_at                  timestamptz DEFAULT now(),

  CONSTRAINT uq_research_quotes_platform_source_hash
    UNIQUE (platform, source_id, quote_text_hash)
);

CREATE INDEX idx_research_quotes_project_id        ON research_quotes (project_id);
CREATE INDEX idx_research_quotes_job_id            ON research_quotes (job_id);
CREATE INDEX idx_research_quotes_status            ON research_quotes (status);
CREATE INDEX idx_research_quotes_subreddit         ON research_quotes (subreddit);
CREATE INDEX idx_research_quotes_dominant_emotion  ON research_quotes (dominant_emotion)
  WHERE status = 'kept';
CREATE INDEX idx_research_quotes_journey_stage     ON research_quotes (journey_stage)
  WHERE status = 'kept';
CREATE INDEX idx_research_quotes_specificity_score ON research_quotes (specificity_score DESC NULLS LAST)
  WHERE status = 'kept';
CREATE INDEX idx_research_quotes_signal_score      ON research_quotes (quote_signal_score DESC NULLS LAST)
  WHERE status = 'kept';

-- =====================================================================
-- Views: pattern analysis
-- =====================================================================
CREATE VIEW v_research_dimension_counts AS
  SELECT project_id, 'dominant_emotion'::text AS dimension_name,
         dominant_emotion AS dimension_value, COUNT(*) AS count
  FROM research_quotes
  WHERE status = 'kept' AND dominant_emotion IS NOT NULL
  GROUP BY project_id, dominant_emotion

  UNION ALL

  SELECT project_id, 'journey_stage'::text, journey_stage, COUNT(*)
  FROM research_quotes
  WHERE status = 'kept' AND journey_stage IS NOT NULL
  GROUP BY project_id, journey_stage

  UNION ALL

  SELECT project_id, 'villain'::text, villain, COUNT(*)
  FROM research_quotes
  WHERE status = 'kept' AND villain IS NOT NULL AND villain <> 'none'
  GROUP BY project_id, villain

  UNION ALL

  SELECT project_id, 'subreddit'::text, subreddit, COUNT(*)
  FROM research_quotes
  WHERE status = 'kept' AND subreddit IS NOT NULL
  GROUP BY project_id, subreddit

  ORDER BY 1, 2, 4 DESC;

CREATE VIEW v_research_top_quotes AS
  SELECT
    rq.id,
    rp.theme,
    rp.client,
    rq.project_id,
    rq.quote_text,
    rq.source_url,
    rq.subreddit,
    rq.dominant_emotion,
    rq.journey_stage,
    rq.villain,
    rq.breaking_point,
    rq.breaking_point_description,
    rq.specificity_score,
    rq.quote_signal_score,
    rq.engagement,
    rq.created_at_platform
  FROM research_quotes rq
  JOIN research_projects rp ON rp.id = rq.project_id
  WHERE rq.status = 'kept'
  ORDER BY rq.specificity_score DESC NULLS LAST,
           rq.quote_signal_score DESC NULLS LAST;
