/**
 * Jarvis Local AI Agent: Web Server Runner CLI
 * Authority: FEAT-004
 */

import { JarvisWebServer } from '../web/server.js';
import { logger } from '../utils/logger.js';

const port = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 3000;
const server = new JarvisWebServer({ port });

async function main() {
  console.log('\n======================================================');
  console.log('       JARVIS LOCAL AI AGENT - WEB WORKSTATION        ');
  console.log('======================================================\n');

  await server.start();
  console.log(`🚀 Claude/Gemini-Style Web Chat available at: http://localhost:${port}\n`);
  console.log('Press Ctrl+C to stop the server.\n');

  process.on('SIGINT', async () => {
    console.log('\n[JarvisWebServer] Gracefully shutting down...');
    await server.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  logger.error(`Fatal error in Web Server: ${err.message}`);
  process.exit(1);
});
