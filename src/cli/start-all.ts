/**
 * Jarvis Local AI Agent: Unified Master Launcher
 * Starts Web Chat, Telegram Bot, and Dev Agent Watcher in a single command.
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { JarvisWebServer } from '../web/server.js';
import { TelegramBotClient } from '../telegram/bot.js';
import { getTelegramToken, getTelegramOwnerId } from '../security/credentials.js';
import { DocumentStore } from '../storage/collection.js';
import { SessionManager } from '../sessions/manager.js';
import { MemoryManager } from '../memory/manager.js';
import { KillSwitch } from '../security/kill-switch.js';
import { OllamaProvider } from '../services/provider.js';
import { OwnActionRegistry } from '../devagent/action-registry.js';
import { ActionGateway } from '../devagent/action-gateway.js';
import { BoardWatcher } from '../devagent/board-watcher.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

async function startAll(): Promise<void> {
  console.log('\n======================================================');
  console.log('       ⚡ JARVIS LOCAL AI AGENT - MASTER LAUNCHER ⚡    ');
  console.log('       Private Autonomous AI on ASUS ROG Flow Z13      ');
  console.log('======================================================\n');

  const dataDir = path.resolve(process.cwd(), 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // 1. Host Health Baseline
  const freeRamGb = (os.freemem() / (1024 * 1024 * 1024)).toFixed(1);
  const totalRamGb = (os.totalmem() / (1024 * 1024 * 1024)).toFixed(1);
  console.log(`[Host] ${os.hostname()} (${os.platform()}) | RAM: ${freeRamGb} GB free / ${totalRamGb} GB total`);

  // 2. Initialize Shared Storage & Services
  const dbPath = path.join(dataDir, 'jarvis.db');
  const store = new DocumentStore(dbPath);
  const sessionManager = new SessionManager(store);
  const memoryManager = new MemoryManager(store);
  const killSwitch = new KillSwitch(store, sessionManager);
  const llmProvider = new OllamaProvider({
    baseUrl: config.ollamaBaseUrl,
    model: 'qwen2.5:7b',
  });

  // 3. Start Local Web Workstation
  // The web chat shares `memoryManager` with the Telegram bot and writes under the Telegram owner ID,
  // so the owner profile and session summaries are one memory across both surfaces.
  const ownerId = getTelegramOwnerId();
  const webPort = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 3000;
  const webServer = new JarvisWebServer({ port: webPort, memoryManager, userId: ownerId || 'owner' });
  await webServer.start();
  console.log(`[1/3] 🌐 Web Chat UI:     Online at http://localhost:${webPort}`);

  // 4. Start Telegram Bot Daemon
  const telegramToken = getTelegramToken('jarvis-telegram-dev');
  let bot: TelegramBotClient | null = null;

  if (telegramToken) {
    bot = new TelegramBotClient({
      token: telegramToken,
      ownerId,
      sessionManager,
      memoryManager,
      killSwitch,
      llmProvider,
    });
    // Start polling in background
    bot.startPolling(1000).catch((err) => {
      logger.warn(`[TelegramBot] Polling error: ${err.message}`);
    });
    const authStatus = ownerId ? `Strict (Owner ID: ${ownerId})` : 'Dev Mode (Open)';
    console.log(`[2/3] 📱 Telegram Bot:    Online (@aery_jarvis_dev_bot) [${authStatus}]`);
  } else {
    console.log('[2/3] 📱 Telegram Bot:    Skipped (No token in Credential Manager jarvis-telegram-dev)');
  }

  // 5. Start GitHub Dev Agent Board Watcher
  const actionRegistry = new OwnActionRegistry(config.databasePath);
  const actionGateway = new ActionGateway(actionRegistry, {
    minFreeMemoryBytes: config.minFreeMemoryBytes,
  });
  const boardWatcher = new BoardWatcher({
    registry: actionRegistry,
    gateway: actionGateway,
  });

  console.log(`[3/3] 🤖 Dev Agent Watch: Armed for GitHub Project #${config.projectNumber} (every ${config.pollingIntervalMs / 1000}s)`);

  // Initial Poll Cycle
  try {
    const items = await boardWatcher.pollBoard();
    console.log(`      Found ${items.length} cards on Project Board #2.`);
  } catch (err: any) {
    logger.warn(`[BoardWatcher] Initial poll: ${err.message}`);
  }

  // Background watch interval
  const watcherInterval = setInterval(async () => {
    try {
      await boardWatcher.pollBoard();
    } catch (err: any) {
      logger.warn(`[BoardWatcher] Poll cycle: ${err.message}`);
    }
  }, config.pollingIntervalMs);

  console.log('\n------------------------------------------------------');
  console.log(' All Jarvis services are running together!');
  console.log(' - Open chat in browser: http://localhost:' + webPort);
  console.log(' - Open chat on phone:   https://t.me/aery_jarvis_dev_bot');
  console.log(' - Create cards:         https://github.com/users/aery1803/projects/2');
  console.log(' Press Ctrl+C at any time to stop all services.');
  console.log('------------------------------------------------------\n');

  // Graceful Shutdown
  let isShuttingDown = false;
  const shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log('\n[Jarvis Master] Stopping all services cleanly...');
    clearInterval(watcherInterval);
    if (bot) {
      bot.stopPolling();
    }
    await webServer.stop();
    actionRegistry.close();
    store.close();
    console.log('[Jarvis Master] All services halted. Good bye!\n');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGUSR2', shutdown);
}

startAll().catch((err) => {
  logger.error(`Fatal error in Master Launcher: ${err.message}`);
  process.exit(1);
});
