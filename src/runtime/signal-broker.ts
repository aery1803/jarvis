/**
 * Jarvis Local AI Agent: Turn-Bound Approval Broker
 *
 * An approval requested for a turn must not outlive that turn. The wrapper denies its own pending request when the
 * turn's signal aborts (the Stop button, the kill switch, a tool timeout), and refuses to ask at all once the signal
 * is already aborted, so a late tap on an old prompt can never run an action nobody is waiting for.
 */

import crypto from 'node:crypto';
import { ApprovalBroker, type ApprovalDecision, type ApprovalRequest } from '../security/approvals.js';

export class SignalBoundBroker extends ApprovalBroker {
  constructor(
    private readonly inner: ApprovalBroker,
    private readonly turnSignal: AbortSignal | undefined
  ) {
    super();
  }

  override hasNotifier(): boolean {
    return this.inner.hasNotifier();
  }

  override request(input: Omit<ApprovalRequest, 'id'> & { id?: string }): Promise<ApprovalDecision> {
    const signal = this.turnSignal;
    if (signal?.aborted) return Promise.resolve({ approved: false, reason: 'The turn was stopped before the owner was asked.' });
    const id = input.id ?? crypto.randomUUID();
    const decision = this.inner.request({ ...input, id });
    if (!signal) return decision;
    // `resolve` is the broker's one way to settle a pending request by id; it also writes the audit entry.
    const onAbort = (): void => {
      this.inner.resolve(id, false, 'system');
    };
    signal.addEventListener('abort', onAbort, { once: true });
    return decision.finally(() => signal.removeEventListener('abort', onAbort));
  }
}
