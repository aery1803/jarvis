/**
 * Unit Tests: Own-Action Registry
 * Authority: CODING_RULES.md, Section 17.10 (Shared Account Safeguards)
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { OwnActionRegistry } from '../src/devagent/action-registry.js';
import type { OwnActionRecord } from '../src/devagent/types.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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

  test('only honours a loopback marker whose id was minted by the gateway', () => {
    registry.recordAction({ id: 'act-real', actionType: 'COMMENT', targetId: 'i', createdAt: new Date().toISOString() });
    assert.equal(registry.isOwnComment('x <!-- jarvis-devagent:action-id:act-real -->'), true);
    assert.equal(registry.isOwnComment('x <!-- jarvis-devagent:action-id:act-forged -->'), false);
  });

  test('tracks status and outcome and migrates a pre-status database', () => {
    registry.recordAction({ id: 'act-s', actionType: 'COMMENT', targetId: 'i', createdAt: new Date().toISOString(), status: 'started' });
    assert.equal(registry.updateAction('act-s', { status: 'failed', outcome: 'boom' }), true);
    assert.equal(registry.updateAction('missing', { status: 'failed' }), false);
    const [row] = registry.getAllActions();
    assert.deepEqual([row.status, row.outcome], ['failed', 'boom']);

    const file = path.join(os.tmpdir(), `jarvis-reg-${process.pid}-${Date.now()}.db`);
    const legacy = new DatabaseSync(file);
    legacy.exec(`CREATE TABLE own_actions (id TEXT PRIMARY KEY, action_type TEXT NOT NULL, target_id TEXT NOT NULL, signature TEXT, created_at TEXT NOT NULL, metadata TEXT);
      INSERT INTO own_actions VALUES ('old', 'COMMENT', 't', NULL, '2020-01-01', NULL);`);
    legacy.close();
    const migrated = new OwnActionRegistry(file);
    assert.equal(migrated.getAllActions()[0].status, undefined);
    migrated.recordAction({ id: 'new', actionType: 'COMMENT', targetId: 't', createdAt: '2021-01-01', status: 'started' });
    assert.equal(migrated.getAllActions().length, 2);
    migrated.close();
    fs.rmSync(file, { force: true });
  });
});
