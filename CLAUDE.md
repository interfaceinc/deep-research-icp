# Reddit Research Toolkit — Claude Code Guide

This repo is a standalone Reddit research pipeline. The user runs research on a theme; you (Claude Code) help them shape queries, run the pipeline, and analyze patterns.

## Pipeline

Entry point: `src/services/research-orchestrator.service.ts` → `runPipeline()`.

Four stages, all driven by Gemini 2.0 Flash + the ScrapeCreators API:

1. **Search** — `scrape-creators.service.ts` searches Reddit for each query (posts + comments).
2. **Extract** — `gemini-research.service.ts:extractQuotes` pulls verbatim first-person quotes (≥140 chars).
3. **QC** — `gemini-research.service.ts:qualityControlQuote` keeps or rejects each quote with a reason.
4. **Enrich** — `gemini-research.service.ts:enrichQuote` adds dominant emotion, journey stage, villain, breaking point, scores.

CLI runner: `src/scripts/research-run.ts` (invoked via `pnpm research:run`).

## When the user asks for research

Use the skill at `.claude/skills/reddit-research/SKILL.md`. It defines the orchestration flow:

1. Ask for theme + (optional) theme definition.
2. Generate 10–15 search queries — mix pain points, emotional triggers, solution-seeking, community-specific.
3. Confirm queries with the user.
4. Run `pnpm research:run --theme "..." --queries '[...]' --theme_definition "..."`.
5. Report kept/rejected counts and offer pattern queries.

## Database

Tables: `research_projects`, `research_jobs`, `research_quotes`.
Views for pattern analysis: `v_research_dimension_counts`, `v_research_top_quotes`.
Schema lives in `supabase/migrations/0001_research_schema.sql`.

## Configuration

Required env vars (see `.env.example`):
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- `GOOGLE_GENAI_API_KEY`
- `SCRAPE_CREATORS_API_KEY`

Pipeline defaults (target counts, model name, min quote chars) live in `src/services/research.types.ts` → `RESEARCH_DEFAULTS`.

## Modifying the pipeline

Common changes:
- **Tune extraction prompt** → `src/services/gemini-research.service.ts:extractQuotes`
- **Change QC criteria** → `gemini-research.service.ts:qualityControlQuote`
- **Add an enrichment dimension** → update `ResearchQuote` type + `enrichQuote` prompt + Zod schema + migration
- **Change search source** → replace `scrape-creators.service.ts` with a new client
- **Adjust concurrency / rate limits** → `rate-limiter.service.ts` and `pLimit` calls in each service
