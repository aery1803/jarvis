/**
 * Unit Tests: Action Gateway & Permission Engine
 * Authority: Section 6.2, 17.10 (Shared Account Safeguards, 3-Tier Model)
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  ActionGateway,
  ActionGatewayForbiddenError,
  ActionApprovalDeniedError,
  MemoryGovernorError,
  ACTION_MIN_TIER,
  minTierFor,
} from '../src/devagent/action-gateway.js';
import { ApprovalBroker } from '../src/security/approvals.js';
import { KillSwitchEngagedError } from '../src/security/kill-switch.js';
import { OwnActionRegistry } from '../src/devagent/action-registry.js';
import type { GatewayActionRequest } from '../src/devagent/types.js';

describe('ActionGateway', () => {
  let registry: OwnActionRegistry;
  let gateway: ActionGateway;

  beforeEach(() => {
    registry = new OwnActionRegistry(':memory:');
    gateway = new ActionGateway(registry, {
      minFreeMemoryBytes: 1024 * 1024 * 1024, // 1 GB for test
      getFreeMemory: () => 16 * 1024 * 1024 * 1024,
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
      minFreeMemoryBytes: 14 * 1024 * 1024 * 1024,
      getFreeMemory: () => 2 * 1024 * 1024 * 1024,
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

  describe('tier enforcement', () => {
    test('uses max(caller tier, table tier): a caller cannot launder a Tier 2 action as Tier 1', async () => {
      let ran = false;
      await assert.rejects(
        gateway.executeAction({ tier: 1, actionType: 'SHELL_EXEC', targetId: 'ls', description: 'list' }, async () => {
          ran = true;
        }),
        ActionApprovalDeniedError
      );
      assert.equal(ran, false);
    });

    test('table covers every ActionType and unknown types default to Tier 2', () => {
      assert.equal(ACTION_MIN_TIER.BOARD_POLL, 1);
      for (const t of ['BROWSER_ACTION', 'PHONE_ACTION', 'HOST_COMMAND', 'MODEL_PULL', 'SHELL_EXEC', 'PR_MERGE'] as const) {
        assert.equal(ACTION_MIN_TIER[t], 2, t);
      }
      assert.equal(ACTION_MIN_TIER.EMAIL_SEND, 3);
      assert.equal(minTierFor('SOMETHING_NEW'), 2);
    });

    test('Tier 2 without a broker or pre-approval is denied and the denial is audited', async () => {
      await assert.rejects(
        gateway.executeAction({ tier: 2, actionType: 'CARD_MOVE', targetId: 'issue-3', description: 'Move card' }, async () => 'moved'),
        (err: any) => err instanceof ActionApprovalDeniedError && /no approval broker/i.test(err.message)
      );
      const [entry] = registry.getAllActions();
      assert.equal(entry.status, 'denied');
    });

    test('Tier 2 runs when the owner explicitly pre-approved', async () => {
      const result = await gateway.executeAction(
        { tier: 2, actionType: 'BROWSER_ACTION', targetId: '#submit', description: 'Click submit' },
        async () => 'clicked',
        { isOwnerExplicitlyApproved: true }
      );
      assert.equal(result, 'clicked');
      assert.equal(registry.getAllActions()[0].status, 'succeeded');
    });

    test('Tier 2 awaits the broker and runs only if approved', async () => {
      const broker = new ApprovalBroker();
      const seen: any[] = [];
      broker.setNotifier(async (req) => {
        seen.push(req);
        broker.resolve(req.id, true, 'owner');
      });
      const result = await gateway.executeAction(
        { tier: 2, actionType: 'MODEL_PULL', targetId: 'qwen3:14b', description: 'Pull qwen3:14b' },
        async () => 'pulled',
        { broker, requestedBy: 'web' }
      );
      assert.equal(result, 'pulled');
      assert.equal(seen[0].actionType, 'MODEL_PULL');
      assert.equal(seen[0].tier, 2);
      assert.equal(seen[0].requestedBy, 'web');
    });

    test('Tier 2 is not run when the owner denies', async () => {
      const broker = new ApprovalBroker();
      broker.setNotifier(async (req) => {
        broker.resolve(req.id, false, 'owner');
      });
      let ran = false;
      await assert.rejects(
        gateway.executeAction({ tier: 2, actionType: 'HOST_COMMAND', targetId: 'cmd', description: 'run' }, async () => {
          ran = true;
        }, { broker }),
        ActionApprovalDeniedError
      );
      assert.equal(ran, false);
    });

    test('a constructor-level broker applies to every Tier 2 call', async () => {
      const broker = new ApprovalBroker();
      broker.setNotifier(async (req) => {
        broker.resolve(req.id, true, 'owner');
      });
      const withBroker = new ActionGateway(registry, { getFreeMemory: () => 16e9, minFreeMemoryBytes: 1e9, broker });
      assert.equal(await withBroker.executeTier2Action('SHELL_EXEC', 'run', 'x', async () => 7), 7);
    });

    test('executeTier2Action stays callable and now needs approval', async () => {
      await assert.rejects(gateway.executeTier2Action('BROWSER_ACTION', 'click', '#a'), ActionApprovalDeniedError);
      assert.equal(await gateway.executeTier2Action('BROWSER_ACTION', 'click', '#a', undefined, { isOwnerExplicitlyApproved: true }), true);
    });
  });

  describe('merge guard', () => {
    for (const target of ['main', 'master', 'origin/main', 'release/1.2', 'release-2.0', 'Main']) {
      test(`blocks PR_MERGE into ${target} even when pre-approved and labelled Tier 1`, async () => {
        await assert.rejects(
          gateway.executeAction({ tier: 1, actionType: 'PR_MERGE', targetId: target, description: 'merge' }, async () => 'merged', {
            isOwnerExplicitlyApproved: true,
          }),
          ActionGatewayForbiddenError
        );
      });
    }

    test('blocks via metadata.baseBranch and honours custom protected branches', async () => {
      await assert.rejects(
        gateway.executeAction({ tier: 2, actionType: 'PR_MERGE', targetId: 'pr-9', description: 'merge', metadata: { baseBranch: 'main' } }, async () => 1, {
          isOwnerExplicitlyApproved: true,
        }),
        ActionGatewayForbiddenError
      );
      const custom = new ActionGateway(registry, { getFreeMemory: () => 16e9, minFreeMemoryBytes: 1e9, protectedBranches: ['trunk'] });
      await assert.rejects(
        custom.executeAction({ tier: 2, actionType: 'PR_MERGE', targetId: 'trunk', description: 'merge' }, async () => 1, { isOwnerExplicitlyApproved: true }),
        ActionGatewayForbiddenError
      );
    });

    test('does not mistake feature/main-nav for main; a feature-branch merge still needs approval', async () => {
      await assert.rejects(
        gateway.executeAction({ tier: 1, actionType: 'PR_MERGE', targetId: 'feature/main-nav', description: 'merge' }, async () => 1),
        ActionApprovalDeniedError
      );
      assert.equal(
        await gateway.executeAction({ tier: 2, actionType: 'PR_MERGE', targetId: 'feature/main-nav', description: 'merge' }, async () => 1, {
          isOwnerExplicitlyApproved: true,
        }),
        1
      );
    });

    test('card moved to Done is forbidden regardless of case or caller tier', async () => {
      await assert.rejects(
        gateway.executeAction({ tier: 1, actionType: 'CARD_MOVE', targetId: 'i', description: 'm', metadata: { targetColumn: 'done' } }, async () => 1),
        ActionGatewayForbiddenError
      );
    });
  });

  describe('audit trail', () => {
    test('mints the action id first and hands it to the handler with the loopback marker', async () => {
      let seenId = '';
      await gateway.executeAction({ tier: 1, actionType: 'COMMENT', targetId: 'issue-3', description: 'comment' }, async ({ actionId, marker }) => {
        seenId = actionId;
        assert.match(marker, /<!-- jarvis-devagent:action-id:act-/);
        // The 'started' entry already exists while the handler runs, so a poll can recognise our own comment.
        assert.equal(registry.isOwnAction(actionId), true);
        assert.equal(registry.getAllActions()[0].status, 'started');
        assert.equal(registry.isOwnComment(`hello\n${marker}`), true);
      });
      assert.equal(registry.getAllActions()[0].id, seenId);
      assert.equal(registry.getAllActions()[0].status, 'succeeded');
    });

    test('records failed actions with the error and rethrows', async () => {
      await assert.rejects(
        gateway.executeAction({ tier: 1, actionType: 'BRANCH_CREATE', targetId: 'story/x', description: 'branch' }, async () => {
          throw new Error('git exploded');
        }),
        /git exploded/
      );
      const [entry] = registry.getAllActions();
      assert.equal(entry.status, 'failed');
      assert.equal(entry.outcome, 'git exploded');
    });

    test('records forbidden attempts', async () => {
      await assert.rejects(gateway.executeAction({ tier: 1, actionType: 'EMAIL_SEND', targetId: 'a@b.c', description: 'mail' }, async () => 1));
      assert.equal(registry.getAllActions()[0].status, 'forbidden');
    });

    test('caps recorded metadata so tool arguments cannot bloat the audit table', async () => {
      await gateway.executeAction(
        { tier: 1, actionType: 'COMMENT', targetId: 'i', description: 'c', metadata: { big: 'x'.repeat(10_000) } },
        async () => 1
      );
      assert.ok((registry.getAllActions()[0].metadata ?? '').length < 2100);
    });
  });

  describe('kill switch and memory injection', () => {
    test('refuses all actions while the kill switch is engaged', async () => {
      const killed = new ActionGateway(registry, {
        getFreeMemory: () => 16e9,
        minFreeMemoryBytes: 1e9,
        killSwitch: {
          assertNotKilled: () => {
            throw new KillSwitchEngagedError('stop');
          },
        },
      });
      await assert.rejects(
        killed.executeAction({ tier: 1, actionType: 'COMMENT', targetId: 'i', description: 'c' }, async () => 1),
        KillSwitchEngagedError
      );
      assert.equal(registry.getAllActions().length, 0);
    });

    test('verifyMemoryHeadroom uses the injected probe', () => {
      assert.doesNotThrow(() => gateway.verifyMemoryHeadroom());
    });
  });
});
