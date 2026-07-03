# Audience Research Toolkit

Reddit + TikTok audience research pipeline with a web UI. Runs search → quote extraction → QC → enrichment via Gemini, stores results in local SQLite.

## Quick start (local)

```bash
pnpm install
cp .env.example .env   # fill in keys
pnpm web               # http://localhost:3000
```

**Env vars:** `GOOGLE_GENAI_API_KEY`, `SERPAPI_KEY` (Reddit), `SCRAPECREATORS_API_KEY` (TikTok, optional if Reddit-only)

**CLI:**
```bash
pnpm research:run --platform tiktok --theme "..." --queries_file ./queries/example.json
pnpm research:query <project-id>
```

## Deploy to Vercel

Repo: https://github.com/interfaceinc/deep-research-icp

### 1. Push to GitHub

Already configured — `origin` points at the repo above.

### 2. Import in Vercel

1. [vercel.com/new](https://vercel.com/new) → Import `interfaceinc/deep-research-icp`
2. Framework preset: **Other**
3. Add environment variables (same as `.env.example`):
   - `GOOGLE_GENAI_API_KEY`
   - `SERPAPI_KEY`
   - `SCRAPECREATORS_API_KEY`
4. Deploy

`vercel.json` routes all traffic to the Express app in `api/index.ts` with `maxDuration: 800` (requires Pro for long runs).

### Vercel limitations (important)

| Issue | Impact |
|-------|--------|
| **SQLite in `/tmp`** | Data is **ephemeral** — projects/quotes reset on cold starts. Fine for demos; not for production persistence. |
| **800s max function time** | Full pipeline runs can take 15–20+ min. Long runs may timeout on serverless. Use CLI locally for heavy jobs until we add Turso/queue. |
| **In-memory `running` flag** | Resets per instance — concurrent runs possible under load. |

**Production persistence (next step):** migrate `src/config/db.ts` to [Turso](https://turso.tech) (libSQL) or Neon Postgres.

### Local vs Vercel

| | Local (`pnpm web`) | Vercel |
|---|---|---|
| Database | `research.db` (persistent) | `/tmp/research.db` (ephemeral) |
| Long runs | ✅ ~20 min OK | ⚠️ may hit timeout |
| SSE progress | ✅ | ✅ while connection open |

## Project layout

```
src/
  app.ts              Express app (local + Vercel)
  server.ts           Local dev entrypoint
  web/index.html      UI
  services/           Pipeline + TikTok/Reddit search
  config/db.ts        SQLite
api/
  index.ts            Vercel serverless handler
queries/              Example query JSON files
```
