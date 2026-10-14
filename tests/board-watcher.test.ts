/**
 * Unit Tests: Board Watcher & Directive Parser
 * Authority: Section 17.10 (Automation mechanism and security)
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { BoardWatcher, parseDirective } from '../src/devagent/board-watcher.js';
import { OwnActionRegistry } from '../src/devagent/action-registry.js';
import { ActionGateway } from '../src/devagent/action-gateway.js';
import type { CommandRunner } from '../src/devagent/command-runner.js';

describe('BoardWatcher & Directives', () => {
  let registry: OwnActionRegistry;
  let gateway: ActionGateway;
  let watcher: BoardWatcher;

  beforeEach(() => {
    registry = new OwnActionRegistry(':memory:');
    gateway = new ActionGateway(registry);
    watcher = new BoardWatcher({ registry, gateway });
  });

  test('should parse direct /jarvis directives accurately', () => {
    const comment = '/jarvis status report --verbose';
    const directive = parseDirective(comment, 'aery1803', 'IC_1');

    assert.equal(directive.isDirective, true);
    assert.equal(directive.command, 'status');
    assert.deepEqual(directive.args, ['report', '--verbose']);
    assert.equal(directive.author, 'aery1803');
  });

  test('should ignore non-directive regular human comments', () => {
    const comment = 'Looks good to me, let us proceed!';
    const directive = parseDirective(comment, 'aery1803', 'IC_2');

    assert.equal(directive.isDirective, false);
    assert.equal(directive.command, undefined);
  });

  test('should filter out comments originating from the AI agent via OwnActionRegistry', () => {
    const botActionId = 'act-bot-response-1';
    registry.recordAction({
      id: botActionId,
      actionType: 'COMMENT',
      targetId: 'issue-3',
      createdAt: new Date().toISOString(),
    });

    const botComment = `## Concept Plan\n<!-- jarvis-devagent:action-id:${botActionId} -->`;
    const isBot = watcher.isAiGeneratedComment(botComment, 'IC_bot');
    assert.equal(isBot, true);

    const ownerComment = `/jarvis sync`;
    const isOwner = watcher.isAiGeneratedComment(ownerComment, 'IC_owner');
    assert.equal(isOwner, false);
  });

  test('should parse raw gh project item-list output JSON correctly', () => {
    const sampleRawOutput = {
      items: [
        {
          id: 'PVTI_123',
          status: 'Concept',
          ticketType: 'Feature',
          labels: ['ai-proposed'],
          content: {
            number: 3,
            title: '[FEAT-002] Phase 0b: Minimal Dev Agent',
            body: 'Feature description',
            type: 'Issue',
            url: 'https://github.com/aery1803/jarvis/issues/3',
          },
        },
      ],
    };

    const parsed = watcher.parseProjectItems(sampleRawOutput);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].issueNumber, 3);
    assert.equal(parsed[0].status, 'Concept');
    assert.equal(parsed[0].ticketType, 'Feature');
    assert.equal(parsed[0].title, '[FEAT-002] Phase 0b: Minimal Dev Agent');
  });

  describe('pollBoard', () => {
    const fake = () => {
      const calls: Array<{ file: string; args: readonly string[] }> = [];
      const run: CommandRunner = async (file, args) => {
        calls.push({ file, args });
        return { stdout: JSON.stringify({ items: [{ id: 'PVTI_1', status: 'Concept', content: { number: 7, title: 'T', url: 'u' } }] }), stderr: '' };
      };
      return { calls, run };
    };
    const open = () => new OwnActionRegistry(':memory:');
    const gatewayFor = (r: OwnActionRegistry) => new ActionGateway(r, { getFreeMemory: () => 16e9, minFreeMemoryBytes: 1e9 });

    test('runs gh with an argument array (no shell) and records a BOARD_POLL, never a CARD_MOVE', async () => {
      const reg = open();
      const { calls, run } = fake();
      const w = new BoardWatcher({ registry: reg, gateway: gatewayFor(reg), projectNumber: 2, repoOwner: 'aery1803', run });
      const items = await w.pollBoard();
      assert.equal(items[0].issueNumber, 7);
      assert.deepEqual(calls[0], { file: 'gh', args: ['project', 'item-list', '2', '--owner', 'aery1803', '--format', 'json'] });
      assert.deepEqual(reg.getAllActions().map((a) => [a.actionType, a.status]), [['BOARD_POLL', 'succeeded']]);
    });

    test('rejects an owner or project number that could inject arguments', async () => {
      const reg = open();
      const { calls, run } = fake();
      for (const [projectNumber, repoOwner] of [[2, 'x; rm -rf /'], [2, '--format'], [0, 'ok'], [Number.NaN, 'ok'], [1.5, 'ok']] as const) {
        const w = new BoardWatcher({ registry: reg, gateway: gatewayFor(reg), projectNumber, repoOwner, run });
        await assert.rejects(w.pollBoard(), /Invalid/);
      }
      assert.equal(calls.length, 0);
    });

    test('a failing gh poll is recorded as a failed action', async () => {
      const reg = open();
      const w = new BoardWatcher({
        registry: reg,
        gateway: gatewayFor(reg),
        projectNumber: 2,
        repoOwner: 'aery1803',
        run: async () => {
          throw new Error('gh not logged in');
        },
      });
      await assert.rejects(w.pollBoard(), /not logged in/);
      assert.equal(reg.getAllActions()[0].status, 'failed');
    });
  });
});
