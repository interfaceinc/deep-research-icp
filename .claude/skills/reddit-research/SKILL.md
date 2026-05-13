---
name: reddit-research
description: Run the Reddit research pipeline — sourcing, quote extraction, QC, and enrichment via Gemini. Use when the user asks to run research, find Reddit quotes, or source audience insight on a theme.
argument-hint: "[theme]"
---

# Reddit Research Pipeline

Run the full research pipeline: Reddit sourcing → quote extraction → quality control → enrichment.

---

## 4-Stage Pipeline

1. **Reddit Search** — ScrapeCreators API fetches posts/comments for each query
2. **Quote Extraction** — Gemini extracts verbatim first-person quotes (min 140 chars)
3. **Quality Control** — Gemini filters: keep / reject with reason
4. **Enrichment** — Gemini extracts structured dimensions per quote

---

## Steps

1. **Get research parameters** from user:
   - Theme (required): What audience/topic to research
   - Theme definition (recommended): 2-3 line scope description used during QC for relevance
   - Or list existing projects:
     ```sql
     SELECT rp.id, rp.theme, rp.client, rp.theme_definition,
       rj.status, rj.counters
     FROM research_projects rp
     LEFT JOIN research_jobs rj ON rj.project_id = rp.id
     ORDER BY rp.created_at DESC;
     ```

2. **Generate search queries**: Create 10–15 Reddit search queries based on the theme. Mix:
   - Direct pain point queries (`theme + struggle/frustrated/help`)
   - Emotional queries (`theme + overwhelmed/breaking point`)
   - Solution-seeking queries (`theme + advice/tips/recommendation`)
   - Community-specific queries (`theme + reddit/experience`)

3. **Confirm queries with the user** before running.

4. **Run pipeline**:
   ```bash
   pnpm research:run \
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
External force or entity the speaker blames. Free text. Examples: "the IRS", "my boss", "insurance companies", "social media".

### Breaking Point
Boolean + description. The specific moment that pushed them to seek change.

### Scoring
- **specificity_score** (0–100): How concrete and detailed is the quote?
- **quote_signal_score** (0–1): Overall signal quality. > 0.7 = excellent hook material.

### Reject Reasons
not_first_person | off_topic | promotional | too_short | spam | duplicate_content | not_self_contained

---

## Translating Research to Creative Angles

| Research Signal | Creative Application |
|----------------|---------------------|
| High-signal quotes (>0.7) | Direct hook inspiration — use audience's own words |
| Dominant emotion = anger | Frustration-based hooks, villainization |
| Dominant emotion = fear | Urgency-based hooks, consequence framing |
| Journey stage = shock | Awareness-style ads, "Did you know..." |
| Journey stage = struggle | Consideration ads, "I've been there..." |
| Journey stage = desperation | Direct response, "Finally, a solution..." |
| Villain identified | Create antagonist in narrative |
| Breaking point | Recreate the moment of realization |

---

## Pattern Analysis Queries

```sql
-- Dimension distribution (emotion / stage / villain / subreddit) in one shot
SELECT dimension_name, dimension_value, count
FROM v_research_dimension_counts
WHERE project_id = '$ID'
ORDER BY dimension_name, count DESC;

-- Top quotes by signal
SELECT quote_text, dominant_emotion, villain, specificity_score, source_url
FROM v_research_top_quotes
WHERE project_id = '$ID'
LIMIT 20;

-- Breaking points
SELECT breaking_point_description, COUNT(*) AS count
FROM research_quotes
WHERE project_id = '$ID' AND status = 'kept' AND breaking_point = true
GROUP BY breaking_point_description
ORDER BY count DESC
LIMIT 10;
```
