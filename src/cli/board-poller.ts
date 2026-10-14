/**
 * Jarvis Local AI Agent: Dev Agent board poll loop
 *
 * Polls the GitHub Project board on a fixed delay. Each cycle waits for the previous one to finish (no
 * overlapping `gh` calls), is skipped while the kill switch is engaged, and the poll itself goes through the
 * Action Gateway as `BOARD_POLL`.
 */

import { logger } from '../utils/logger.js';

export interface BoardChange {
  kind: 'new' | 'moved' | 'removed';
  itemId: string;
  title: string;
  issueNumber?: number;
  /** The column before a move; absent for a new card. */
  from?: string;
  /** The column now; absent for a removed card. */
  to?: string;
}

interface CardSnapshot {
  title: string;
  issueNumber?: number;
  status?: string;
}

function snapshotOf(items: unknown[]): Map<string, CardSnapshot> {
  const cards = new Map<string, CardSnapshot>();
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue;
    const card = item as { itemId?: unknown; title?: unknown; issueNumber?: unknown; status?: unknown };
    if (typeof card.itemId !== 'string' || card.itemId === '') continue;
    cards.set(card.itemId, {
      title: typeof card.title === 'string' ? card.title : '',
      issueNumber: typeof card.issueNumber === 'number' ? card.issueNumber : undefined,
      status: typeof card.status === 'string' ? card.status : undefined,
    });
  }
  return cards;
}

/** What differs between two polls: cards that appeared, moved column or disappeared. Nothing is inferred beyond that. */
export function diffBoard(previous: Map<string, CardSnapshot>, next: Map<string, CardSnapshot>): BoardChange[] {
  const changes: BoardChange[] = [];
  for (const [itemId, card] of next) {
    const before = previous.get(itemId);
    if (!before) changes.push({ kind: 'new', itemId, title: card.title, issueNumber: card.issueNumber, to: card.status });
    else if (before.status !== card.status) changes.push({ kind: 'moved', itemId, title: card.title, issueNumber: card.issueNumber, from: before.status, to: card.status });
  }
  for (const [itemId, card] of previous) {
    if (!next.has(itemId)) changes.push({ kind: 'removed', itemId, title: card.title, issueNumber: card.issueNumber, from: card.status });
  }
  return changes;
}

export interface BoardPollerOptions {
  /** Called with the differences from the previous successful poll (never for the first poll, which is only the baseline). */
  onChange?: (changes: BoardChange[]) => void;
  watcher: { pollBoard(): Promise<unknown[]> };
  killSwitch: { isKilled(): boolean };
  intervalMs: number;
  /** Test seam; defaults to the global timers. */
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
}

export interface BoardPoller {
  /** Runs one cycle now and resolves when it is finished. Returns the number of cards, or null if it was skipped or failed. */
  pollOnce(): Promise<number | null>;
  /** Starts the repeating cycle (the first cycle runs after `intervalMs`). */
  start(): void;
  /** Stops the loop and waits for a cycle that is already running. */
  stop(): Promise<void>;
}

export function createBoardPoller(options: BoardPollerOptions): BoardPoller {
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<number | null> | null = null;
  let stopped = true;
  let previous: Map<string, CardSnapshot> | null = null;

  const pollOnce = (): Promise<number | null> => {
    if (running) return running;
    running = (async (): Promise<number | null> => {
      if (options.killSwitch.isKilled()) {
        logger.warn('[BoardWatcher] Kill switch engaged; skipping the board poll.');
        return null;
      }
      try {
        const items = await options.watcher.pollBoard();
        const current = snapshotOf(items);
        if (previous !== null) {
          const changes = diffBoard(previous, current);
          if (changes.length > 0) options.onChange?.(changes);
        }
        previous = current;
        return items.length;
      } catch (err: unknown) {
        logger.warn(`[BoardWatcher] Poll cycle: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    })().finally(() => {
      running = null;
    });
    return running;
  };

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimer(() => {
      timer = null;
      void pollOnce().finally(schedule);
    }, options.intervalMs);
    timer.unref?.();
  };

  return {
    pollOnce,
    start() {
      if (!stopped) return;
      stopped = false;
      schedule();
    },
    async stop() {
      stopped = true;
      if (timer) {
        clearTimer(timer);
        timer = null;
      }
      await running?.catch(() => undefined);
    },
  };
}
