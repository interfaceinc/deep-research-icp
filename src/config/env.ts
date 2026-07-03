import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  GOOGLE_GENAI_API_KEY: z.string().min(1),
  SERPAPI_KEY: z.string().min(1),
  SCRAPECREATORS_API_KEY: z.string().optional(),

  // Local SQLite (dev) or /tmp on Vercel (ephemeral — see README deploy notes)
  RESEARCH_DB_PATH: z
    .string()
    .default(process.env.VERCEL ? '/tmp/research.db' : 'research.db'),
});

function validateEnv() {
  try {
    return envSchema.parse(process.env);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const missingVars = error.errors.map((err) => err.path.join('.')).join(', ');
      throw new Error(
        `Missing or invalid environment variables: ${missingVars}. Copy .env.example to .env and fill in the values.`
      );
    }
    throw error;
  }
}

export const env = validateEnv();
