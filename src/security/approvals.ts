/**
 * Jarvis Local AI Agent: Owner Approval Broker
 * Authority: Section 6.2 (Tier 2 requires explicit owner approval each time), CODING_RULES.md section 5
 *
 * Transport-agnostic: the Telegram bot registers a notifier that shows the request to the owner and calls
 * `resolve()` when the owner taps approve/deny. With no notifier nothing can reach the owner, so every
 * request is denied.
 */

import crypto from 'node:crypto';
import { logger } from '../utils/logger.js';

export interface ApprovalRequest {
  id: string;
  actionType: string;
  description: string;
  tier: 1 | 2 | 3;
  requestedBy: string;
  metadata?: Record<string, unknown>;
}

export interface ApprovalDecision {
  approved: boolean;
  decidedBy?: string;
  reason?: string;
}

export interface ApprovalAuditEvent {
  type: 'requested' | 'approved' | 'denied' | 'timeout' | 'no_notifier' | 'notify_failed' | 'rejected_tier3' | 'duplicate_id';
  request: ApprovalRequest;
  decision?: ApprovalDecision;
  at: string;
}

export interface ApprovalBrokerOptions {
  timeoutMs?: number;
  audit?: (event: ApprovalAuditEvent) => Promise<void> | void;
}

export type ApprovalNotifier = (request: ApprovalRequest) => Promise<void>;

export const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

interface PendingEntry {
  request: ApprovalRequest;
  settle: (decision: ApprovalDecision) => void;
  timer: NodeJS.Timeout;
}

export class ApprovalBroker {
  private readonly timeoutMs: number;
  private readonly auditSink?: (event: ApprovalAuditEvent) => Promise<void> | void;
  private notifier: ApprovalNotifier | null = null;
  private readonly entries = new Map<string, PendingEntry>();

  constructor(options: ApprovalBrokerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    this.auditSink = options.audit;
  }

  public setNotifier(notifier: ApprovalNotifier): void {
    this.notifier = notifier;
  }

  public hasNotifier(): boolean {
    return this.notifier !== null;
  }

  /**
   * Resolves on the owner's decision. Denies on timeout, when no notifier is registered, when the notifier
   * throws, or for Tier 3 (never approvable).
   */
  public request(input: Omit<ApprovalRequest, 'id'> & { id?: string }): Promise<ApprovalDecision> {
    const request: ApprovalRequest = { ...input, id: input.id ?? crypto.randomUUID() };

    if (request.tier === 3) {
      return this.denyNow(request, 'rejected_tier3', 'Tier 3 actions are never approvable autonomously.');
    }
    if (this.entries.has(request.id)) {
      return this.denyNow(request, 'duplicate_id', 'An approval request with this id is already pending.');
    }
    const notifier = this.notifier;
    if (!notifier) {
      return this.denyNow(request, 'no_notifier', 'No approval channel is configured, so the owner cannot be asked.');
    }

    return new Promise<ApprovalDecision>((resolve) => {
      const settle = (decision: ApprovalDecision): void => {
        const entry = this.entries.get(request.id);
        if (!entry) {
          return;
        }
        clearTimeout(entry.timer);
        this.entries.delete(request.id);
        resolve(decision);
      };

      const timer = setTimeout(() => {
        const decision = { approved: false, reason: `Approval timed out after ${this.timeoutMs} ms.` };
        if (this.entries.has(request.id)) {
          settle(decision);
          this.emit({ type: 'timeout', request, decision });
        }
      }, this.timeoutMs);
      timer.unref();

      this.entries.set(request.id, { request, settle, timer });
      this.emit({ type: 'requested', request });

      // Registered before notifying: the owner's reply can arrive before `notifier()` returns.
      Promise.resolve()
        .then(() => notifier(request))
        .catch((err: unknown) => {
          if (this.entries.has(request.id)) {
            const message = err instanceof Error ? err.message : String(err);
            const decision = { approved: false, reason: `Could not notify the owner: ${message}` };
            settle(decision);
            this.emit({ type: 'notify_failed', request, decision });
          }
        });
    });
  }

  /** False when the id is unknown, expired or already resolved. */
  public resolve(id: string, approved: boolean, decidedBy: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) {
      return false;
    }
    const decision: ApprovalDecision = { approved, decidedBy, reason: approved ? 'Approved by owner.' : 'Denied by owner.' };
    entry.settle(decision);
    this.emit({ type: approved ? 'approved' : 'denied', request: entry.request, decision });
    return true;
  }

  public pending(): ApprovalRequest[] {
    return Array.from(this.entries.values()).map((e) => ({ ...e.request }));
  }

  /** Denies every pending request (kill switch, shutdown). Returns how many were denied. */
  public denyAll(reason: string): number {
    const all = Array.from(this.entries.values());
    for (const entry of all) {
      const decision: ApprovalDecision = { approved: false, reason };
      entry.settle(decision);
      this.emit({ type: 'denied', request: entry.request, decision });
    }
    return all.length;
  }

  private denyNow(request: ApprovalRequest, type: ApprovalAuditEvent['type'], reason: string): Promise<ApprovalDecision> {
    const decision: ApprovalDecision = { approved: false, reason };
    this.emit({ type, request, decision });
    return Promise.resolve(decision);
  }

  private emit(event: Omit<ApprovalAuditEvent, 'at'>): void {
    if (!this.auditSink) {
      return;
    }
    try {
      const out = this.auditSink({ ...event, at: new Date().toISOString() });
      if (out && typeof (out as Promise<void>).catch === 'function') {
        (out as Promise<void>).catch((err: unknown) => {
          logger.warn(`[ApprovalBroker] Audit sink failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    } catch (err) {
      logger.warn(`[ApprovalBroker] Audit sink failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
