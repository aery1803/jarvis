/**
 * Jarvis Local AI Agent: Action Gateway & Permission Engine
 * Authority: Section 6.2 (Action Gateway Tiers), Section 17.10 (Shared-Account Safeguards)
 *
 * Enforces the 3-tier safety boundaries:
 * Tier 1: Autonomous safe actions (read board, create story branches, run tests, open PR).
 * Tier 2: Actions that need the owner's explicit approval every time (via the ApprovalBroker).
 * Tier 3: STRICTLY FORBIDDEN to the Dev Agent (merging to main/master/release, approving own PRs,
 *         moving cards to Done, sending emails).
 *
 * The caller's tier is a request, not a fact: the effective tier is max(caller tier, ACTION_MIN_TIER).
 */

import os from 'node:os';
import crypto from 'node:crypto';
import type { OwnActionRegistry } from './action-registry.js';
import type { GatewayActionRequest, GatewayTier, ActionType, OwnActionRecord, ActionStatus } from './types.js';
import type { ApprovalBroker } from '../security/approvals.js';
import { redactSensitive } from '../memory/sensitive.js';
import { logger } from '../utils/logger.js';

/** Floor tier per action type. Unknown action types are treated as Tier 2. */
export const ACTION_MIN_TIER: Record<ActionType, GatewayTier> = {
  COMMENT: 1,
  CARD_MOVE: 1,
  BRANCH_CREATE: 1,
  PR_CREATE: 1,
  LABEL_ADD: 1,
  LABEL_REMOVE: 1,
  BOARD_POLL: 1,
  // Tools carry their own tier; the executor passes max(tool.tier, this floor).
  TOOL_CALL: 1,
  PR_MERGE: 2,
  SHELL_EXEC: 2,
  BROWSER_ACTION: 2,
  PHONE_ACTION: 2,
  HOST_COMMAND: 2,
  MODEL_PULL: 2,
  PR_APPROVE: 3,
  EMAIL_SEND: 3,
};

export function minTierFor(actionType: string): GatewayTier {
  return (ACTION_MIN_TIER as Record<string, GatewayTier | undefined>)[actionType] ?? 2;
}

export const DEFAULT_PROTECTED_BRANCHES: readonly string[] = ['main', 'master'];

const MAX_RECORDED_METADATA_CHARS = 2000;

export class ActionGatewayForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActionGatewayForbiddenError';
  }
}

export class MemoryGovernorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryGovernorError';
  }
}

export class ActionApprovalDeniedError extends Error {
  constructor(
    message: string,
    public readonly reason?: string
  ) {
    super(message);
    this.name = 'ActionApprovalDeniedError';
  }
}

/** Passed to every handler so it can embed the loopback marker in whatever it writes to GitHub. */
export interface ActionContext {
  actionId: string;
  /** Invisible HTML comment recognised by `OwnActionRegistry.isOwnComment`. */
  marker: string;
}

export interface KillGuard {
  assertNotKilled(): void;
}

export interface ActionGatewayOptions {
  minFreeMemoryBytes?: number;
  /** Defaults to `os.freemem`; inject so tests do not depend on the host's RAM. */
  getFreeMemory?: () => number;
  /** Used for Tier 2 unless a call passes its own. */
  broker?: ApprovalBroker;
  killSwitch?: KillGuard;
  /** Lower-case branch names that can never be merge targets. Release branches are always protected. */
  protectedBranches?: string[];
}

export interface ExecuteActionOptions {
  broker?: ApprovalBroker;
  /** Only owner-originated code paths (an owner command or an already-approved tap) may set this. */
  isOwnerExplicitlyApproved?: boolean;
  requestedBy?: string;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Redacts each string on its own, so a secret label inside one argument cannot swallow the next one. The approval
 * broker gets the unredacted metadata (the owner must see the real action); only the persisted audit copy is redacted.
 */
function redactDeep(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactSensitive(value);
  if (depth > 6 || typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDeep(item, depth + 1)]));
}

function safeJson(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    const text = JSON.stringify(redactDeep(value));
    return text.length > MAX_RECORDED_METADATA_CHARS ? `${text.slice(0, MAX_RECORDED_METADATA_CHARS)}...[truncated]` : text;
  } catch {
    return '[unserializable metadata]';
  }
}

export class ActionGateway {
  private registry: OwnActionRegistry;
  private minFreeMemoryBytes: number;
  private getFreeMemory: () => number;
  private broker?: ApprovalBroker;
  private killSwitch?: KillGuard;
  private protectedBranchPattern: RegExp;

  constructor(registry: OwnActionRegistry, options: ActionGatewayOptions = {}) {
    this.registry = registry;
    this.minFreeMemoryBytes = options.minFreeMemoryBytes ?? 4 * 1024 * 1024 * 1024; // 4 GB default safe baseline for dev actions
    this.getFreeMemory = options.getFreeMemory ?? (() => os.freemem());
    this.broker = options.broker;
    this.killSwitch = options.killSwitch;
    const names = (options.protectedBranches?.length ? options.protectedBranches : [...DEFAULT_PROTECTED_BRANCHES]).map((n) => escapeRegExp(n.toLowerCase()));
    // `-` and `_` count as word characters so `feature/main-nav` is not mistaken for `main`.
    this.protectedBranchPattern = new RegExp(`(^|[^a-z0-9_-])((${names.join('|')})($|[^a-z0-9_-])|releases?($|[/_.-]))`);
  }

  public setBroker(broker: ApprovalBroker): void {
    this.broker = broker;
  }

  public setKillSwitch(killSwitch: KillGuard): void {
    this.killSwitch = killSwitch;
  }

  /**
   * Evaluates memory governor headroom.
   */
  public verifyMemoryHeadroom(): void {
    const freeMem = this.getFreeMemory();
    if (freeMem < this.minFreeMemoryBytes) {
      const freeGb = (freeMem / (1024 * 1024 * 1024)).toFixed(2);
      const reqGb = (this.minFreeMemoryBytes / (1024 * 1024 * 1024)).toFixed(2);
      throw new MemoryGovernorError(
        `Insufficient host memory: ${freeGb} GB free, required ${reqGb} GB headroom`
      );
    }
  }

  private mergeTargetsProtectedBranch(request: GatewayActionRequest): boolean {
    const meta = request.metadata ?? {};
    const candidates = [request.targetId, meta.baseBranch, meta.targetBranch, meta.base, meta.branch];
    return candidates.some((c) => typeof c === 'string' && this.protectedBranchPattern.test(c.toLowerCase()));
  }

  private forbiddenReason(request: GatewayActionRequest, tier: GatewayTier): string | null {
    if (request.actionType === 'PR_APPROVE') {
      return 'Tier 3 action forbidden: Dev Agent cannot approve pull requests. Approvals are strictly reserved for the owner.';
    }
    if (request.actionType === 'CARD_MOVE' && String(request.metadata?.targetColumn ?? '').toLowerCase() === 'done') {
      return 'Tier 3 action forbidden: moving tickets to Done is reserved for the owner upon passing QA.';
    }
    if (request.actionType === 'PR_MERGE' && this.mergeTargetsProtectedBranch(request)) {
      return 'Tier 3 action forbidden: merging into master requires explicit owner release confirmation and label.';
    }
    if (request.actionType === 'EMAIL_SEND') {
      return 'Tier 3 action forbidden: email auto-send is strictly prohibited per Principle 5 and D21.';
    }
    if (tier === 3) {
      return `Tier 3 action forbidden: action '${request.actionType}' requires owner explicit execution.`;
    }
    return null;
  }

  private recordBestEffort(record: OwnActionRecord): void {
    try {
      this.registry.recordAction(record);
    } catch (err) {
      logger.error(`[ActionGateway] Could not record ${record.status} action ${record.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private finish(actionId: string, status: ActionStatus, outcome?: string): void {
    try {
      this.registry.updateAction(actionId, { status, outcome });
    } catch (err) {
      logger.error(`[ActionGateway] Could not update action ${actionId} to ${status}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Executes an action through the gateway with tier validation, owner approval for Tier 2, memory checks,
   * and an audit entry that is written before the handler runs and updated with its outcome (failures included).
   */
  public async executeAction<T>(
    request: GatewayActionRequest,
    handler: (context: ActionContext) => Promise<T>,
    options: ExecuteActionOptions = {}
  ): Promise<T> {
    this.killSwitch?.assertNotKilled();

    const actionId = `act-${crypto.randomUUID()}`;
    const tier: GatewayTier = Math.max(request.tier, minTierFor(request.actionType)) as GatewayTier;
    const baseRecord = {
      id: actionId,
      actionType: request.actionType,
      targetId: request.targetId,
      createdAt: new Date().toISOString(),
      metadata: safeJson(request.metadata),
    };

    const forbidden = this.forbiddenReason(request, tier);
    if (forbidden) {
      this.recordBestEffort({ ...baseRecord, status: 'forbidden', outcome: forbidden });
      throw new ActionGatewayForbiddenError(forbidden);
    }

    this.verifyMemoryHeadroom();

    if (tier === 2) {
      await this.requireOwnerApproval(request, actionId, baseRecord, options);
    } else {
      logger.debug(`[ActionGateway] Executing Tier 1 action: ${request.description}`, {
        actionType: request.actionType,
        targetId: request.targetId,
      });
    }

    // Audit before acting: if the trail cannot be written, the action does not run.
    this.registry.recordAction({ ...baseRecord, status: 'started' });

    try {
      const result = await handler({ actionId, marker: `<!-- jarvis-devagent:action-id:${actionId} -->` });
      this.finish(actionId, 'succeeded');
      return result;
    } catch (err) {
      this.finish(actionId, 'failed', err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  private async requireOwnerApproval(
    request: GatewayActionRequest,
    actionId: string,
    baseRecord: Omit<OwnActionRecord, 'status' | 'outcome'>,
    options: ExecuteActionOptions
  ): Promise<void> {
    if (options.isOwnerExplicitlyApproved === true) {
      logger.info(`[ActionGateway] Tier 2 action pre-approved by owner: ${request.description}`, {
        actionType: request.actionType,
        targetId: request.targetId,
      });
      return;
    }

    const broker = options.broker ?? this.broker;
    let denial: string | null = null;
    if (!broker) {
      denial = 'no approval broker is configured and the action was not pre-approved by the owner';
    } else {
      const decision = await broker.request({
        actionType: request.actionType,
        description: request.description,
        tier: 2,
        requestedBy: options.requestedBy ?? 'jarvis',
        metadata: { targetId: request.targetId, actionId, ...(request.metadata ?? {}) },
      });
      if (!decision.approved) {
        denial = decision.reason ?? 'the owner denied the request';
      }
    }

    if (denial !== null) {
      this.recordBestEffort({ ...baseRecord, status: 'denied', outcome: denial });
      throw new ActionApprovalDeniedError(
        `Tier 2 action '${request.actionType}' denied: ${denial}`,
        denial
      );
    }
    logger.info(`[ActionGateway] Tier 2 action approved by owner: ${request.description}`, {
      actionType: request.actionType,
      targetId: request.targetId,
    });
  }

  public async executeTier2Action<T = boolean>(
    actionType: ActionType | string,
    description: string,
    targetId = 'system',
    handler?: (context: ActionContext) => Promise<T>,
    options?: ExecuteActionOptions
  ): Promise<T> {
    return this.executeAction(
      {
        tier: 2,
        actionType: actionType as ActionType,
        targetId,
        description,
      },
      handler ?? (async () => true as unknown as T),
      options
    );
  }
}
