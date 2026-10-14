/**
 * Jarvis Local AI Agent: Web Server Runner CLI
 * Authority: FEAT-004
 */

import { JarvisWebServer, installProcessGuard } from '../web/server.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { createLauncherRuntime, errorMessage, importLegacyChat, resolveWebPort, startWebServer } from './bootstrap.js';

async function main(): Promise<void> {
  installProcessGuard();
  console.log('\n======================================================');
  console.log('       JARVIS LOCAL AI AGENT - WEB WORKSTATION        ');
  console.log('======================================================\n');

  // Same runtime, store and owner id as `start-all.ts`, so sessions and memory are shared with Telegram whichever launcher runs.
  const launcher = await createLauncherRuntime({ reconcileInterruptedTasks: false });
  const { rt, dataDir } = launcher;
  await importLegacyChat(rt, dataDir);

  const port = resolveWebPort();
  const webOptions = {
    port,
    runtime: rt,
    sessionManager: rt.sessions,
    memoryManager: rt.memory,
    userId: rt.ownerUserId,
    killSwitch: rt.killSwitch,
    ollamaBaseUrl: config.ollamaBaseUrl,
    defaultModel: config.defaultModel,
  };
  const server = new JarvisWebServer(webOptions);
  try {
    await startWebServer(server, port);
  } catch (err: unknown) {
    logger.error(errorMessage(err));
    await launcher.close();
    process.exit(1);
  }
  console.log(`Web chat available at: http://localhost:${port}\n`);
  console.log('Press Ctrl+C to stop the server.\n');

  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    console.log('\n[JarvisWebServer] Gracefully shutting down...');
    try {
      await server.stop();
    } catch (err: unknown) {
      logger.warn(`[JarvisWebServer] Stopping the server failed: ${errorMessage(err)}`);
    }
    await launcher.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err: unknown) => {
  logger.error(`Fatal error in Web Server: ${errorMessage(err)}`);
  process.exit(1);
});
