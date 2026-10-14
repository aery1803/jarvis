import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DocumentStore } from '../src/storage/collection.js';
import { SessionManager, SessionNotFoundError } from '../src/sessions/manager.js';

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

  function reopen(): void {
    store.close();
    store = new DocumentStore(testDbPath);
    sessions = new SessionManager(store);
  }

  test('should store and return session messages in insertion order', async () => {
    const s = await sessions.createSession('owner-1', 'Conversation');

    const first = await sessions.addMessage('owner-1', s.id, { role: 'user', content: 'First question' });
    // Added back to back, so both usually share one `createdAt` millisecond; `seq` keeps the order.
    await sessions.addMessage('owner-1', s.id, { role: 'assistant', content: 'First answer', meta: { sources: ['https://example.test'] } });
    await sessions.addMessage('owner-1', s.id, { role: 'user', content: 'Second question' });

    assert.ok(first.id);
    assert.equal(first.userId, 'owner-1');
    assert.equal(first.sessionId, s.id);
    assert.ok(first.createdAt);

    const messages = await sessions.getMessages('owner-1', s.id);
    assert.deepEqual(
      messages.map((m) => [m.seq, m.role, m.content]),
      [
        [1, 'user', 'First question'],
        [2, 'assistant', 'First answer'],
        [3, 'user', 'Second question'],
      ]
    );
    assert.deepEqual(messages[1].meta, { sources: ['https://example.test'] });
  });

  test('should isolate messages by user', async () => {
    const own = await sessions.createSession('user-a', 'Mine');
    const other = await sessions.createSession('user-b', 'Theirs');
    await sessions.addMessage('user-b', other.id, { role: 'user', content: 'user-b private note' });

    assert.deepEqual(await sessions.getMessages('user-a', other.id), []);
    await assert.rejects(
      sessions.addMessage('user-a', other.id, { role: 'user', content: 'cross-user write' }),
      SessionNotFoundError
    );
    assert.equal((await sessions.getMessages('user-b', other.id)).length, 1);
    assert.deepEqual(await sessions.getMessages('user-a', own.id), []);
  });

  test('should reject messages for a session that does not exist', async () => {
    await assert.rejects(
      sessions.addMessage('owner-1', 'sess-missing', { role: 'user', content: 'Hello?' }),
      (err: unknown) => err instanceof SessionNotFoundError && err.sessionId === 'sess-missing' && err.userId === 'owner-1'
    );
  });

  test('should move a session to the top of the list when a message is added', async () => {
    const older = await sessions.createSession('owner-1', 'Older');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await sessions.createSession('owner-1', 'Newer');
    await new Promise((resolve) => setTimeout(resolve, 5));

    await sessions.addMessage('owner-1', older.id, { role: 'user', content: 'Back to this one' });

    const list = await sessions.listSessions('owner-1');
    assert.equal(list[0].id, older.id);
  });

  test('should delete a session\'s messages along with the session', async () => {
    const s = await sessions.createSession('owner-1', 'To Delete');
    await sessions.addMessage('owner-1', s.id, { role: 'user', content: 'Hello' });

    assert.equal(await sessions.deleteSession('owner-1', s.id), true);
    assert.deepEqual(await sessions.getMessages('owner-1', s.id), []);

    // A later session must not inherit orphaned rows or their sequence numbers.
    const next = await sessions.createSession('owner-1', 'Fresh');
    const msg = await sessions.addMessage('owner-1', next.id, { role: 'user', content: 'New start' });
    assert.equal(msg.seq, 1);
  });

  test('should keep messages across a restart', async () => {
    const s = await sessions.createSession('owner-1', 'Durable');
    await sessions.addMessage('owner-1', s.id, { role: 'user', content: 'Survives restarts' });

    reopen();

    const messages = await sessions.getMessages('owner-1', s.id);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].content, 'Survives restarts');
    const next = await sessions.addMessage('owner-1', s.id, { role: 'assistant', content: 'Indeed' });
    assert.equal(next.seq, 2);
  });

  test('should persist the active session per user and channel across a restart', async () => {
    const s = await sessions.createSession('owner-1', 'Pinned');
    assert.equal(await sessions.getActiveSession('owner-1', 'telegram'), null);

    assert.equal(await sessions.setActiveSession('owner-1', 'telegram', s.id), true);
    reopen();

    assert.equal((await sessions.getActiveSession('owner-1', 'telegram'))?.id, s.id);
    assert.equal(await sessions.getActiveSession('owner-1', 'web'), null);
    assert.equal(await sessions.getActiveSession('owner-2', 'telegram'), null);
  });

  test('should not point the active session at another user\'s or a deleted session', async () => {
    const other = await sessions.createSession('user-b', 'Theirs');
    assert.equal(await sessions.setActiveSession('user-a', 'telegram', other.id), false);
    assert.equal(await sessions.getActiveSession('user-a', 'telegram'), null);

    const own = await sessions.createSession('user-a', 'Mine');
    await sessions.setActiveSession('user-a', 'telegram', own.id);
    await sessions.deleteSession('user-a', own.id);
    assert.equal(await sessions.getActiveSession('user-a', 'telegram'), null);
  });

  test('should import a session with its original ids and timestamps, once', async () => {
    const session = {
      id: 'session-legacy-1',
      userId: 'owner-1',
      title: 'Imported Chat',
      createdAt: '2026-01-01T10:00:00.000Z',
      updatedAt: '2026-01-01T10:05:00.000Z',
      metadata: { model: 'qwen2.5:7b' },
    };
    const messages = [
      { id: 'msg-legacy-1', role: 'user' as const, content: 'Old question', createdAt: '2026-01-01T10:00:00.000Z' },
      { id: 'msg-legacy-2', role: 'assistant' as const, content: 'Old answer', createdAt: '2026-01-01T10:00:00.000Z', meta: { partial: true } },
    ];

    assert.deepEqual(await sessions.importSession(session, messages), { sessionImported: true, messagesImported: 2 });
    assert.deepEqual(await sessions.importSession(session, messages), { sessionImported: false, messagesImported: 0 });

    const imported = await sessions.getSession('owner-1', 'session-legacy-1');
    assert.equal(imported?.title, 'Imported Chat');
    assert.equal(imported?.updatedAt, '2026-01-01T10:05:00.000Z');
    const stored = await sessions.getMessages('owner-1', 'session-legacy-1');
    assert.deepEqual(
      stored.map((m) => [m.id, m.seq, m.createdAt, m.userId, m.sessionId]),
      [
        ['msg-legacy-1', 1, '2026-01-01T10:00:00.000Z', 'owner-1', 'session-legacy-1'],
        ['msg-legacy-2', 2, '2026-01-01T10:00:00.000Z', 'owner-1', 'session-legacy-1'],
      ]
    );
    assert.deepEqual(stored[1].meta, { partial: true });
  });

  test('should refuse to import over a session id owned by another user', async () => {
    const theirs = await sessions.createSession('user-b', 'Theirs');
    await assert.rejects(
      sessions.importSession(
        { id: theirs.id, userId: 'user-a', title: 'Hijack', createdAt: theirs.createdAt, updatedAt: theirs.updatedAt },
        [{ id: 'msg-hijack', role: 'user', content: 'overwrite', createdAt: theirs.createdAt }]
      ),
      /owned by another user/
    );
    assert.equal((await sessions.getSession('user-b', theirs.id))?.title, 'Theirs');
    assert.equal(await sessions.getSession('user-a', theirs.id), null);
  });
});
