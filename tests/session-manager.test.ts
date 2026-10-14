import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DocumentStore } from '../src/storage/collection.js';
import { SessionManager } from '../src/sessions/manager.js';

describe('SessionManager & Task Queue', () => {
  const testDbPath = path.resolve(process.cwd(), 'data', 'test-session.db');
  let store: DocumentStore;
  let sessions: SessionManager;

  beforeEach(() => {
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
    store = new DocumentStore(testDbPath);
    sessions = new SessionManager(store);
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  test('should create, retrieve, and delete sessions with multi-user isolation', async () => {
    const s1 = await sessions.createSession('user-a', 'Research Project');
    const s2 = await sessions.createSession('user-b', 'Private Work');

    const listA = await sessions.listSessions('user-a');
    assert.equal(listA.length, 1);
    assert.equal(listA[0].title, 'Research Project');

    const listB = await sessions.listSessions('user-b');
    assert.equal(listB.length, 1);
    assert.equal(listB[0].title, 'Private Work');

    // Cross-user lookup should return null
    const crossCheck = await sessions.getSession('user-a', s2.id);
    assert.equal(crossCheck, null);

    // Delete session
    const deleted = await sessions.deleteSession('user-a', s1.id);
    assert.equal(deleted, true);
    assert.equal((await sessions.listSessions('user-a')).length, 0);
  });

  test('should schedule tasks and pop next task by priority', async () => {
    const s = await sessions.createSession('owner-1', 'Background Session');

    const lowTask = await sessions.createTask({
      userId: 'owner-1',
      sessionId: s.id,
      title: 'Scrape documentation',
      priority: 2,
    });

    const highTask = await sessions.createTask({
      userId: 'owner-1',
      sessionId: s.id,
      title: 'Answer urgent question',
      priority: 10,
    });

    // High priority should be popped first
    const next1 = await sessions.getNextTask('owner-1');
    assert.ok(next1);
    assert.equal(next1.id, highTask.id);
    assert.equal(next1.status, 'running');

    // Low priority should be popped next
    const next2 = await sessions.getNextTask('owner-1');
    assert.ok(next2);
    assert.equal(next2.id, lowTask.id);
    assert.equal(next2.status, 'running');

    // No more queued tasks
    const next3 = await sessions.getNextTask('owner-1');
    assert.equal(next3, null);
  });

  test('should format task tags correctly', async () => {
    const s = await sessions.createSession('owner-1', 'Task Tagging');
    const task = await sessions.createTask({
      userId: 'owner-1',
      sessionId: s.id,
      title: 'Market Analysis 2026',
    });

    const tag = sessions.formatTaskTag(task);
    assert.ok(tag.startsWith('[#'));
    assert.ok(tag.includes('Market Analysis'));
  });

  test('should cancel all active tasks on demand', async () => {
    const s = await sessions.createSession('owner-1', 'Batch Work');
    await sessions.createTask({ userId: 'owner-1', sessionId: s.id, title: 'Job 1' });
    await sessions.createTask({ userId: 'owner-1', sessionId: s.id, title: 'Job 2' });

    const cancelledCount = await sessions.cancelAllActiveTasks('Emergency stop');
    assert.equal(cancelledCount, 2);

    const remainingQueued = await sessions.listTasks({ status: 'queued' });
    assert.equal(remainingQueued.length, 0);
  });
});
