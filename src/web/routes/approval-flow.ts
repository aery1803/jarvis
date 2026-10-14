/**
 * Jarvis Local AI Agent: Owner-approved actions started from the web UI
 * Authority: CODING_RULES.md section 5 (Tier 2 needs the owner's explicit approval every time)
 *
 * A Tier 2 action requested over HTTP does not run in the request: the route asks the `ApprovalBroker` and answers
 * 202 with the request id. The owner approves or denies it from the approval banner (`POST /api/approvals/:id`) or
 * Telegram, and only a real approval decision lets `run` execute, through the Action Gateway so it is audited.
 */

import { randomUUID } from 'node:crypto';
import type { JarvisRuntime } from '../../runtime/runtime.js';
import { errorMessage } from './types.js';

const MAX_REMEMBERED_OUTCOMES = 50;

export interface ApprovalOutcome {
  id: string;
  /** What was asked for, for example `email_send` or `skill_promote`. */
  kind: string;
  description: string;
  state: 'pending' | 'done' | 'denied' | 'failed';
  /** What happened: the result of `run`, the denial reason or the failure. */
  detail?: string;
  requestedAt: string;
  finishedAt?: string;
}

export interface ApprovedActionInput {
  kind: string;
  description: string;
  metadata?: Record<string, unknown>;
  /** Runs only after the owner approved. Returns a short note for the outcome. */
  run: () => Promise<string>;
}

export interface ApprovalFlow {
  start(rt: JarvisRuntime, input: ApprovedActionInput): string;
  list(kind?: string): ApprovalOutcome[];
  get(id: string): ApprovalOutcome | undefined;
}

export function createApprovalFlow(): ApprovalFlow {
  const outcomes = new Map<string, ApprovalOutcome>();

  const remember = (outcome: ApprovalOutcome): void => {
    outcomes.set(outcome.id, outcome);
    while (outcomes.size > MAX_REMEMBERED_OUTCOMES) {
      const oldest = outcomes.keys().next().value;
      if (oldest === undefined) break;
      outcomes.delete(oldest);
    }
  };

  return {
    start(rt, input) {
      const id = randomUUID();
      const base: ApprovalOutcome = { id, kind: input.kind, description: input.description, state: 'pending', requestedAt: new Date().toISOString() };
      remember(base);
      const finish = (state: ApprovalOutcome['state'], detail: string): void => {
        remember({ ...base, state, detail, finishedAt: new Date().toISOString() });
      };

      void rt.approvals
        .request({ id, actionType: 'TOOL_CALL', description: input.description, tier: 2, requestedBy: 'web', metadata: { kind: input.kind, ...(input.metadata ?? {}) } })
        .then(async (decision) => {
          if (!decision.approved) {
            finish('denied', decision.reason ?? 'The owner denied the request.');
            return;
          }
          try {
            // `isOwnerExplicitlyApproved` is set only here, after the broker returned a real owner decision.
            const detail = await rt.gateway.executeAction(
              { tier: 2, actionType: 'TOOL_CALL', targetId: input.kind, description: input.description },
              async () => input.run(),
              { isOwnerExplicitlyApproved: true, requestedBy: 'web-owner' }
            );
            finish('done', detail);
          } catch (err: unknown) {
            finish('failed', errorMessage(err));
          }
        })
        .catch((err: unknown) => finish('failed', errorMessage(err)));
      return id;
    },
    list(kind) {
      return [...outcomes.values()].filter((outcome) => kind === undefined || outcome.kind === kind).reverse();
    },
    get(id) {
      return outcomes.get(id);
    },
  };
}
