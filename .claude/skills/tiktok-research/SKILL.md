---
name: tiktok-research
description: Run the TikTok research pipeline — ScrapeCreators keyword search, comment extraction, QC, and enrichment via Gemini. Use when the user asks to run TikTok research, find TikTok audience quotes, or source insight from TikTok comments on a theme.
argument-hint: "[theme]"
---

# TikTok Research Pipeline

Run the full research pipeline: TikTok keyword search → comment batching → quote extraction → quality control → enrichment.

**Credit budget:** ~200 ScrapeCreators credits per full run (12 queries). Confirm queries with the user before running. For a cheap smoke test, use 2 queries (~35 credits).

---

## 4-Stage Pipeline

1. **TikTok Search** — ScrapeCreators keyword search, pre-filter videos by comment count (≥15), fetch top comments per video
2. **Quote Extraction** — Gemini extracts verbatim first-person quotes (min 80 chars for TikTok)
3. **Quality Control** — Gemini filters: keep / reject with reason
4. **Enrichment** — Gemini extracts structured dimensions per quote

Comments-only — no transcripts (creator pitch, not audience voice).

---

## Steps

1. **Get research parameters** from user:
   - Theme (required): What audience/topic to research
   - Theme definition (recommended): 2-3 line scope description used during QC for relevance
   - Or list existing projects via `pnpm research:query`

2. **Generate search queries**: Create **8–12 short keyword phrases** (TikTok matches captions/hashtags, not long-tail prose). Mix:
   - Pain phrases (`working mom burnout`, `missed sales call`)
   - Emotional hooks (`overwhelmed field rep`, `voicemail nightmare`)
   - Hashtag-style (`#constructionlife problems`, `#saleslife struggle`)
   - Spoken language (`why I hate cold calling`, `nobody answers the phone anymore`)

3. **Confirm queries with the user** before running — remind them of ~200 credit cost for a full run.

4. **Run pipeline**:
   ```bash
   pnpm research:run \
     --platform tiktok \
     --theme "$THEME" \
     --queries '$QUERIES_JSON' \
     --theme_definition "$DEFINITION"
   ```

5. **Report results**: Show kept/rejected counts, top quotes, pattern overview using the queries below.

---

## Enrichment Dimensions Reference

### Dominant Emotion
anger | fear | guilt | shame | grief | urgency | hope | relief | resignation | pride | mixed

### Journey Stage
- **shock** — Just discovered the problem, disbelief stage
- **struggle** — Actively dealing with it, trying solutions
- **desperation** — Urgent need, at breaking point

### Villain
External force or entity the speaker blames. Free text.

### Breaking Point
Boolean + description. The specific moment that pushed them to seek change.

### Scoring
- **specificity_score** (0–100): How concrete and detailed is the quote?
- **quote_signal_score** (0–1): Overall signal quality. > 0.7 = excellent hook material.

### Reject Reasons
not_first_person | off_topic | promotional | too_short | spam | duplicate_content | not_self_contained

---

## Pattern Analysis Queries

```sql
-- Dimension distribution (emotion / stage / villain / creator handle in subreddit column)
SELECT dimension_name, dimension_value, count
FROM v_research_dimension_counts
WHERE project_id = '$ID'
ORDER BY dimension_name, count DESC;

-- Top TikTok quotes by signal
SELECT quote_text, dominant_emotion, villain, specificity_score, source_url, subreddit
FROM v_research_top_quotes
WHERE project_id = '$ID'
LIMIT 20;

-- TikTok-only quotes for a project
SELECT quote_text, source_url, subreddit, quote_signal_score
FROM research_quotes
WHERE project_id = '$ID' AND platform = 'tiktok' AND status = 'kept'
ORDER BY quote_signal_score DESC
LIMIT 20;
```

---

## Credit Tuning (research.types.ts RESEARCH_DEFAULTS)

| Knob | Default | Effect |
|------|---------|--------|
| TIKTOK_SEARCH_PAGES_PER_QUERY | 2 | Search pages per query |
| TIKTOK_MAX_VIDEOS_PER_QUERY | 8 | Max videos scraped for comments per query |
| TIKTOK_MIN_COMMENT_COUNT | 15 | Skip low-engagement videos |
| TIKTOK_COMMENT_PAGES_PER_VIDEO | 2 | Comment pages per video (~40 comments) |
| TIKTOK_TARGET_PENDING | 150 | Stop search after this many sources |
