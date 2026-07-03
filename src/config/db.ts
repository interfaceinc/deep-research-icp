/**
 * Local SQLite storage (replaces Supabase).
 * Uses Node's built-in node:sqlite — zero external dependencies.
 */

import { DatabaseSync } from 'node:sqlite';
import crypto from 'crypto';
import { env } from './env.js';
import type {
  ResearchProject,
  ResearchJob,
  ResearchQuote,
  ResearchJobCounters,
  ResearchJobConfig,
  QuoteEngagement,
  ResearchPlatform,
} from '../services/research.types.js';

const db = new DatabaseSync(env.RESEARCH_DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS research_projects (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    client TEXT,
    theme TEXT NOT NULL,
    theme_definition TEXT,
    time_window_days INTEGER NOT NULL DEFAULT 180,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS research_jobs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    status TEXT NOT NULL,
    current_step TEXT,
    counters TEXT NOT NULL,
    config TEXT NOT NULL,
    last_error TEXT,
    started_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS research_quotes (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    job_id TEXT,
    platform TEXT NOT NULL,
    source_id TEXT NOT NULL,
    source_url TEXT NOT NULL,
    created_at_platform TEXT,
    subreddit TEXT,
    engagement TEXT,
    engagement_score INTEGER DEFAULT 0,
    quote_text TEXT NOT NULL,
    quote_text_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    reject_reason TEXT,
    qc_confidence REAL,
    qc_model_name TEXT,
    qc_prompt_version TEXT,
    qc_raw TEXT,
    qc_at TEXT,
    dominant_emotion TEXT,
    journey_stage TEXT,
    villain TEXT,
    breaking_point INTEGER,
    breaking_point_description TEXT,
    specificity_score INTEGER,
    quote_signal_score REAL,
    confidence REAL,
    model_name TEXT,
    prompt_version TEXT,
    llm_raw TEXT,
    enriched_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (platform, source_id, quote_text_hash)
  );

  CREATE INDEX IF NOT EXISTS idx_quotes_project ON research_quotes (project_id);
  CREATE INDEX IF NOT EXISTS idx_quotes_status ON research_quotes (project_id, status);
`);

const now = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export function createProject(input: {
  user_id: string;
  theme: string;
  theme_definition: string | null;
  client: string | null;
  time_window_days: number;
}): ResearchProject {
  const id = crypto.randomUUID();
  const ts = now();
  db.prepare(
    `INSERT INTO research_projects
       (id, user_id, client, theme, theme_definition, time_window_days, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.user_id,
    input.client,
    input.theme,
    input.theme_definition,
    input.time_window_days,
    ts,
    ts
  );
  return {
    id,
    user_id: input.user_id,
    client: input.client,
    theme: input.theme,
    theme_definition: input.theme_definition,
    time_window_days: input.time_window_days,
    created_at: ts,
    updated_at: ts,
  };
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export function createJob(input: {
  project_id: string;
  status: ResearchJob['status'];
  current_step: ResearchJob['current_step'];
  counters: ResearchJobCounters;
  config: ResearchJobConfig;
  started_at: string;
}): ResearchJob {
  const id = crypto.randomUUID();
  const ts = now();
  db.prepare(
    `INSERT INTO research_jobs
       (id, project_id, status, current_step, counters, config, last_error, started_at, completed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?)`
  ).run(
    id,
    input.project_id,
    input.status,
    input.current_step,
    JSON.stringify(input.counters),
    JSON.stringify(input.config),
    input.started_at,
    ts,
    ts
  );
  return {
    id,
    project_id: input.project_id,
    status: input.status,
    current_step: input.current_step,
    counters: input.counters,
    config: input.config,
    last_error: null,
    started_at: input.started_at,
    completed_at: null,
    created_at: ts,
    updated_at: ts,
  };
}

export function updateJob(
  id: string,
  patch: Partial<{
    status: ResearchJob['status'];
    current_step: ResearchJob['current_step'];
    counters: ResearchJobCounters;
    last_error: string | null;
    completed_at: string | null;
  }>
): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.status !== undefined) {
    sets.push('status = ?');
    values.push(patch.status);
  }
  if (patch.current_step !== undefined) {
    sets.push('current_step = ?');
    values.push(patch.current_step);
  }
  if (patch.counters !== undefined) {
    sets.push('counters = ?');
    values.push(JSON.stringify(patch.counters));
  }
  if (patch.last_error !== undefined) {
    sets.push('last_error = ?');
    values.push(patch.last_error);
  }
  if (patch.completed_at !== undefined) {
    sets.push('completed_at = ?');
    values.push(patch.completed_at);
  }
  sets.push('updated_at = ?');
  values.push(now());
  values.push(id);
  db.prepare(`UPDATE research_jobs SET ${sets.join(', ')} WHERE id = ?`).run(
    ...(values as (string | number | null)[])
  );
}

export function getJobConfig(id: string): ResearchJobConfig {
  const row = db.prepare('SELECT config FROM research_jobs WHERE id = ?').get(id) as
    | { config: string }
    | undefined;
  if (!row) return { search_queries: [] };
  return JSON.parse(row.config) as ResearchJobConfig;
}

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

export function insertQuote(input: {
  project_id: string;
  job_id: string;
  platform: string;
  source_id: string;
  source_url: string;
  created_at_platform: string | null;
  subreddit: string | null;
  engagement: QuoteEngagement | null;
  quote_text: string;
  quote_text_hash: string;
  status: ResearchQuote['status'];
}): boolean {
  const ts = now();
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO research_quotes
         (id, project_id, job_id, platform, source_id, source_url, created_at_platform,
          subreddit, engagement, engagement_score, quote_text, quote_text_hash, status,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      crypto.randomUUID(),
      input.project_id,
      input.job_id,
      input.platform,
      input.source_id,
      input.source_url,
      input.created_at_platform,
      input.subreddit,
      input.engagement ? JSON.stringify(input.engagement) : null,
      input.engagement?.score ?? 0,
      input.quote_text,
      input.quote_text_hash,
      input.status,
      ts,
      ts
    );
  return result.changes > 0;
}

function rowToQuote(row: Record<string, unknown>): ResearchQuote {
  return {
    id: row.id as string,
    project_id: row.project_id as string,
    job_id: (row.job_id as string) ?? null,
    platform: row.platform as string,
    source_id: row.source_id as string,
    source_url: row.source_url as string,
    created_at_platform: (row.created_at_platform as string) ?? null,
    subreddit: (row.subreddit as string) ?? null,
    engagement: row.engagement ? (JSON.parse(row.engagement as string) as QuoteEngagement) : null,
    quote_text: row.quote_text as string,
    quote_text_hash: row.quote_text_hash as string,
    status: row.status as ResearchQuote['status'],
    reject_reason: (row.reject_reason as ResearchQuote['reject_reason']) ?? null,
    qc_confidence: (row.qc_confidence as number) ?? null,
    qc_model_name: (row.qc_model_name as string) ?? null,
    qc_prompt_version: (row.qc_prompt_version as string) ?? null,
    qc_raw: row.qc_raw ? (JSON.parse(row.qc_raw as string) as Record<string, unknown>) : null,
    qc_at: (row.qc_at as string) ?? null,
    dominant_emotion: (row.dominant_emotion as ResearchQuote['dominant_emotion']) ?? null,
    journey_stage: (row.journey_stage as ResearchQuote['journey_stage']) ?? null,
    villain: (row.villain as string) ?? null,
    breaking_point:
      row.breaking_point === null || row.breaking_point === undefined
        ? null
        : Boolean(row.breaking_point),
    breaking_point_description: (row.breaking_point_description as string) ?? null,
    specificity_score: (row.specificity_score as number) ?? null,
    quote_signal_score: (row.quote_signal_score as number) ?? null,
    confidence: (row.confidence as number) ?? null,
    model_name: (row.model_name as string) ?? null,
    prompt_version: (row.prompt_version as string) ?? null,
    llm_raw: row.llm_raw ? (JSON.parse(row.llm_raw as string) as Record<string, unknown>) : null,
    enriched_at: (row.enriched_at as string) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export function getPendingQuotesByEngagement(projectId: string): ResearchQuote[] {
  const rows = db
    .prepare(
      `SELECT * FROM research_quotes
        WHERE project_id = ? AND status = 'pending'
        ORDER BY engagement_score DESC`
    )
    .all(projectId) as Record<string, unknown>[];
  return rows.map(rowToQuote);
}

export function getKeptQuotesNotEnriched(projectId: string): ResearchQuote[] {
  const rows = db
    .prepare(
      `SELECT * FROM research_quotes
        WHERE project_id = ? AND status = 'kept' AND enriched_at IS NULL`
    )
    .all(projectId) as Record<string, unknown>[];
  return rows.map(rowToQuote);
}

export function updateQuoteQC(
  id: string,
  patch: {
    status: ResearchQuote['status'];
    reject_reason: ResearchQuote['reject_reason'];
    qc_confidence: number;
    qc_model_name: string;
    qc_prompt_version: string;
    qc_raw: Record<string, unknown>;
    qc_at: string;
  }
): void {
  db.prepare(
    `UPDATE research_quotes SET
       status = ?, reject_reason = ?, qc_confidence = ?, qc_model_name = ?,
       qc_prompt_version = ?, qc_raw = ?, qc_at = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    patch.status,
    patch.reject_reason,
    patch.qc_confidence,
    patch.qc_model_name,
    patch.qc_prompt_version,
    JSON.stringify(patch.qc_raw),
    patch.qc_at,
    now(),
    id
  );
}

export function updateQuoteEnrichment(
  id: string,
  patch: {
    dominant_emotion: string;
    journey_stage: string;
    villain: string;
    breaking_point: boolean;
    breaking_point_description: string | null;
    specificity_score: number;
    quote_signal_score: number;
    model_name: string;
    prompt_version: string;
    llm_raw: Record<string, unknown>;
    enriched_at: string;
  }
): void {
  db.prepare(
    `UPDATE research_quotes SET
       dominant_emotion = ?, journey_stage = ?, villain = ?, breaking_point = ?,
       breaking_point_description = ?, specificity_score = ?, quote_signal_score = ?,
       model_name = ?, prompt_version = ?, llm_raw = ?, enriched_at = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    patch.dominant_emotion,
    patch.journey_stage,
    patch.villain,
    patch.breaking_point ? 1 : 0,
    patch.breaking_point_description,
    patch.specificity_score,
    patch.quote_signal_score,
    patch.model_name,
    patch.prompt_version,
    JSON.stringify(patch.llm_raw),
    patch.enriched_at,
    now(),
    id
  );
}

export function getJobCounters(projectId: string): ResearchJobCounters {
  const rows = db
    .prepare('SELECT status, enriched_at FROM research_quotes WHERE project_id = ?')
    .all(projectId) as { status: string; enriched_at: string | null }[];
  return {
    pending_ingested: rows.length,
    quotes_extracted: rows.length,
    kept: rows.filter((q) => q.status === 'kept').length,
    rejected: rows.filter((q) => q.status === 'rejected').length,
    enriched: rows.filter((q) => q.enriched_at).length,
  };
}

// ---------------------------------------------------------------------------
// Read helpers for the query CLI (replaces Supabase views)
// ---------------------------------------------------------------------------

export function listProjects(): (ResearchProject & { kept: number; platform: ResearchPlatform | null })[] {
  const rows = db
    .prepare(
      `SELECT p.*, (
         SELECT COUNT(*) FROM research_quotes q
         WHERE q.project_id = p.id AND q.status = 'kept'
       ) AS kept,
       COALESCE(
         (
           SELECT json_extract(j.config, '$.platform')
           FROM research_jobs j
           WHERE j.project_id = p.id
           ORDER BY j.created_at DESC
           LIMIT 1
         ),
         (
           SELECT q.platform FROM research_quotes q
           WHERE q.project_id = p.id
           GROUP BY q.platform
           ORDER BY COUNT(*) DESC
           LIMIT 1
         )
       ) AS platform
       FROM research_projects p
       ORDER BY p.created_at DESC`
    )
    .all() as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as string,
    user_id: r.user_id as string,
    client: (r.client as string) ?? null,
    theme: r.theme as string,
    theme_definition: (r.theme_definition as string) ?? null,
    time_window_days: r.time_window_days as number,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
    kept: r.kept as number,
    platform: (r.platform as ResearchPlatform | null) ?? null,
  }));
}

export function dimensionCounts(
  projectId: string
): { dimension_name: string; dimension_value: string; count: number }[] {
  const dims = ['dominant_emotion', 'journey_stage', 'villain', 'subreddit'] as const;
  const out: { dimension_name: string; dimension_value: string; count: number }[] = [];
  for (const dim of dims) {
    const rows = db
      .prepare(
        `SELECT ${dim} AS value, COUNT(*) AS count
           FROM research_quotes
          WHERE project_id = ? AND status = 'kept' AND ${dim} IS NOT NULL
          GROUP BY ${dim}
          ORDER BY count DESC`
      )
      .all(projectId) as { value: string; count: number }[];
    for (const r of rows) {
      out.push({ dimension_name: dim, dimension_value: r.value, count: r.count });
    }
  }
  return out;
}

export function topQuotes(projectId: string, limit = 20): ResearchQuote[] {
  const rows = db
    .prepare(
      `SELECT * FROM research_quotes
        WHERE project_id = ? AND status = 'kept'
        ORDER BY quote_signal_score DESC, specificity_score DESC
        LIMIT ?`
    )
    .all(projectId, limit) as Record<string, unknown>[];
  return rows.map(rowToQuote);
}

export { db };
