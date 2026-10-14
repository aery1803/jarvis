import { DocumentStore, Collection } from '../storage/collection.js';
import { SessionManager } from '../sessions/manager.js';
import { newestFirst } from '../utils/ordering.js';

export interface AuditLogEntry {
  _id?: string;
  id: string;
  timestamp: string;
  eventType: 'KILL_SWITCH_TRIGGERED' | 'KILL_SWITCH_RESET' | 'ACTION_APPROVED' | 'ACTION_REJECTED' | 'TASK_ABORTED' | 'AUTH_FAILURE';
  actor: string;
  details?: Record<string, unknown>;
}

export class KillSwitch {
  private static instance: KillSwitch | null = null;
  private killed = false;
  private killReason = '';
  private auditCollection: Collection<AuditLogEntry>;

  constructor(
    private store: DocumentStore,
    private sessionManager?: SessionManager
  ) {
    this.auditCollection = this.store.getCollection<AuditLogEntry>('audit_log');
    KillSwitch.instance = this;
  }

  static getInstance(): KillSwitch | null {
    return KillSwitch.instance;
  }

  isKilled(): boolean {
    return this.killed;
  }

  getKillReason(): string {
    return this.killReason;
  }

  async trigger(actor: string, reason = 'Emergency stop triggered'): Promise<{ tasksAborted: number }> {
    this.killed = true;
    this.killReason = reason;

    let tasksAborted = 0;
    if (this.sessionManager) {
      tasksAborted = await this.sessionManager.cancelAllActiveTasks(reason);
    }

    await this.logAudit({
      eventType: 'KILL_SWITCH_TRIGGERED',
      actor,
      details: { reason, tasksAborted },
    });

    return { tasksAborted };
  }

  async reset(actor: string): Promise<void> {
    this.killed = false;
    this.killReason = '';

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
