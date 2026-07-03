#!/usr/bin/env node
/**
 * Local dev server entrypoint.
 * Vercel uses api/index.ts instead.
 */

import app from './app.js';

const PORT = Number(process.env.PORT) || 3000;

app.listen(PORT, () => {
  console.log(`\n  Research UI running at http://localhost:${PORT}\n`);
});
