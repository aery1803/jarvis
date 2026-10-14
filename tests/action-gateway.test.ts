/**
 * Unit Tests: Action Gateway & Permission Engine
 * Authority: Section 6.2, 17.10 (Shared Account Safeguards, 3-Tier Model)
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ActionGateway, ActionGatewayForbiddenError, MemoryGovernorError } from '../src/devagent/action-gateway.js';
import { OwnActionRegistry } from '../src/devagent/action-registry.js';
import type { GatewayActionRequest } from '../src/devagent/types.js';

describe('ActionGateway', () => {
  let registry: OwnActionRegistry;
  let gateway: ActionGateway;

  beforeEach(() => {
    registry = new OwnActionRegistry(':memory:');
    gateway = new ActionGateway(registry, {
      minFreeMemoryBytes: 1024 * 1024 * 1024, // 1 GB for test
    });
  });

  test('should allow Tier 1 safe autonomous actions and record them in registry', async () => {
    const request: GatewayActionRequest = {
      tier: 1,
      actionType: 'BRANCH_CREATE',
      targetId: 'story/feat-002-action-registry',
      description: 'Create isolated story branch for task',
    };

    const result = await gateway.executeAction(request, async () => {
      return { success: true, branch: 'story/feat-002-action-registry' };
    });

    assert.equal(result.success, true);
    // Action should be logged in OwnActionRegistry
    const actions = registry.getAllActions();
    assert.equal(actions.length, 1);
    assert.equal(actions[0].actionType, 'BRANCH_CREATE');
    assert.equal(actions[0].targetId, 'story/feat-002-action-registry');
  });

  test('should allow Tier 2 actions with review requirement logged', async () => {
    const request: GatewayActionRequest = {
      tier: 2,
      actionType: 'CARD_MOVE',
      targetId: 'issue-3',
      description: 'Move card to Code Review',
      metadata: { targetColumn: 'Code Review' },
    };

    const result = await gateway.executeAction(request, async () => {
      return { moved: true };
    });

    assert.equal(result.moved, true);
    assert.equal(registry.getAllActions().length, 1);
  });

  test('should REJECT Tier 3: Dev Agent self-approving a pull request', async () => {
    const request: GatewayActionRequest = {
      tier: 3,
      actionType: 'PR_APPROVE',
      targetId: 'pr-2',
      description: 'Approve PR',
    };

    await assert.rejects(
      async () => {
        await gateway.executeAction(request, async () => ({ approved: true }));
      },
      (err: any) => {
        assert.ok(err instanceof ActionGatewayForbiddenError);
        assert.match(err.message, /forbidden: Dev Agent cannot approve pull requests/i);
        return true;
      }
    );
  });

  test('should REJECT Tier 3: Dev Agent moving card to Done', async () => {
    const request: GatewayActionRequest = {
      tier: 3,
      actionType: 'CARD_MOVE',
      targetId: 'issue-3',
      description: 'Move card to Done',
      metadata: { targetColumn: 'Done' },
    };

    await assert.rejects(
      async () => {
        await gateway.executeAction(request, async () => ({ moved: true }));
      },
      (err: any) => {
        assert.ok(err instanceof ActionGatewayForbiddenError);
        assert.match(err.message, /forbidden: moving tickets to Done is reserved for the owner/i);
        return true;
      }
    );
  });

  test('should REJECT Tier 3: Dev Agent merging directly into master', async () => {
    const request: GatewayActionRequest = {
      tier: 3,
      actionType: 'PR_MERGE',
      targetId: 'master',
      description: 'Merge PR into master',
    };

    await assert.rejects(
      async () => {
        await gateway.executeAction(request, async () => ({ merged: true }));
      },
      (err: any) => {
        assert.ok(err instanceof ActionGatewayForbiddenError);
        assert.match(err.message, /forbidden: merging into master requires explicit owner release/i);
        return true;
      }
    );
  });

  test('should REJECT Tier 3: Dev Agent attempting to send email autonomously', async () => {
    const request: GatewayActionRequest = {
      tier: 3,
      actionType: 'EMAIL_SEND',
      targetId: 'user@example.com',
      description: 'Auto send email notification',
    };

    await assert.rejects(
      async () => {
        await gateway.executeAction(request, async () => ({ sent: true }));
      },
      (err: any) => {
        assert.ok(err instanceof ActionGatewayForbiddenError);
        assert.match(err.message, /forbidden: email auto-send is strictly prohibited/i);
        return true;
      }
    );
  });

  test('should enforce memory governor headroom before heavy operations', async () => {
    // Mock memory check to simulate memory exhaustion
    const lowMemGateway = new ActionGateway(registry, {
      minFreeMemoryBytes: 999 * 1024 * 1024 * 1024, // 999 GB (guaranteed failure)
    });

    const request: GatewayActionRequest = {
      tier: 1,
      actionType: 'COMMENT',
      targetId: 'issue-3',
      description: 'Post concept comment',
    };

    await assert.rejects(
      async () => {
        await lowMemGateway.executeAction(request, async () => ({ success: true }));
      },
      (err: any) => {
        assert.ok(err instanceof MemoryGovernorError);
        assert.match(err.message, /insufficient host memory/i);
        return true;
      }
    );
  });
});
