import { DocumentStore, Collection } from '../storage/collection.js';
import { SessionManager } from '../sessions/manager.js';
import { newestFirst } from '../utils/ordering.js';
import { logger } from '../utils/logger.js';

export const KILL_SWITCH_STATE_COLLECTION = 'kill_switch_state';
const KILL_SWITCH_STATE_ID = 'state';

interface KillSwitchStateDoc {
  id: string;
  killed: boolean;
  reason: string;
  actor: string;
  updatedAt: string;
}

export interface KillTriggerInfo {
  actor: string;
  reason: string;
}

export type KillTriggerListener = (info: KillTriggerInfo) => void | Promise<void>;

export class KillSwitchEngagedError extends Error {
  constructor(public readonly reason: string) {
    super(`Kill switch engaged: ${reason || 'emergency stop'}. Owner must reset it before Jarvis acts.`);
    this.name = 'KillSwitchEngagedError';
  }
}

export interface AuditLogEntry {
  _id?: string;
  id: string;
  timestamp: string;
  eventType: 'KILL_SWITCH_TRIGGERED' | 'KILL_SWITCH_RESET' | 'ACTION_APPROVED' | 'ACTION_REJECTED' | 'TASK_ABORTED' | 'AUTH_FAILURE';
  actor: string;
  details?: Record<string, unknown>;
}

export interface KillSwitchOptions {
  /** How often `isKilled()` re-reads the persisted row so a /kill in another launcher is seen. Defaults to 1 s. */
  refreshMs?: number;
  /** Injected by tests so no real time passes. */
  now?: () => number;
}

export const DEFAULT_KILL_REFRESH_MS = 1000;

export class KillSwitch {
  private static instance: KillSwitch | null = null;
  private killed = false;
  private killReason = '';
  private auditCollection: Collection<AuditLogEntry>;
  private stateCollection: Collection<KillSwitchStateDoc>;
  private listeners = new Set<KillTriggerListener>();
  private readonly refreshMs: number;
  private readonly now: () => number;
  private lastSyncAt = 0;

  constructor(
    private store: DocumentStore,
    private sessionManager?: SessionManager,
    options: KillSwitchOptions = {}
  ) {
    this.refreshMs = options.refreshMs ?? DEFAULT_KILL_REFRESH_MS;
    this.now = options.now ?? Date.now;
    this.auditCollection = this.store.getCollection<AuditLogEntry>('audit_log');
    this.stateCollection = this.store.getCollection<KillSwitchStateDoc>(KILL_SWITCH_STATE_COLLECTION);
    // Loaded synchronously so a restart (nodemon, auto-pull) cannot silently re-arm Jarvis.
    const persisted = this.stateCollection.findOne({ id: KILL_SWITCH_STATE_ID });
    if (persisted?.killed) {
      this.killed = true;
      this.killReason = persisted.reason;
      logger.warn(`[KillSwitch] Restored engaged state from the document store: ${persisted.reason}`);
    }
    this.lastSyncAt = this.now();
    KillSwitch.instance = this;
  }

  static getInstance(): KillSwitch | null {
    return KillSwitch.instance;
  }

  /**
   * Web, Telegram and the board poller can run as separate processes sharing one store, so a /kill or /resume
   * from another launcher is picked up by re-reading the persisted row at most every `refreshMs`. That halts NEW
   * work here; work already running in this process is only aborted by a trigger made in this process, because
   * the abort controllers and approval requests live in memory.
   */
  private syncFromStore(): void {
    const at = this.now();
    if (at - this.lastSyncAt < this.refreshMs && at >= this.lastSyncAt) return;
    this.lastSyncAt = at;
    try {
      const persisted = this.stateCollection.findOne({ id: KILL_SWITCH_STATE_ID });
      if (!persisted) return;
      if (persisted.killed !== this.killed) {
        logger.warn(`[KillSwitch] Another process ${persisted.killed ? 'engaged' : 'reset'} the kill switch (${persisted.actor}).`);
      }
      this.killed = persisted.killed;
      this.killReason = persisted.killed ? persisted.reason : '';
    } catch (err) {
      // Keep the last known state: a transient read failure must not silently re-arm Jarvis.
      logger.error(`[KillSwitch] Could not re-read the persisted state: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  isKilled(): boolean {
    this.syncFromStore();
    return this.killed;
  }

  getKillReason(): string {
    this.syncFromStore();
    return this.killReason;
  }

  /** Throws `KillSwitchEngagedError` while engaged; call before any state-changing or model-driven work. */
  assertNotKilled(): void {
    this.syncFromStore();
    if (this.killed) {
      throw new KillSwitchEngagedError(this.killReason);
    }
  }

  /** Subscribers halt in-flight work (abort controllers, approval requests, SSE streams). Returns an unsubscribe function. */
  onTrigger(listener: KillTriggerListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async trigger(actor: string, reason = 'Emergency stop triggered'): Promise<{ tasksAborted: number }> {
    this.killed = true;
    this.killReason = reason;
    this.lastSyncAt = this.now();
    this.persist(true, reason, actor);

    const pending: Array<Promise<void>> = [];
    for (const listener of this.listeners) {
      try {
        const out = listener({ actor, reason });
        if (out instanceof Promise) {
          pending.push(out);
        }
      } catch (err) {
        logger.error(`[KillSwitch] Trigger listener threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    let tasksAborted = 0;
    if (this.sessionManager) {
      try {
        tasksAborted = await this.sessionManager.cancelAllActiveTasks(reason);
      } catch (err) {
        logger.error(`[KillSwitch] Cancelling active tasks failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const settled = await Promise.allSettled(pending);
    for (const outcome of settled) {
      if (outcome.status === 'rejected') {
        logger.error(`[KillSwitch] Trigger listener rejected: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`);
      }
    }

    await this.logAudit({
      eventType: 'KILL_SWITCH_TRIGGERED',
      actor,
      details: { reason, tasksAborted },
    });

    return { tasksAborted };
  }

  private persist(killed: boolean, reason: string, actor: string): void {
    try {
      this.stateCollection.insertOne({
        id: KILL_SWITCH_STATE_ID,
        killed,
        reason,
        actor,
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      logger.error(`[KillSwitch] Could not persist kill switch state: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async reset(actor: string): Promise<void> {
    this.killed = false;
    this.killReason = '';
    this.lastSyncAt = this.now();
    this.persist(false, '', actor);

    await this.logAudit({
      eventType: 'KILL_SWITCH_RESET',
      actor,
      details: { timestamp: new Date().toISOString() },
    });
  }

  async logAudit(entry: Omit<AuditLogEntry, 'id' | 'timestamp'>): Promise<AuditLogEntry> {
    const record: AuditLogEntry = {
      ...entry,
      id: `audit-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      timestamp: new Date().toISOString(),
    };
    await this.auditCollection.insertOne(record);
    return record;
  }

  /**
   * Newest first. Trigger and reset routinely land in the same millisecond, so ordering by timestamp alone
   * would let the superseded event be reported as the current one (see utils/ordering.ts).
   */
  async getRecentAuditLogs(limit = 20): Promise<AuditLogEntry[]> {
    const list = await this.auditCollection.find({});
    return newestFirst(list, (entry) => entry.timestamp).slice(0, limit);
  }
}
