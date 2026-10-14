/**
 * Jarvis Local AI Agent: Unified Master Launcher
 * Starts Web Chat, Telegram Bot, and the read-only board monitor in a single command, all on ONE shared runtime
 * (one store, one kill switch, one approval broker, one model registry).
 */

import os from 'node:os';
import { JarvisWebServer, installProcessGuard } from '../web/server.js';
import { BoardWatcher } from '../devagent/board-watcher.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { createBoardPoller } from './board-poller.js';
import { createLauncherRuntime, errorMessage, importLegacyChat, resolveWebPort, startTelegram, startWebServer, type TelegramStart } from './bootstrap.js';

async function startAll(): Promise<void> {
  installProcessGuard();
  console.log('\n======================================================');
  console.log('              JARVIS LOCAL AI AGENT - MASTER LAUNCHER   ');
  console.log('======================================================\n');

  // 1. Host health baseline
  const freeRamGb = (os.freemem() / (1024 * 1024 * 1024)).toFixed(1);
  const totalRamGb = (os.totalmem() / (1024 * 1024 * 1024)).toFixed(1);
  console.log(`[Host] ${os.hostname()} (${os.platform()}) | host RAM: ${freeRamGb} GB free / ${totalRamGb} GB total`);

  // 2. One runtime for every surface
  const launcher = await createLauncherRuntime();
  const { rt, dataDir, ownerId } = launcher;
  const status = rt.getStatus();
  console.log(`[Runtime] Ready: ${status.toolCount} tools, default model ${config.defaultModel}, Ollama: ${status.inventory.status}`);
  for (const issue of status.issues) console.log(`[Runtime] Issue: ${issue}`);

  // 3. Web chat. It shares the runtime's sessions, memory and kill switch with the Telegram bot.
  await importLegacyChat(rt, dataDir);
  const webPort = resolveWebPort();
  const webOptions = {
    port: webPort,
    runtime: rt,
    sessionManager: rt.sessions,
    memoryManager: rt.memory,
    userId: rt.ownerUserId,
    killSwitch: rt.killSwitch,
    ollamaBaseUrl: config.ollamaBaseUrl,
    defaultModel: config.defaultModel,
  };
  const webServer = new JarvisWebServer(webOptions);
  try {
    await startWebServer(webServer, webPort);
  } catch (err: unknown) {
    logger.error(`[Web] ${errorMessage(err)}`);
    await launcher.close();
    process.exit(1);
  }
  console.log(`[1/3] Web Chat UI:     online at http://localhost:${webPort}`);

  // 4. Telegram bot
  let telegram: TelegramStart | null = null;
  try {
    telegram = await startTelegram(rt, ownerId);
    console.log(
      telegram
        ? `[2/3] Telegram Bot:    online as ${telegram.summary}`
        : '[2/3] Telegram Bot:    skipped (no token in TELEGRAM_BOT_TOKEN, TELEGRAM_DEV_TOKEN or Credential Manager jarvis-telegram-dev)'
    );
  } catch (err: unknown) {
    logger.error(`[TelegramBot] ${errorMessage(err)}`);
    console.log('[2/3] Telegram Bot:    NOT started (see the error above)');
  }

  // 5. Board monitor: every poll goes through the Action Gateway (BOARD_POLL) and stops with the kill switch.
  // It only reads the board and logs what changed; nothing here acts on a card.
  const boardWatcher = new BoardWatcher({ registry: rt.ownActions, gateway: rt.gateway });
  const poller = createBoardPoller({
    watcher: boardWatcher,
    killSwitch: rt.killSwitch,
    intervalMs: config.pollingIntervalMs,
    onChange: (changes) => {
      for (const change of changes) {
        const label = `#${change.issueNumber ?? '?'} "${change.title}"`;
        if (change.kind === 'new') logger.info(`[BoardMonitor] New card ${label} in ${change.to ?? 'an unknown column'}.`);
        else if (change.kind === 'moved') logger.info(`[BoardMonitor] Card ${label} moved from ${change.from ?? 'unknown'} to ${change.to ?? 'unknown'}.`);
        else logger.info(`[BoardMonitor] Card ${label} is no longer on the board.`);
      }
    },
  });
  console.log(`[3/3] Board monitor:   read-only for GitHub Project #${config.projectNumber} (every ${config.pollingIntervalMs / 1000}s); it does not act on cards.`);
  const cards = await poller.pollOnce();
  console.log(
    cards === null
      ? '      Initial board poll did not complete (see the log).'
      : `      Board monitor: read-only, ${cards} cards on Project Board #${config.projectNumber}; it does not act on cards.`
  );
  poller.start();

  console.log('\n------------------------------------------------------');
  console.log(' Jarvis services are running together.');
  console.log(` - Chat in the browser: http://localhost:${webPort}`);
  console.log(' - Create cards:        https://github.com/users/aery1803/projects/2');
  console.log(' Press Ctrl+C at any time to stop all services.');
  console.log('------------------------------------------------------\n');

  // Graceful shutdown: stop taking work, let in-flight updates finish briefly, then close everything.
  let isShuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log('\n[Jarvis Master] Stopping all services cleanly...');
    const steps: Array<[string, () => Promise<void>]> = [
      ['board watcher', () => poller.stop()],
      ['telegram bot', async () => void (await telegram?.bot.stop())],
      ['web server', () => webServer.stop()],
      ['runtime', () => launcher.close()],
    ];
    for (const [name, stop] of steps) {
      try {
        await stop();
      } catch (err: unknown) {
        logger.warn(`[Jarvis Master] Stopping the ${name} failed: ${errorMessage(err)}`);
      }
    }
    console.log('[Jarvis Master] All services halted. Good bye!\n');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGUSR2', () => void shutdown());
}

startAll().catch((err: unknown) => {
  logger.error(`Fatal error in Master Launcher: ${errorMessage(err)}`);
  process.exit(1);
});
