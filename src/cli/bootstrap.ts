/**
 * Jarvis Local AI Agent: shared launcher bootstrap
 *
 * `start-all.ts`, `web.ts` and `telegram.ts` all build the same runtime and talk to the same stores, so the
 * pieces they share live here: one `createRuntime` call, the legacy chat import, the web server start with a
 * readable error for a busy port, and the Telegram bot start.
 */

import path from 'node:path';
import fs from 'node:fs';
import { createRuntime, type JarvisRuntime } from '../runtime/runtime.js';
import { DEFAULT_CHAT_USER_ID } from '../storage/chat-store.js';
import { migrateLegacyChatDb } from '../storage/chat-migration.js';
import { OwnActionRegistry } from '../devagent/action-registry.js';
import { getTelegramOwnerId, getTelegramToken } from '../security/credentials.js';
import { TelegramBotClient, TelegramApiError, isTelegramOpenDevEnabled } from '../telegram/bot.js';
import type { JarvisWebServer } from '../web/server.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const WEB_START_ATTEMPTS = 5;
const WEB_START_RETRY_MS = 2_000;

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function resolveDataDir(): string {
  const dataDir = path.resolve(process.cwd(), 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  return dataDir;
}

export function resolveWebPort(): number {
  const parsed = Number.parseInt(process.env.PORT ?? '', 10);
  return Number.isInteger(parsed) && parsed >= 0 && parsed < 65536 ? parsed : 3000;
}

export interface LauncherRuntime {
  rt: JarvisRuntime;
  dataDir: string;
  /** The Telegram owner id; empty when unconfigured. */
  ownerId: string;
  /** Closes the runtime and anything the launcher opened for it (an action registry passed in explicitly). */
  close(): Promise<void>;
}

export interface LauncherRuntimeOptions {
  /**
   * False for a launcher that may start while another Jarvis process uses the same `data/jarvis.db` (a separately
   * launched web or Telegram process): startup would otherwise cancel that process's live tasks as "interrupted by
   * restart". Only the single owner process (`start-all`) keeps the default.
   */
  reconcileInterruptedTasks?: boolean;
}

/** Builds the one runtime every surface shares. Sessions and memory are stored under the Telegram owner id (or the web default). */
export async function createLauncherRuntime(options: LauncherRuntimeOptions = {}): Promise<LauncherRuntime> {
  const dataDir = resolveDataDir();
  const ownerId = getTelegramOwnerId();
  // The runtime opens `<dataDir>/devagent.db` itself; `JARVIS_DB_PATH` pointing elsewhere must still be honoured.
  const defaultActionsPath = path.join(dataDir, 'devagent.db');
  const ownActions = path.resolve(config.databasePath) === defaultActionsPath ? undefined : new OwnActionRegistry(config.databasePath);
  const rt = await createRuntime({
    dataDir,
    ollamaBaseUrl: config.ollamaBaseUrl,
    ownerUserId: ownerId || DEFAULT_CHAT_USER_ID,
    ownActions,
    ...(options.reconcileInterruptedTasks === undefined ? {} : { reconcileInterruptedTasks: options.reconcileInterruptedTasks }),
  });
  return {
    rt,
    dataDir,
    ownerId,
    close: async () => {
      await rt.close();
      // The runtime closes only what it opened itself.
      try {
        ownActions?.close();
      } catch (err: unknown) {
        logger.warn(`[Launcher] Closing the action registry failed: ${errorMessage(err)}`);
      }
    },
  };
}

/** Imports the legacy `data/chat.db` once; a failure is logged and retried on the next start. */
export async function importLegacyChat(rt: JarvisRuntime, dataDir: string): Promise<void> {
  try {
    await migrateLegacyChatDb({ legacyDbPath: path.join(dataDir, 'chat.db'), store: rt.store, sessionManager: rt.sessions, userId: rt.ownerUserId });
  } catch (err: unknown) {
    logger.error(`[ChatMigration] data/chat.db import failed; it is retried on the next start: ${errorMessage(err)}`);
  }
}

/** A previous instance can still hold the port for a moment after nodemon restarts the launcher, so a busy port is retried. */
export async function startWebServer(server: Pick<JarvisWebServer, 'start'>, port: number, retryDelayMs = WEB_START_RETRY_MS): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await server.start();
      return;
    } catch (err: unknown) {
      const message = errorMessage(err);
      const busy = /already in use|EADDRINUSE/i.test(message);
      if (!busy) {
        throw new Error(`Could not start the web server on port ${port}: ${message}`);
      }
      if (attempt >= WEB_START_ATTEMPTS) {
        throw new Error(`Port ${port} is already in use by another program. Stop it, or choose another port with the PORT environment variable.`);
      }
      logger.warn(`[Web] Port ${port} is busy. Retrying in ${retryDelayMs / 1000}s (${attempt}/${WEB_START_ATTEMPTS})...`);
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
}

export interface TelegramStart {
  bot: TelegramBotClient;
  /** What to print about the bot: its username, or why it could not be verified. */
  summary: string;
}

/** Starts the Telegram bot when a token exists; null when it does not. Polling runs in the background. */
export async function startTelegram(rt: JarvisRuntime, ownerId: string, options: { token?: string; fetchImpl?: typeof fetch } = {}): Promise<TelegramStart | null> {
  const token = options.token ?? getTelegramToken('jarvis-telegram-dev');
  if (!token) return null;

  const openDev = isTelegramOpenDevEnabled();
  const bot = new TelegramBotClient({ token, ownerId, runtime: rt, allowOpenDev: openDev, fetchImpl: options.fetchImpl });
  const mode = ownerId ? `owner ${ownerId} only` : openDev ? 'OPEN DEV MODE: every Telegram user is served, approvals disabled' : 'no TELEGRAM_OWNER_ID: refusing everyone except /id';

  let username = '';
  try {
    const me = await bot.apiCall<{ username?: string }>('getMe');
    username = me.username ? `@${me.username}` : 'bot';
  } catch (err: unknown) {
    if (err instanceof TelegramApiError && (err.errorCode === 401 || err.errorCode === 404)) {
      throw new Error(`Telegram rejected the bot token (${err.message}). The bot was not started.`);
    }
    logger.warn(`[TelegramBot] Could not reach Telegram yet (${errorMessage(err)}); polling keeps retrying.`);
    username = 'bot (not verified yet)';
  }

  bot.startPolling().catch((err: unknown) => logger.error(`[TelegramBot] Polling loop ended unexpectedly: ${errorMessage(err)}`));
  return { bot, summary: `${username} [${mode}]` };
}
