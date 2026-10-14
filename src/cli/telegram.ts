import { config } from '../config.js';
import { createLauncherRuntime, errorMessage, startTelegram } from './bootstrap.js';

async function main(): Promise<void> {
  console.log('[Jarvis Telegram Service] Bootstrapping...');

  const launcher = await createLauncherRuntime({ reconcileInterruptedTasks: false });
  const { rt, ownerId } = launcher;
  console.log(`[Jarvis Telegram Service] Runtime ready, default model ${config.defaultModel}, Ollama: ${rt.getStatus().inventory.status}`);

  const telegram = await startTelegram(rt, ownerId);
  if (!telegram) {
    console.error('[Jarvis Telegram Service] FATAL: no Telegram token (TELEGRAM_BOT_TOKEN, TELEGRAM_DEV_TOKEN or Credential Manager jarvis-telegram-dev).');
    await launcher.close();
    process.exit(1);
  }
  if (ownerId) {
    console.log(`[Jarvis Telegram Service] Allow-list armed for owner Telegram ID ${ownerId}.`);
  } else {
    console.log('[Jarvis Telegram Service] WARNING: TELEGRAM_OWNER_ID is not configured. The bot refuses everyone except /id (unless JARVIS_TELEGRAM_OPEN=1 is set for development).');
  }
  console.log(`[Jarvis Telegram Service] Online as ${telegram.summary}. Long polling started.`);

  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    console.log('\n[Jarvis Telegram Service] Stopping long polling and exiting cleanly...');
    try {
      await telegram.bot.stop();
    } catch (err: unknown) {
      console.error(`[Jarvis Telegram Service] Stopping the bot failed: ${errorMessage(err)}`);
    }
    await launcher.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err: unknown) => {
  console.error('[Jarvis Telegram Service] Fatal error:', errorMessage(err));
  process.exit(1);
});
