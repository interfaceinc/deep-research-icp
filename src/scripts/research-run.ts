#!/usr/bin/env node
/**
 * Research Pipeline CLI Runner (V2 - Claude-Controlled Queries)
 *
 * Usage:
 *   pnpm run research:run --theme "Working moms" --queries '[...]' [--theme_definition "..."]
 *
 * Example with inline queries:
 *   pnpm run research:run \
 *     --theme "Working moms" \
 *     --queries '["working mom burnout reddit", "juggling work and kids exhausted"]' \
 *     --theme_definition "US working moms balancing full-time work and young kids."
 *
 * Example with queries file:
 *   pnpm run research:run \
 *     --theme "Working moms" \
 *     --queries_file ./queries/working-moms.json \
 *     --theme_definition "US working moms balancing full-time work and young kids."
 */

import { readFileSync } from 'fs';
import { ResearchOrchestratorService } from '../services/research-orchestrator.service.js';
import { researchEvents } from '../services/research-events.service.js';
import type { ResearchEvent } from '../services/research.types.js';

// ANSI color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
};

/**
 * Parse CLI arguments
 */
function parseArgs(): {
  theme: string;
  theme_definition?: string;
  client?: string;
  user_id: string;
  platform: 'reddit' | 'tiktok';
  queries: string[];
} {
  const args = process.argv.slice(2);
  const parsed: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const value = args[i + 1];
      if (value && !value.startsWith('--')) {
        parsed[key] = value;
        i++;
      }
    }
  }

  // Validate required arguments
  const errors: string[] = [];

  if (!parsed.theme) {
    errors.push('--theme is required');
  }

  if (!parsed.queries && !parsed.queries_file) {
    errors.push('--queries or --queries_file is required');
  }

  if (errors.length > 0) {
    console.error(`${colors.red}Error: ${errors.join(', ')}${colors.reset}`);
    console.log(`
${colors.cyan}Usage:${colors.reset}
  pnpm run research:run --theme "..." --queries '[...]' [--theme_definition "..."]

${colors.cyan}Options:${colors.reset}
  --theme             ${colors.dim}(required)${colors.reset} Research theme (e.g., "Working moms")
  --queries           ${colors.dim}(required*)${colors.reset} JSON array of search queries
  --queries_file      ${colors.dim}(required*)${colors.reset} Path to JSON file with queries array
  --theme_definition  ${colors.dim}(optional)${colors.reset} 2-3 line definition for QC relevance
  --client            ${colors.dim}(optional)${colors.reset} Client name for the project
  --platform          ${colors.dim}(optional)${colors.reset} reddit (default) or tiktok
  --user_id           ${colors.dim}(optional)${colors.reset} User ID (defaults to system user)

  ${colors.dim}* Either --queries or --queries_file must be provided${colors.reset}

${colors.cyan}Example with inline queries:${colors.reset}
  pnpm run research:run \\
    --theme "Working moms" \\
    --queries '["working mom burnout", "juggling work and kids"]' \\
    --theme_definition "US working moms balancing full-time work and young kids."

${colors.cyan}Example with queries file:${colors.reset}
  pnpm run research:run \\
    --theme "Working moms" \\
    --queries_file ./queries/working-moms.json
`);
    process.exit(1);
  }

  // Parse queries from either inline or file
  let queries: string[];
  try {
    if (parsed.queries) {
      queries = JSON.parse(parsed.queries);
    } else {
      const fileContent = readFileSync(parsed.queries_file, 'utf-8');
      queries = JSON.parse(fileContent);
    }

    // Validate queries array
    if (!Array.isArray(queries) || queries.length === 0) {
      throw new Error('Queries must be a non-empty array');
    }
    if (!queries.every((q) => typeof q === 'string' && q.length > 0)) {
      throw new Error('All queries must be non-empty strings');
    }
  } catch (error) {
    console.error(
      `${colors.red}Error parsing queries: ${error instanceof Error ? error.message : error}${colors.reset}`
    );
    process.exit(1);
  }

  return {
    theme: parsed.theme,
    theme_definition: parsed.theme_definition,
    client: parsed.client,
    user_id: parsed.user_id || '00000000-0000-0000-0000-000000000000',
    platform: parsed.platform === 'tiktok' ? 'tiktok' : 'reddit',
    queries,
  };
}

/**
 * Format timestamp for logs
 */
function formatTime(): string {
  return new Date().toISOString().slice(11, 19);
}

/**
 * Setup event logging for console output
 */
function setupEventLogging(): void {
  researchEvents.on('research:event', (event: ResearchEvent) => {
    const time = formatTime();

    switch (event.type) {
      case 'research:started':
        console.log(`
${colors.bright}${'═'.repeat(60)}${colors.reset}
${colors.green}[${time}]${colors.reset} ${colors.bright}RESEARCH PIPELINE STARTED${colors.reset}
   ${colors.cyan}Theme:${colors.reset} ${event.theme}
   ${colors.cyan}Project ID:${colors.reset} ${event.projectId}
   ${colors.cyan}Job ID:${colors.reset} ${event.jobId}
${colors.bright}${'═'.repeat(60)}${colors.reset}
`);
        break;

      case 'research:stage_started':
        console.log(`
${colors.blue}[${time}]${colors.reset} ${colors.bright}Stage: ${event.stage.toUpperCase()}${colors.reset}
   ${event.message}`);
        break;

      case 'research:stage_progress':
        process.stdout.write(
          `\r${colors.dim}[${time}]${colors.reset} Progress: ${colors.yellow}${event.percentage}%${colors.reset} - ${event.message || ''}`
        );
        break;

      case 'research:stage_completed':
        console.log(`
${colors.green}[${time}]${colors.reset} ${colors.bright}Stage Complete: ${event.stage}${colors.reset}
   ${event.message}`);
        break;

      case 'research:log':
        const levelColor =
          event.level === 'error'
            ? colors.red
            : event.level === 'warn'
              ? colors.yellow
              : colors.dim;
        const levelPrefix =
          event.level === 'error' ? '!!!' : event.level === 'warn' ? '!!' : '   ';
        console.log(
          `${levelColor}[${time}] ${levelPrefix}${colors.reset} ${event.message}`
        );
        break;

      case 'research:completed':
        console.log(`
${colors.bright}${'═'.repeat(60)}${colors.reset}
${colors.green}[${time}]${colors.reset} ${colors.bright}PIPELINE COMPLETED${colors.reset}
   ${colors.cyan}Quotes Kept:${colors.reset} ${event.stats.kept}
   ${colors.cyan}Quotes Enriched:${colors.reset} ${event.stats.enriched}
   ${colors.cyan}Quotes Rejected:${colors.reset} ${event.stats.rejected}
${colors.bright}${'═'.repeat(60)}${colors.reset}
`);
        break;

      case 'research:error':
        console.error(`
${colors.red}[${time}] PIPELINE ERROR${colors.reset}
   ${event.error}
`);
        break;
    }
  });
}

/**
 * Main execution
 */
async function main(): Promise<void> {
  const args = parseArgs();

  setupEventLogging();

  console.log(`
${colors.magenta}╔══════════════════════════════════════════════════════════╗
║          ${colors.bright}Beside Research Engine V2${colors.reset}${colors.magenta}                      ║
║          Claude-Controlled Queries                       ║
╚══════════════════════════════════════════════════════════╝${colors.reset}
`);

  console.log(`${colors.cyan}Configuration:${colors.reset}`);
  console.log(`   Theme: ${colors.bright}${args.theme}${colors.reset}`);
  if (args.theme_definition) {
    console.log(`   Definition: ${colors.dim}${args.theme_definition.slice(0, 60)}...${colors.reset}`);
  }
  if (args.client) {
    console.log(`   Client: ${args.client}`);
  }
  console.log(`   Platform: ${colors.bright}${args.platform}${colors.reset}`);
  console.log(`   Queries: ${colors.bright}${args.queries.length}${colors.reset} search queries provided`);
  console.log(`   ${colors.dim}${args.queries.slice(0, 3).join(', ')}${args.queries.length > 3 ? '...' : ''}${colors.reset}`);
  console.log('');

  const orchestrator = new ResearchOrchestratorService();

  const result = await orchestrator.runPipeline(
    {
      theme: args.theme,
      theme_definition: args.theme_definition,
      client: args.client,
      queries: args.queries,
      platform: args.platform,
    },
    args.user_id
  );

  if (result.success) {
    console.log(`
${colors.cyan}Final Statistics:${colors.reset}
   - Sources Ingested: ${colors.bright}${result.stats.pending_ingested}${colors.reset}
   - Quotes Extracted: ${colors.bright}${result.stats.quotes_extracted}${colors.reset}
   - Quotes Kept: ${colors.green}${result.stats.kept}${colors.reset}
   - Quotes Rejected: ${colors.red}${result.stats.rejected}${colors.reset}
   - Quotes Enriched: ${colors.green}${result.stats.enriched}${colors.reset}
   - Duration: ${colors.bright}${(result.duration / 1000).toFixed(1)}s${colors.reset}
   - Project ID: ${colors.dim}${result.projectId}${colors.reset}
   - Job ID: ${colors.dim}${result.jobId}${colors.reset}

${colors.green}Success!${colors.reset} Data is stored locally in SQLite (research.db).
View results with:
   - ${colors.cyan}pnpm research:query${colors.reset}                       - list all projects
   - ${colors.cyan}pnpm research:query ${result.projectId}${colors.reset} - patterns + top quotes
`);
    process.exit(0);
  } else {
    console.error(`
${colors.red}Pipeline failed: ${result.error}${colors.reset}

Check the logs above for details.
`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`${colors.red}Unhandled error:${colors.reset}`, error);
  process.exit(1);
});
