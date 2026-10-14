/**
 * Jarvis Local AI Agent: Dev Agent CLI Entry Point
 * Authority: Section 17.10, 17.12
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { OwnActionRegistry } from './action-registry.js';
import { ActionGateway } from './action-gateway.js';
import { BoardWatcher } from './board-watcher.js';
import { config } from '../config.js';
import { DocumentStore } from '../storage/collection.js';
import { KillSwitch } from '../security/kill-switch.js';
import { logger } from '../utils/logger.js';

async function main() {
  const args = process.argv.slice(2);
  const isWatch = args.includes('--watch');
  const isStatus = args.includes('--status');
  const isNow = args.includes('--now') || (!isWatch && !isStatus);

  logger.info('=== Jarvis Local AI Dev Agent (Phase 0b Bootstrap Engine) ===');
  logger.info(`Host OS: ${os.type()} ${os.release()} (${os.arch()})`);
  const freeGb = (os.freemem() / (1024 * 1024 * 1024)).toFixed(2);
  const totalGb = (os.totalmem() / (1024 * 1024 * 1024)).toFixed(2);
  logger.info(`Memory Baseline: ${freeGb} GB free / ${totalGb} GB total`);

  const registry = new OwnActionRegistry(config.databasePath);
  // The kill state lives in the shared document store; opening it here is what makes /kill from Telegram or the web
  // stop this watcher too (`KillSwitch` re-reads the persisted row about once a second).
  const dataDir = path.resolve(process.cwd(), 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const killStore = new DocumentStore(path.join(dataDir, 'jarvis.db'));
  const killSwitch = new KillSwitch(killStore);
  const gateway = new ActionGateway(registry, {
    minFreeMemoryBytes: config.minFreeMemoryBytes,
    killSwitch,
  });
  const watcher = new BoardWatcher({ registry, gateway });

  if (isStatus) {
    const actions = registry.getAllActions();
    logger.info(`Own-Action Registry Records: ${actions.length}`);
    for (const act of actions.slice(-5)) {
      logger.info(` - [${act.createdAt}] ${act.actionType} on ${act.targetId} (ID: ${act.id})`);
    }
    registry.close();
    killStore.close();
    return;
  }

  const pollCycle = async () => {
    if (killSwitch.isKilled()) {
      logger.warn(`[BoardWatcher] Kill switch engaged (${killSwitch.getKillReason() || 'emergency stop'}); skipping this polling cycle.`);
      return;
    }
    logger.info(`[BoardWatcher] Starting polling cycle for Board #${config.projectNumber}...`);
    try {
      const items = await watcher.pollBoard();
      logger.info(`[BoardWatcher] Found ${items.length} total items on board.`);

      for (const item of items) {
        logger.info(`  • Issue #${item.issueNumber} [${item.status}] [Type: ${item.ticketType ?? 'N/A'}] - "${item.title}"`);
      }
    } catch (err: any) {
      logger.error(`[BoardWatcher] Error during polling cycle: ${err.message}`);
    }
  };

  if (isNow) {
    await pollCycle();
    registry.close();
    killStore.close();
    return;
  }

  if (isWatch) {
    logger.info(`[BoardWatcher] Entering watch mode (interval: ${config.pollingIntervalMs / 1000}s). Press Ctrl+C to stop.`);
    await pollCycle();

    const interval = setInterval(async () => {
      await pollCycle();
    }, config.pollingIntervalMs);

    process.on('SIGINT', () => {
      logger.info('\n[BoardWatcher] Shutting down watcher gracefully...');
      clearInterval(interval);
      registry.close();
      killStore.close();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  logger.error(`Fatal error in Dev Agent: ${err.message}`, { stack: err.stack });
  process.exit(1);
});
