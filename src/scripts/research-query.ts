#!/usr/bin/env node
/**
 * Research Results Viewer
 *
 * Usage:
 *   pnpm research:query                 # list all projects
 *   pnpm research:query <projectId>     # dimension patterns + top quotes
 *   pnpm research:query <projectId> 50  # top 50 quotes
 */

import { listProjects, dimensionCounts, topQuotes } from '../config/db.js';

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
};

function listAll(): void {
  const projects = listProjects();
  if (projects.length === 0) {
    console.log(`${colors.dim}No projects yet. Run: pnpm research:run --theme "..." --queries_file ...${colors.reset}`);
    return;
  }
  console.log(`\n${colors.bright}Projects${colors.reset}\n`);
  for (const p of projects) {
    console.log(
      `${colors.cyan}${p.id}${colors.reset}\n  ${colors.bright}${p.theme}${colors.reset}` +
        `${p.client ? ` ${colors.dim}(${p.client})${colors.reset}` : ''}` +
        `  ${colors.green}${p.kept} kept${colors.reset}  ${colors.dim}${p.created_at.slice(0, 10)}${colors.reset}`
    );
  }
  console.log(`\n${colors.dim}Inspect one: pnpm research:query <projectId>${colors.reset}\n`);
}

function showProject(projectId: string, limit: number): void {
  const dims = dimensionCounts(projectId);
  const quotes = topQuotes(projectId, limit);

  if (dims.length === 0 && quotes.length === 0) {
    console.log(`${colors.dim}No kept quotes for project ${projectId} (or project not found).${colors.reset}`);
    return;
  }

  console.log(`\n${colors.magenta}${colors.bright}Pattern distribution${colors.reset}`);
  let currentDim = '';
  for (const d of dims) {
    if (d.dimension_name !== currentDim) {
      currentDim = d.dimension_name;
      console.log(`\n${colors.cyan}${currentDim}${colors.reset}`);
    }
    const bar = '█'.repeat(Math.min(40, d.count));
    console.log(`  ${String(d.count).padStart(4)}  ${colors.dim}${bar}${colors.reset} ${d.dimension_value}`);
  }

  console.log(`\n${colors.magenta}${colors.bright}Top ${quotes.length} quotes by signal${colors.reset}\n`);
  for (const q of quotes) {
    const emo = q.dominant_emotion ? `${colors.yellow}${q.dominant_emotion}${colors.reset}` : '';
    const villain = q.villain && q.villain !== 'none' ? ` ${colors.dim}· villain: ${q.villain}${colors.reset}` : '';
    const sig = q.quote_signal_score != null ? `${colors.green}${q.quote_signal_score.toFixed(2)}${colors.reset}` : '?';
    console.log(`${colors.bright}[${sig}]${colors.reset} ${emo}${villain}`);
    console.log(`  "${q.quote_text}"`);
    console.log(`  ${colors.dim}r/${q.subreddit} · ${q.source_url}${colors.reset}\n`);
  }
}

function main(): void {
  const projectId = process.argv[2];
  const limit = process.argv[3] ? parseInt(process.argv[3], 10) : 20;

  if (!projectId) {
    listAll();
  } else {
    showProject(projectId, Number.isNaN(limit) ? 20 : limit);
  }
}

main();
