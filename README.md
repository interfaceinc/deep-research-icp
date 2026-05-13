# Reddit Research Toolkit

A self-contained tool for sourcing audience insight from Reddit. Runs a 4-stage pipeline — search → quote extraction → quality control → enrichment — and stores structured quotes in your own Supabase project. Built to be driven by Claude Code: open this repo in Claude Code, ask it to run research on a theme, and the included skill orchestrates query generation, pipeline runs, and pattern analysis.

## What it does

Given a theme (e.g. *"working moms"*) and a set of Reddit search queries:

1. **Search** Reddit posts & comments via the ScrapeCreators API
2. **Extract** verbatim first-person quotes (≥140 chars) via Gemini
3. **Quality control** each quote: keep or reject with a reason
4. **Enrich** kept quotes with structured dimensions — dominant emotion, journey stage, villain, breaking point, specificity score, signal score

Output lands in three Postgres tables (`research_projects`, `research_jobs`, `research_quotes`) plus two query-friendly views (`v_research_dimension_counts`, `v_research_top_quotes`).

## Prerequisites

You'll need three things — all free or pay-as-you-go:

| Service | What it does | Sign up |
|---------|--------------|---------|
| **Supabase** | Postgres database for storing quotes | https://supabase.com → New project (free tier is enough) |
| **Google Gemini** | LLM for extraction / QC / enrichment | https://aistudio.google.com/app/apikey (free tier covers thousands of calls/day) |
| **ScrapeCreators** | Reddit search API | https://scrapecreators.com (paid) |

You'll also need **Node 20+** and **pnpm** (`npm i -g pnpm`).

## Setup

```bash
git clone <this-repo-url> reddit-research-toolkit
cd reddit-research-toolkit
pnpm install
cp .env.example .env
# Fill in .env with your four keys
```

Then apply the schema to your Supabase project. Two options:

**Option A — Dashboard** (easiest): open your project → SQL Editor → New Query → paste the contents of `supabase/migrations/0001_research_schema.sql` → Run.

**Option B — Supabase CLI**: `supabase link --project-ref <your-ref> && supabase db push`.

Verify it worked:

```bash
# In the Supabase SQL editor:
SELECT * FROM v_research_dimension_counts;
# Should return an empty result (not an error).
```

## First run

```bash
pnpm research:run \
  --theme "Working moms" \
  --theme_definition "US working moms balancing full-time work and young kids." \
  --queries_file ./queries/example.json
```

The pipeline prints colored progress to your terminal as it moves through each stage. On success it reports kept/rejected/enriched counts and a project ID. Query your results in Supabase using the views.

## Using with Claude Code

The repo ships with a Claude Code skill at `.claude/skills/reddit-research/SKILL.md`. Open this directory in Claude Code and ask:

> *"Run research on working moms"*

Claude reads the skill, proposes 10–15 search queries for the theme, asks you to confirm, then calls `pnpm research:run` for you. After the run completes it summarizes results and offers pattern queries.

You can edit the skill directly to change query strategy, the runner script (`src/scripts/research-run.ts`) to change CLI behavior, or the services (`src/services/`) to change pipeline logic.

## Pattern queries

```sql
-- Dimension distribution for a project
SELECT dimension_name, dimension_value, count
FROM v_research_dimension_counts
WHERE project_id = '<project-id>'
ORDER BY dimension_name, count DESC;

-- Top quotes by signal
SELECT quote_text, dominant_emotion, villain, specificity_score, source_url
FROM v_research_top_quotes
WHERE project_id = '<project-id>'
LIMIT 20;
```

## Project layout

```
src/
  config/         Supabase client + env validation
  services/       4-stage pipeline (orchestrator, Gemini, ScrapeCreators, events, rate-limiter, types)
  scripts/        CLI entrypoint (research-run.ts)
supabase/
  migrations/     SQL schema
queries/          Example query files
.claude/
  skills/         Reddit research skill for Claude Code
```

## Notes

- The Supabase service-role key has admin rights. Fine for a local single-user tool; **never** commit your `.env` and never expose this key from a browser.
- Default model is `gemini-2.0-flash`. Change it in `src/services/research.types.ts` (`RESEARCH_DEFAULTS.gemini_model`).
- Pipeline targets ~1500 pending and ~1000 kept quotes per run. Adjust via `RESEARCH_DEFAULTS` in the same file.
