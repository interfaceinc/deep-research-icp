/**
 * Express app — shared by local dev server and Vercel serverless.
 */

import express, { type Request, type Response } from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import { ResearchOrchestratorService } from './services/research-orchestrator.service.js';
import { researchEvents } from './services/research-events.service.js';
import { listProjects, dimensionCounts, topQuotes } from './config/db.js';
import type { ResearchEvent, ResearchPlatform } from './services/research.types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(__dirname, 'web');

const app = express();
app.use(express.json());

// Track a single active run (single-user tool; resets on cold start in serverless)
let running = false;

app.get('/', (_req: Request, res: Response) => {
  res.sendFile(path.join(webRoot, 'index.html'));
});

app.get('/api/stream', (req: Request, res: Response) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(`retry: 3000\n\n`);

  const onEvent = (event: ResearchEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  researchEvents.on('research:event', onEvent);

  const keepAlive = setInterval(() => res.write(`: ping\n\n`), 15000);

  req.on('close', () => {
    clearInterval(keepAlive);
    researchEvents.off('research:event', onEvent);
  });
});

app.post('/api/run', (req: Request, res: Response) => {
  if (running) {
    res.status(409).json({ error: 'A run is already in progress.' });
    return;
  }

  const { theme, theme_definition, queries, platform: rawPlatform } = req.body ?? {};
  const platform: ResearchPlatform = rawPlatform === 'tiktok' ? 'tiktok' : 'reddit';
  const cleanQueries: string[] = Array.isArray(queries)
    ? queries.map((q: unknown) => String(q).trim()).filter(Boolean)
    : [];

  if (!theme || typeof theme !== 'string' || !theme.trim()) {
    res.status(400).json({ error: 'theme is required' });
    return;
  }
  if (cleanQueries.length === 0) {
    res.status(400).json({ error: 'at least one query is required' });
    return;
  }

  running = true;
  res.status(202).json({ started: true, platform });
  console.log(`[run] platform=${platform} theme="${theme.trim()}" queries=${cleanQueries.length}`);

  const orchestrator = new ResearchOrchestratorService();
  orchestrator
    .runPipeline(
      {
        theme: theme.trim(),
        theme_definition: theme_definition?.trim() || undefined,
        queries: cleanQueries,
        platform,
      },
      '00000000-0000-0000-0000-000000000000'
    )
    .catch((err) => {
      console.error('Run failed:', err);
    })
    .finally(() => {
      running = false;
    });
});

app.get('/api/status', (_req: Request, res: Response) => {
  res.json({ running });
});

app.get('/api/projects', (_req: Request, res: Response) => {
  res.json(listProjects());
});

app.get('/api/projects/:id', (req: Request, res: Response) => {
  const id = String(req.params.id);
  const project = listProjects().find((p) => p.id === id);
  const limit = req.query.limit ? Number(req.query.limit as string) : 50;
  res.json({
    project: project ?? null,
    dimensions: dimensionCounts(id),
    quotes: topQuotes(id, Number.isNaN(limit) ? 50 : limit),
  });
});

export default app;
