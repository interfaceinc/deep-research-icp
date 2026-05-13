/**
 * Gemini Research Service
 * AI processing for all research pipeline stages with structured output
 */

import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import pLimit from 'p-limit';
import { env } from '../config/env.js';
import { withRetry } from './rate-limiter.service.js';
import {
  RESEARCH_DEFAULTS,
  DOMINANT_EMOTIONS,
  JOURNEY_STAGES,
  REJECT_REASONS,
  QueryGenerationSchema,
  QualityControlSchema,
  EnrichmentSchema,
  type QualityControlResult,
  type EnrichmentResult,
} from './research.types.js';

// Prompt version tracking for reproducibility
const PROMPT_VERSIONS = {
  QUERY_GENERATION: 'v1.0',
  QUOTE_EXTRACTION: 'v1.0',
  QUALITY_CONTROL: 'v1.0',
  ENRICHMENT: 'v1.0',
} as const;

export class GeminiResearchService {
  private genAI: GoogleGenerativeAI;
  private concurrencyLimit: ReturnType<typeof pLimit>;

  constructor() {
    this.genAI = new GoogleGenerativeAI(env.GOOGLE_GENAI_API_KEY);
    this.concurrencyLimit = pLimit(RESEARCH_DEFAULTS.GEMINI_CONCURRENCY);
  }

  /**
   * Stage 1: Generate search queries for a theme
   */
  async generateSearchQueries(
    theme: string,
    themeDefinition?: string
  ): Promise<{ queries: string[]; raw: unknown }> {
    const model = this.genAI.getGenerativeModel({
      model: RESEARCH_DEFAULTS.GEMINI_MODEL,
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: SchemaType.OBJECT,
          properties: {
            search_queries: {
              type: SchemaType.ARRAY,
              items: { type: SchemaType.STRING },
              description: 'List of 5-15 diverse search query strings for Reddit',
            },
          },
          required: ['search_queries'],
        },
      },
    });

    const prompt = `You are a research query generator for Reddit. Generate 5-15 diverse search queries to find authentic first-person experiences about:

THEME: ${theme}
${themeDefinition ? `THEME DEFINITION: ${themeDefinition}` : ''}

Requirements:
- Generate queries that capture the TRUE DISTRIBUTION of conversations (not just extreme cases)
- Include variations: emotional language, specific scenarios, common phrases people use
- Mix short natural phrases and longer specific queries
- Include queries that find struggles, coping, venting, advice-seeking
- Do NOT bias toward any product category or angle
- Focus on first-person language ("I", "my", "we")

Example queries for "Working moms":
- "I'm a working mom and"
- "daycare pickup after work"
- "working mom guilt"
- "balancing work and kids"
- "I can't do it all anymore"
- "mental load working mom"
- "pumping at work"
- "mom burnout"

Return ONLY the JSON with search_queries array.`;

    const result = await withRetry(
      async () => model.generateContent(prompt),
      {
        maxRetries: 3,
        context: 'query_generation',
      }
    );

    const text = result.response.text();
    const parsed = JSON.parse(text);

    // Validate with Zod
    const validated = QueryGenerationSchema.parse(parsed);

    return {
      queries: validated.search_queries,
      raw: parsed,
    };
  }

  /**
   * Stage 3: Extract verbatim quotes from a source text
   */
  async extractQuotes(
    sourceText: string,
    theme: string,
    themeDefinition?: string
  ): Promise<{ quotes: Array<{ verbatim_text: string }>; raw: unknown }> {
    const model = this.genAI.getGenerativeModel({
      model: RESEARCH_DEFAULTS.GEMINI_MODEL,
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: SchemaType.OBJECT,
          properties: {
            quotes: {
              type: SchemaType.ARRAY,
              items: {
                type: SchemaType.OBJECT,
                properties: {
                  verbatim_text: {
                    type: SchemaType.STRING,
                    description: 'Exact verbatim text segment from the source',
                  },
                },
                required: ['verbatim_text'],
              },
            },
          },
          required: ['quotes'],
        },
      },
    });

    const prompt = `Extract verbatim quote candidates from this Reddit text that relate to:

THEME: ${theme}
${themeDefinition ? `THEME DEFINITION: ${themeDefinition}` : ''}

SOURCE TEXT:
"""
${sourceText}
"""

REQUIREMENTS:
- Extract EXACT verbatim text segments - NO rewriting or paraphrasing
- Each quote must be CONTIGUOUS (no merging non-adjacent sentences)
- Each quote must be at least 100 characters
- Each quote must be SELF-CONTAINED and understandable alone
- Only extract segments that relate to the theme
- Multiple quotes from same source are OK
- If no relevant quotes exist, return empty array

DO NOT:
- Rewrite or clean up text
- Summarize content
- Merge non-contiguous segments
- Judge quality or usefulness

Return ONLY the JSON with quotes array.`;

    const result = await withRetry(
      async () => model.generateContent(prompt),
      {
        maxRetries: 3,
        context: 'quote_extraction',
      }
    );

    const text = result.response.text();
    const parsed = JSON.parse(text);

    // Validate - allow empty arrays and shorter quotes (filtering happens later)
    const validated = {
      quotes: (parsed.quotes || []).filter(
        (q: { verbatim_text?: string }) =>
          q.verbatim_text && q.verbatim_text.length >= 50
      ),
    };

    return {
      quotes: validated.quotes,
      raw: parsed,
    };
  }

  /**
   * Stage 4: Quality control decision for a quote
   */
  async qualityControlQuote(
    quoteText: string,
    theme: string,
    themeDefinition?: string
  ): Promise<{ result: QualityControlResult; raw: unknown }> {
    const model = this.genAI.getGenerativeModel({
      model: RESEARCH_DEFAULTS.GEMINI_MODEL,
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: SchemaType.OBJECT,
          properties: {
            decision: {
              type: SchemaType.STRING,
              enum: ['keep', 'reject'],
            },
            reject_reason: {
              type: SchemaType.STRING,
              enum: [...REJECT_REASONS],
              nullable: true,
            },
            confidence: {
              type: SchemaType.NUMBER,
              description: 'Confidence score between 0 and 1',
            },
          },
          required: ['decision', 'confidence'],
        },
      },
    });

    const prompt = `Evaluate this quote for research relevance. Your job is ONLY to filter out noise, not to judge angle potential.

THEME: ${theme}
${themeDefinition ? `THEME DEFINITION (for broad relevance only): ${themeDefinition}` : ''}

QUOTE:
"""
${quoteText}
"""

KEEP if ALL of these are true:
- First-person or first-hand experience (uses "I", "my", "we", describes personal situation)
- BROADLY relevant to the theme (doesn't need to be intense or specific)
- Public, non-spam, non-promotional

REJECT REASONS (use if quote fails any criteria):
- not_first_person: Third-person advice or general statements without personal experience
- off_topic: Not related to theme at all
- promotional: Advertising, self-promotion, affiliate links
- too_short: Less than 1 full sentence or too fragmentary to understand
- spam: Gibberish, repeated text, nonsense
- duplicate_content: Clearly copied/pasted generic content
- not_self_contained: Cannot be understood without surrounding context

NEVER filter by:
- Product relevance
- Angle potential
- Emotional intensity
- Writing quality

Return JSON with: decision ("keep" or "reject"), reject_reason (null if keeping), confidence (0-1).`;

    const result = await withRetry(
      async () => model.generateContent(prompt),
      {
        maxRetries: 3,
        context: 'quality_control',
      }
    );

    const text = result.response.text();
    const parsed = JSON.parse(text);

    // Validate with Zod
    const validated = QualityControlSchema.parse({
      decision: parsed.decision,
      reject_reason: parsed.reject_reason || null,
      confidence: parsed.confidence || 0.5,
    });

    return {
      result: validated,
      raw: parsed,
    };
  }

  /**
   * Stage 5: Enrich a kept quote with analytical dimensions
   */
  async enrichQuote(
    quoteText: string
  ): Promise<{ result: EnrichmentResult; raw: unknown }> {
    const model = this.genAI.getGenerativeModel({
      model: RESEARCH_DEFAULTS.GEMINI_MODEL,
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: SchemaType.OBJECT,
          properties: {
            dominant_emotion: {
              type: SchemaType.STRING,
              enum: [...DOMINANT_EMOTIONS],
              description: 'Primary emotional state expressed in the quote',
            },
            journey_stage: {
              type: SchemaType.STRING,
              enum: [...JOURNEY_STAGES],
              description: 'Where the speaker is in their experiential journey',
            },
            villain: {
              type: SchemaType.STRING,
              description:
                'Who/what is being blamed or resented. Use "none" if no clear villain.',
            },
            breaking_point: {
              type: SchemaType.BOOLEAN,
              description: 'Whether the quote contains a clear moment of rupture or realization',
            },
            breaking_point_description: {
              type: SchemaType.STRING,
              nullable: true,
              description: 'Short phrase describing the breaking point moment',
            },
            specificity_score: {
              type: SchemaType.INTEGER,
              description: 'How concrete and detailed the quote is (0-100)',
            },
            quote_signal_score: {
              type: SchemaType.NUMBER,
              description: 'Strength as a standalone moment (0.0-1.0)',
            },
          },
          required: [
            'dominant_emotion',
            'journey_stage',
            'villain',
            'breaking_point',
            'specificity_score',
            'quote_signal_score',
          ],
        },
      },
    });

    const prompt = `Analyze this verbatim quote and extract research dimensions.

QUOTE:
"""
${quoteText}
"""

EXTRACT:

1. dominant_emotion: The PRIMARY emotional state (${DOMINANT_EMOTIONS.join(', ')})
   - Select the most central emotion. Use "mixed" only if truly ambiguous.

2. journey_stage: Where the speaker is in their experience:
   - "shock": Realizing something is wrong or unexpected
   - "struggle": Ongoing attempts, coping, frustration
   - "desperation": Last attempts, urgency, "something has to change"

3. villain: Who/what is being blamed (or "none")
   - Partner, employer, system (daycare, healthcare), time, their own body, social expectations, etc.
   - Be specific. "My boss" not just "work"
   - Use "none" if no clear villain is present

4. breaking_point: true/false - Does this contain a clear moment of rupture or realization?
   - Mark true ONLY if there's a specific moment ("the day I...", "when I realized...", "that's when...")
   - General frustration alone is NOT a breaking point

5. breaking_point_description: Short phrase describing the moment (null if breaking_point=false)

6. specificity_score: 0-100 - How concrete and detailed is the quote?
   - Low (0-30): Generic statements ("I'm always exhausted")
   - Medium (31-70): Some details ("exhausted after work, never enough time")
   - High (71-100): Concrete details, numbers, times, locations, specific situations

7. quote_signal_score: 0.0-1.0 - How strong is this as a standalone moment?
   - Consider: emotional clarity, recognizability, specificity, narrative completeness

Return ONLY the JSON.`;

    const result = await withRetry(
      async () => model.generateContent(prompt),
      {
        maxRetries: 3,
        context: 'enrichment',
      }
    );

    const text = result.response.text();
    const parsed = JSON.parse(text);

    // Validate with Zod
    const validated = EnrichmentSchema.parse({
      dominant_emotion: parsed.dominant_emotion,
      journey_stage: parsed.journey_stage,
      villain: parsed.villain || 'none',
      breaking_point: parsed.breaking_point || false,
      breaking_point_description: parsed.breaking_point_description || null,
      specificity_score: Math.min(100, Math.max(0, parsed.specificity_score || 50)),
      quote_signal_score: Math.min(1, Math.max(0, parsed.quote_signal_score || 0.5)),
    });

    return {
      result: validated,
      raw: parsed,
    };
  }

  /**
   * Process multiple items with concurrency control
   */
  async processWithConcurrency<T, R>(
    items: T[],
    processor: (item: T) => Promise<R>,
    onProgress?: (completed: number, total: number) => void
  ): Promise<Array<{ item: T; result: R | null; error?: string }>> {
    let completed = 0;

    const results = await Promise.all(
      items.map((item) =>
        this.concurrencyLimit(async () => {
          try {
            const result = await processor(item);
            completed++;
            onProgress?.(completed, items.length);
            return { item, result };
          } catch (error) {
            completed++;
            onProgress?.(completed, items.length);
            return {
              item,
              result: null,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        })
      )
    );

    return results;
  }

  /**
   * Get prompt version for tracking
   */
  getPromptVersion(stage: keyof typeof PROMPT_VERSIONS): string {
    return PROMPT_VERSIONS[stage];
  }

  /**
   * Get model name for tracking
   */
  getModelName(): string {
    return RESEARCH_DEFAULTS.GEMINI_MODEL;
  }
}
