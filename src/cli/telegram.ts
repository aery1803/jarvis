import path from 'node:path';
import fs from 'node:fs';
import { TelegramBotClient } from '../telegram/bot.js';
import { getTelegramToken, getTelegramOwnerId } from '../security/credentials.js';
import { DocumentStore } from '../storage/collection.js';
import { MemoryManager } from '../memory/manager.js';
import { SessionManager } from '../sessions/manager.js';
import { KillSwitch } from '../security/kill-switch.js';
import { OllamaProvider } from '../services/provider.js';

async function main(): Promise<void> {
  console.log('[Jarvis Telegram Service] Bootstrapping Phase 2 Bot...');

  const token = getTelegramToken('jarvis-telegram-dev');
  if (!token) {
    console.error('[Jarvis Telegram Service] FATAL: Missing Telegram dev token in Windows Credential Manager (jarvis-telegram-dev).');
    process.exit(1);
  }

  const ownerId = getTelegramOwnerId();
  if (ownerId) {
    console.log(`[Jarvis Telegram Service] Strict allow-list armed for Owner Telegram ID: ${ownerId}`);
  } else {
    console.log('[Jarvis Telegram Service] WARNING: TELEGRAM_OWNER_ID not configured in settings.env; running in open dev mode.');
  }

  const dataDir = path.resolve(process.cwd(), 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const dbPath = path.join(dataDir, 'jarvis.db');
  const store = new DocumentStore(dbPath);
  const sessionManager = new SessionManager(store);
  const memoryManager = new MemoryManager(store);
  const killSwitch = new KillSwitch(store, sessionManager);
  const llmProvider = new OllamaProvider({ model: 'qwen2.5:7b' });

  const bot = new TelegramBotClient({
    token,
    ownerId,
    sessionManager,
    memoryManager,
    killSwitch,
    llmProvider,
  });

  const shutdown = (): void => {
    console.log('\n[Jarvis Telegram Service] Stopping long polling and exiting cleanly...');
    bot.stopPolling();
    store.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log('[Jarvis Telegram Service] Bot connected. Starting outbound long polling...');
  await bot.startPolling(1000);
}

main().catch((err) => {
  console.error('[Jarvis Telegram Service] Uncaught error:', err);
  process.exit(1);
});
