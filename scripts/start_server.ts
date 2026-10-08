import * as path from 'path';
import * as fs from 'fs';
import * as dotenv from 'dotenv';
import { ConsoleServer } from '../src/console/server';

// 1. Load worktree local .env
dotenv.config();

// 2. Load parent main repo .env if exists
const mainRepoEnv = 'C:\\Users\\u17da\\.gemini\\Aute School Setting\\.env';
if (fs.existsSync(mainRepoEnv)) {
  dotenv.config({ path: mainRepoEnv });
}

async function run() {
  if (process.env.ANTHROPIC_API_KEY) {
    console.log(`[PlatformServer] Claude API Key detected: ${process.env.ANTHROPIC_API_KEY.slice(0, 7)}...`);
  } else {
    console.log('[PlatformServer] Claude API Key: NOT CONFIGURED');
  }
  const port = parseInt(process.env.CONSOLE_PORT || '3000', 10);
  const server = new ConsoleServer({ port, host: '127.0.0.1' });

  await server.start();
  console.log(`[PlatformServer] Server is actively running and ready at http://127.0.0.1:${port}`);

  // Keep process alive indefinitely
  process.on('SIGINT', async () => {
    console.log('[PlatformServer] Received SIGINT, shutting down...');
    await server.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('[PlatformServer] Received SIGTERM, shutting down...');
    await server.stop();
    process.exit(0);
  });

  // Keep alive
  setInterval(() => {}, 1000 * 60 * 60);
}

run().catch((err) => {
  console.error('[PlatformServer] Error starting server:', err);
  process.exit(1);
});
