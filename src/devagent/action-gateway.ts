/**
 * Jarvis Local AI Agent: Action Gateway & Permission Engine
 * Authority: Section 6.2 (Action Gateway Tiers), Section 17.10 (Shared-Account Safeguards)
 *
 * Enforces the 3-tier safety boundaries:
 * Tier 1: Autonomous safe actions (read board, create story branches, run tests, open PR).
 * Tier 2: Actions requiring owner notification or review.
 * Tier 3: STRICTLY FORBIDDEN to the Dev Agent (merging to master, approving own PRs,
 *         moving cards to Done, sending emails).
 */

import os from 'node:os';
import crypto from 'node:crypto';
import type { OwnActionRegistry } from './action-registry.js';
import type { GatewayActionRequest, OwnActionRecord, ActionType } from './types.js';
import { logger } from '../utils/logger.js';

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

export interface ActionGatewayOptions {
  minFreeMemoryBytes?: number;
}

export class ActionGateway {
  private registry: OwnActionRegistry;
  private minFreeMemoryBytes: number;

  constructor(registry: OwnActionRegistry, options: ActionGatewayOptions = {}) {
    this.registry = registry;
    this.minFreeMemoryBytes = options.minFreeMemoryBytes ?? 4 * 1024 * 1024 * 1024; // 4 GB default safe baseline for dev actions
  }

  /**
   * Evaluates memory governor headroom.
   */
  public verifyMemoryHeadroom(): void {
    const freeMem = os.freemem();
    if (freeMem < this.minFreeMemoryBytes) {
      const freeGb = (freeMem / (1024 * 1024 * 1024)).toFixed(2);
      const reqGb = (this.minFreeMemoryBytes / (1024 * 1024 * 1024)).toFixed(2);
      throw new MemoryGovernorError(
        `Insufficient host memory: ${freeGb} GB free, required ${reqGb} GB headroom`
      );
    }
  }

  /**
   * Executes an action through the gateway with tier validation, memory checks,
   * and automatic registration into OwnActionRegistry.
   */
  public async executeAction<T>(
    request: GatewayActionRequest,
    handler: () => Promise<T>
  ): Promise<T> {
    // 1. Enforce Memory Governor
    this.verifyMemoryHeadroom();

    // 2. Validate Action Tiers & Enforce Hard Forbidden Boundaries
    if (request.actionType === 'PR_APPROVE') {
      throw new ActionGatewayForbiddenError(
        'Tier 3 action forbidden: Dev Agent cannot approve pull requests. Approvals are strictly reserved for the owner.'
      );
    }

    if (request.actionType === 'CARD_MOVE' && request.metadata?.targetColumn === 'Done') {
      throw new ActionGatewayForbiddenError(
        'Tier 3 action forbidden: moving tickets to Done is reserved for the owner upon passing QA.'
      );
    }

    if (request.actionType === 'PR_MERGE' && request.targetId.toLowerCase().includes('master')) {
      throw new ActionGatewayForbiddenError(
        'Tier 3 action forbidden: merging into master requires explicit owner release confirmation and label.'
      );
    }

    if (request.actionType === 'EMAIL_SEND') {
      throw new ActionGatewayForbiddenError(
        'Tier 3 action forbidden: email auto-send is strictly prohibited per Principle 5 and D21.'
      );
    }

    if (request.tier === 3) {
      throw new ActionGatewayForbiddenError(
        `Tier 3 action forbidden: action '${request.actionType}' requires owner explicit execution.`
      );
    }

    // 3. Log Tier 2 notification
    if (request.tier === 2) {
      logger.info(`[ActionGateway] Executing Tier 2 action (review/notification required): ${request.description}`, {
        actionType: request.actionType,
        targetId: request.targetId,
      });
    } else {
      logger.debug(`[ActionGateway] Executing Tier 1 action: ${request.description}`, {
        actionType: request.actionType,
        targetId: request.targetId,
      });
    }

    // 4. Execute the action handler
    const result = await handler();

    // 5. Register in OwnActionRegistry
    const actionId = `act-${crypto.randomUUID()}`;
    const record: OwnActionRecord = {
      id: actionId,
      actionType: request.actionType,
      targetId: request.targetId,
      createdAt: new Date().toISOString(),
      metadata: request.metadata ? JSON.stringify(request.metadata) : undefined,
    };

    this.registry.recordAction(record);

    return result;
  }

  public async executeTier2Action<T = boolean>(
    actionType: ActionType | string,
    description: string,
    targetId = 'system',
    handler?: () => Promise<T>
  ): Promise<T> {
    return this.executeAction(
      {
        tier: 2,
        actionType: actionType as any,
        targetId,
        description,
      },
      handler ?? (async () => true as unknown as T)
    );
  }
}
