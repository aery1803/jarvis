/**
 * Unit Tests: Own-Action Registry
 * Authority: CODING_RULES.md, Section 17.10 (Shared Account Safeguards)
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { OwnActionRegistry } from '../src/devagent/action-registry.js';
import type { OwnActionRecord } from '../src/devagent/types.js';

describe('OwnActionRegistry', () => {
  let registry: OwnActionRegistry;

  beforeEach(() => {
    // In-memory SQLite for testing
    registry = new OwnActionRegistry(':memory:');
  });

  test('should record an action and identify it as own action by ID', () => {
    const action: OwnActionRecord = {
      id: 'act-12345',
      actionType: 'COMMENT',
      targetId: 'issue-3',
      signature: 'sig-abcde',
      createdAt: new Date().toISOString(),
      metadata: JSON.stringify({ issueNumber: 3 }),
    };

    assert.equal(registry.isOwnAction('act-12345'), false);
    registry.recordAction(action);
    assert.equal(registry.isOwnAction('act-12345'), true);
  });

  test('should identify bot comments via embedded HTML comment marker', () => {
    const actionId = 'act-comment-999';
    const commentWithMarker = `## Concept Plan\nHere is the plan...\n<!-- jarvis-devagent:action-id:${actionId} -->`;
    const humanComment = `Looks good! Let us proceed with testing.`;

    registry.recordAction({
      id: actionId,
      actionType: 'COMMENT',
      targetId: 'issue-3',
      createdAt: new Date().toISOString(),
    });

    assert.equal(registry.isOwnComment(commentWithMarker), true);
    assert.equal(registry.isOwnComment(humanComment), false);
  });

  test('should identify bot comments via comment ID lookup in database', () => {
    const commentId = 'IC_kwDOBShJEs4Bm-xyz';
    registry.recordAction({
      id: commentId,
      actionType: 'COMMENT',
      targetId: 'issue-3',
      createdAt: new Date().toISOString(),
    });

    assert.equal(registry.isOwnComment('Plain text comment without marker', commentId), true);
    assert.equal(registry.isOwnComment('Plain text comment without marker', 'unknown-id'), false);
  });

  test('should retrieve all recorded actions', () => {
    registry.recordAction({
      id: 'act-1',
      actionType: 'BRANCH_CREATE',
      targetId: 'story/feat-002',
      createdAt: new Date().toISOString(),
    });
    registry.recordAction({
      id: 'act-2',
      actionType: 'PR_CREATE',
      targetId: 'pr-4',
      createdAt: new Date().toISOString(),
    });

    const all = registry.getAllActions();
    assert.equal(all.length, 2);
    assert.equal(all[0].id, 'act-1');
    assert.equal(all[1].id, 'act-2');
  });

  test('should clear registry records cleanly', () => {
    registry.recordAction({
      id: 'act-clear',
      actionType: 'LABEL_ADD',
      targetId: 'issue-3',
      createdAt: new Date().toISOString(),
    });
    assert.equal(registry.getAllActions().length, 1);
    registry.clear();
    assert.equal(registry.getAllActions().length, 0);
  });
});
