/**
 * Jarvis Local AI Agent: Web Server Runner CLI
 * Authority: FEAT-004
 */

import path from 'node:path';
import { JarvisWebServer } from '../web/server.js';
import { DocumentStore } from '../storage/collection.js';
import { SessionManager } from '../sessions/manager.js';
import { DEFAULT_CHAT_USER_ID } from '../storage/chat-store.js';
import { migrateLegacyChatDb } from '../storage/chat-migration.js';
import { getTelegramOwnerId } from '../security/credentials.js';
import { logger } from '../utils/logger.js';

const port = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 3000;
// Same store and owner ID as `start-all.ts`, so sessions are shared with Telegram whichever launcher runs.
const dataDir = path.resolve(process.cwd(), 'data');
const store = new DocumentStore(path.join(dataDir, 'jarvis.db'));
const sessionManager = new SessionManager(store);
const userId = getTelegramOwnerId() || DEFAULT_CHAT_USER_ID;
const server = new JarvisWebServer({ port, sessionManager, userId });

async function main() {
  console.log('\n======================================================');
  console.log('       JARVIS LOCAL AI AGENT - WEB WORKSTATION        ');
  console.log('======================================================\n');

  try {
    await migrateLegacyChatDb({ legacyDbPath: path.join(dataDir, 'chat.db'), store, sessionManager, userId });
  } catch (err: unknown) {
    logger.error(`[ChatMigration] data/chat.db import failed; it is retried on the next start: ${err instanceof Error ? err.message : String(err)}`);
  }
  await server.start();
  console.log(`🚀 Claude/Gemini-Style Web Chat available at: http://localhost:${port}\n`);
  console.log('Press Ctrl+C to stop the server.\n');

  process.on('SIGINT', async () => {
    console.log('\n[JarvisWebServer] Gracefully shutting down...');
    await server.stop();
    store.close();
    process.exit(0);
  });
}

main().catch((err) => {
  logger.error(`Fatal error in Web Server: ${err.message}`);
  process.exit(1);
});
