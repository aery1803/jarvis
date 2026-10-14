import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DocumentStore } from '../src/storage/collection.js';
import { SessionManager, SessionNotFoundError } from '../src/sessions/manager.js';
import { MemoryManager } from '../src/memory/manager.js';

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

describe('SessionManager task lifecycle, numbering and atomic deletes', () => {
  const dbPath = path.resolve(process.cwd(), 'data', 'test-session-lifecycle.db');
  let store: DocumentStore;
  let sessions: SessionManager;

  beforeEach(() => {
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    store = new DocumentStore(dbPath);
    sessions = new SessionManager(store);
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  test('task numbers continue after a restart instead of colliding at #1', async () => {
    const s = await sessions.createSession('owner', 'Work');
    const a = await sessions.createTask({ userId: 'owner', sessionId: s.id, title: 'first' });
    const b = await sessions.createTask({ userId: 'owner', sessionId: s.id, title: 'second' });
    assert.deepEqual([a.taskNumber, b.taskNumber], [1, 2]);

    store.close();
    store = new DocumentStore(dbPath);
    sessions = new SessionManager(store);
    const c = await sessions.createTask({ userId: 'owner', sessionId: s.id, title: 'third' });
    assert.equal(c.taskNumber, 3);
  });

  test('two managers on one database never hand out the same task number', async () => {
    const other = new SessionManager(store);
    const s = await sessions.createSession('owner', 'Work');
    const numbers = [
      (await sessions.createTask({ userId: 'owner', sessionId: s.id, title: 'a' })).taskNumber,
      (await other.createTask({ userId: 'owner', sessionId: s.id, title: 'b' })).taskNumber,
      (await sessions.createTask({ userId: 'owner', sessionId: s.id, title: 'c' })).taskNumber,
    ];
    assert.deepEqual(numbers, [1, 2, 3]);
  });

  test('deleteSession removes children first and the session last, all or nothing', async () => {
    const s = await sessions.createSession('owner', 'Doomed');
    await sessions.addMessage('owner', s.id, { role: 'user', content: 'hi' });
    await sessions.createTask({ userId: 'owner', sessionId: s.id, title: 'job' });
    await sessions.setActiveSession('owner', 'telegram', s.id);
    const keep = await sessions.createSession('owner', 'Keep');
    await sessions.addMessage('owner', keep.id, { role: 'user', content: 'stay' });

    assert.equal(await sessions.deleteSession('owner', s.id), true);
    assert.equal(await sessions.getSession('owner', s.id), null);
    assert.equal((await sessions.getMessages('owner', s.id)).length, 0);
    assert.equal((await sessions.listTasks({ sessionId: s.id })).length, 0);
    assert.equal(await sessions.getActiveSession('owner', 'telegram'), null);
    assert.equal((await sessions.getMessages('owner', keep.id)).length, 1);
    assert.equal(await sessions.deleteSession('owner', s.id), false);
  });

  test('a failure while deleting leaves the whole session in place', async () => {
    const s = await sessions.createSession('owner', 'Fragile');
    await sessions.addMessage('owner', s.id, { role: 'user', content: 'hi' });
    await sessions.createTask({ userId: 'owner', sessionId: s.id, title: 'job' });
    // @ts-expect-error reach into the private collection to force the third delete to fail
    sessions.activeSessionCollection.deleteMany = () => {
      throw new Error('disk full');
    };
    await assert.rejects(sessions.deleteSession('owner', s.id), /disk full/);
    assert.ok(await sessions.getSession('owner', s.id));
    assert.equal((await sessions.getMessages('owner', s.id)).length, 1);
    assert.equal((await sessions.listTasks({ sessionId: s.id })).length, 1);
  });

  test('deleteSession with a missing id deletes nothing instead of wiping the user', async () => {
    const s = await sessions.createSession('owner', 'Safe');
    await sessions.addMessage('owner', s.id, { role: 'user', content: 'hi' });
    assert.equal(await sessions.deleteSession('owner', undefined as unknown as string), false);
    assert.equal((await sessions.getMessages('owner', s.id)).length, 1);
  });

  test('purgeOrphanedRows removes rows whose session is gone and keeps the rest', async () => {
    const s = await sessions.createSession('owner', 'Live');
    await sessions.addMessage('owner', s.id, { role: 'user', content: 'kept' });
    store.collection('messages').insertOne({ id: 'orphan', userId: 'owner', sessionId: 'gone', seq: 1, role: 'user', content: 'x', createdAt: new Date().toISOString() });
    store.collection('tasks').insertOne({ id: 'orphan-task', sessionId: 'gone', userId: 'owner' });
    const purged = await sessions.purgeOrphanedRows();
    assert.deepEqual(purged, { messages: 1, tasks: 1, pointers: 0, memories: 0 });
    assert.equal((await sessions.getMessages('owner', s.id)).length, 1);
  });

  test('deleting a session also deletes its summaries and episodes, and only its own', async () => {
    const memory = new MemoryManager(store);
    const doomed = await sessions.createSession('owner', 'Doomed');
    const kept = await sessions.createSession('owner', 'Kept');
    await memory.saveSessionSummary('owner', doomed.id, 'summary of the doomed chat', 6);
    await memory.saveSessionSummary('owner', kept.id, 'summary of the kept chat', 6);
    await memory.recordEpisode({ userId: 'owner', sessionId: doomed.id, goal: 'doomed goal', steps: [], outcome: 'doomed outcome' });
    await memory.recordEpisode({ userId: 'owner', sessionId: kept.id, goal: 'kept goal', steps: [], outcome: 'kept outcome' });
    await memory.recordEpisode({ userId: 'other', sessionId: doomed.id, goal: 'same id, other user', steps: [], outcome: 'x' });

    assert.equal(await sessions.deleteSession('owner', doomed.id), true);
    assert.deepEqual(await memory.getSessionSummaries('owner', doomed.id), []);
    assert.deepEqual(await memory.queryEpisodes({ userId: 'owner', sessionId: doomed.id }), []);
    assert.equal((await memory.getSessionSummaries('owner')).length, 1, 'nothing from the deleted chat reaches other sessions');
    assert.equal((await memory.getSessionSummaries('owner'))[0].sessionId, kept.id);
    assert.equal((await memory.queryEpisodes({ userId: 'owner', sessionId: kept.id })).length, 1);
    assert.equal((await memory.queryEpisodes({ userId: 'other', sessionId: doomed.id })).length, 1, 'another user\'s rows are not touched');
  });

  test('a failed delete leaves the summaries in place (one transaction)', async () => {
    const memory = new MemoryManager(store);
    const s = await sessions.createSession('owner', 'Keep');
    await memory.saveSessionSummary('owner', s.id, 'still here', 6);
    assert.equal(await sessions.deleteSession('intruder', s.id), false);
    assert.equal((await memory.getSessionSummaries('owner', s.id)).length, 1);
  });

  test('purgeOrphanedRows removes summaries and episodes of sessions that are gone', async () => {
    const memory = new MemoryManager(store);
    const live = await sessions.createSession('owner', 'Live');
    await memory.saveSessionSummary('owner', live.id, 'live summary', 6);
    await memory.saveSessionSummary('owner', 'gone', 'orphan summary', 6);
    await memory.recordEpisode({ userId: 'owner', sessionId: 'gone', goal: 'g', steps: [], outcome: 'o' });
    const purged = await sessions.purgeOrphanedRows();
    assert.equal(purged.memories, 2);
    assert.equal((await memory.getSessionSummaries('owner')).length, 1);
  });

  test('reconcileInterruptedTasks cancels active tasks with the reason and spares finished ones and live runs', async () => {
    const s = await sessions.createSession('owner', 'Work');
    const queued = await sessions.createTask({ userId: 'owner', sessionId: s.id, title: 'queued' });
    const running = await sessions.createTask({ userId: 'owner', sessionId: s.id, title: 'running' });
    const waiting = await sessions.createTask({ userId: 'owner', sessionId: s.id, title: 'waiting', tier: 2, approvalActionId: 'a1' });
    const finished = await sessions.createTask({ userId: 'owner', sessionId: s.id, title: 'finished' });
    const live = await sessions.createTask({ userId: 'owner', sessionId: s.id, title: 'live in this process' });
    await sessions.updateTaskStatus(running.id, 'running');
    await sessions.completeTask(finished.id, 'ok');

    let release!: () => void;
    const liveRun = sessions.runTask(live.id, () => new Promise<void>((resolve) => (release = resolve)));
    await new Promise((r) => setImmediate(r));
    assert.equal(await sessions.reconcileInterruptedTasks('Interrupted by restart'), 3);
    for (const id of [queued.id, running.id, waiting.id]) {
      const task = await sessions.getTask(id);
      assert.equal(task?.status, 'cancelled');
      assert.equal(task?.error, 'Interrupted by restart');
    }
    assert.equal((await sessions.getTask(finished.id))?.status, 'done');
    assert.equal((await sessions.getTask(live.id))?.status, 'running', 'a task this process is running is not interrupted');
    release();
    await liveRun;
    assert.equal(await sessions.reconcileInterruptedTasks(), 0, 'a second pass finds nothing');
  });

  test('completeTask and failTask move a task out of the queue and never revive a finished one', async () => {
    const s = await sessions.createSession('owner', 'Work');
    const a = await sessions.createTask({ userId: 'owner', sessionId: s.id, title: 'a' });
    const b = await sessions.createTask({ userId: 'owner', sessionId: s.id, title: 'b' });
    assert.equal(await sessions.completeTask(a.id, 'all good'), true);
    assert.equal(await sessions.failTask(b.id, 'it broke'), true);
    assert.deepEqual(
      [(await sessions.getTask(a.id))?.status, (await sessions.getTask(a.id))?.result, (await sessions.getTask(b.id))?.status, (await sessions.getTask(b.id))?.error],
      ['done', 'all good', 'failed', 'it broke']
    );
    assert.equal(await sessions.failTask(a.id, 'late'), false);
    assert.equal(await sessions.cancelTask(a.id), false);
    assert.equal((await sessions.getTask(a.id))?.status, 'done');
    assert.equal((await sessions.listTasks({ status: 'queued' })).length, 0);
  });

  test('failTask redacts secrets from the stored error', async () => {
    const s = await sessions.createSession('owner', 'Work');
    const t = await sessions.createTask({ userId: 'owner', sessionId: s.id, title: 't' });
    await sessions.failTask(t.id, 'auth failed with Bearer abcdefghijklmnop1234567890');
    assert.ok(!(await sessions.getTask(t.id))?.error?.includes('abcdefghijklmnop'));
  });

  test('runTask marks running, then done with the returned text', async () => {
    const s = await sessions.createSession('owner', 'Work');
    const t = await sessions.createTask({ userId: 'owner', sessionId: s.id, title: 't' });
    let statusInside: string | undefined;
    const outcome = await sessions.runTask(t.id, async () => {
      statusInside = (await sessions.getTask(t.id))?.status;
      return 'the answer';
    });
    assert.deepEqual(outcome, { status: 'done', value: 'the answer' });
    assert.equal(statusInside, 'running');
    const stored = await sessions.getTask(t.id);
    assert.deepEqual([stored?.status, stored?.result], ['done', 'the answer']);
  });

  test('runTask records a failure without throwing', async () => {
    const s = await sessions.createSession('owner', 'Work');
    const t = await sessions.createTask({ userId: 'owner', sessionId: s.id, title: 't' });
    const outcome = await sessions.runTask(t.id, () => {
      throw new Error('model offline');
    });
    assert.deepEqual(outcome, { status: 'failed', error: 'model offline' });
    const stored = await sessions.getTask(t.id);
    assert.deepEqual([stored?.status, stored?.error], ['failed', 'model offline']);
  });

  test('cancelAllActiveTasks aborts in-flight work, not just the status', async () => {
    const s = await sessions.createSession('owner', 'Work');
    const t = await sessions.createTask({ userId: 'owner', sessionId: s.id, title: 't' });
    const queued = await sessions.createTask({ userId: 'owner', sessionId: s.id, title: 'waiting' });
    let aborted = false;
    let started!: () => void;
    const hasStarted = new Promise<void>((resolve) => (started = resolve));
    const run = sessions.runTask(t.id, (signal) => {
      signal.addEventListener('abort', () => (aborted = true));
      started();
      return new Promise<string>(() => undefined);
    });
    await hasStarted;

    assert.equal(await sessions.cancelAllActiveTasks('kill switch'), 2);
    assert.equal(aborted, true);
    assert.deepEqual(await run, { status: 'cancelled', reason: 'kill switch' });
    assert.equal((await sessions.getTask(t.id))?.status, 'cancelled');
    assert.equal((await sessions.getTask(queued.id))?.status, 'cancelled');
  });

  test('a cancelled task stays cancelled even when its work finishes anyway', async () => {
    const s = await sessions.createSession('owner', 'Work');
    const t = await sessions.createTask({ userId: 'owner', sessionId: s.id, title: 't' });
    let finish!: (value: string) => void;
    let started!: () => void;
    const hasStarted = new Promise<void>((resolve) => (started = resolve));
    const run = sessions.runTask(t.id, () => {
      started();
      return new Promise<string>((resolve) => (finish = resolve));
    });
    await hasStarted;
    assert.equal(await sessions.cancelTask(t.id, 'user said stop'), true);
    finish('too late');
    assert.deepEqual(await run, { status: 'cancelled', reason: 'user said stop' });
    assert.equal((await sessions.getTask(t.id))?.status, 'cancelled');
    assert.equal((await sessions.getTask(t.id))?.result, undefined);
  });

  test('runTask will not run a task that is waiting for approval, or one that does not exist', async () => {
    const s = await sessions.createSession('owner', 'Work');
    const t = await sessions.createTask({ userId: 'owner', sessionId: s.id, title: 'risky', tier: 2, approvalActionId: 'act-1' });
    let ran = false;
    const outcome = await sessions.runTask(t.id, () => {
      ran = true;
    });
    assert.equal(outcome.status, 'skipped');
    assert.equal(ran, false);
    assert.equal((await sessions.getTask(t.id))?.status, 'waiting_approval');
    assert.equal((await sessions.runTask('task-missing', () => 1)).status, 'skipped');
  });

  test('deleting a session aborts its running task', async () => {
    const s = await sessions.createSession('owner', 'Work');
    const t = await sessions.createTask({ userId: 'owner', sessionId: s.id, title: 't' });
    let started!: () => void;
    const hasStarted = new Promise<void>((resolve) => (started = resolve));
    const run = sessions.runTask(t.id, () => {
      started();
      return new Promise<string>(() => undefined);
    });
    await hasStarted;
    await sessions.deleteSession('owner', s.id);
    assert.equal((await run).status, 'cancelled');
  });

  test('getOrCreateActiveSession creates and points in one step, then reuses it across a restart', async () => {
    const first = await sessions.getOrCreateActiveSession('owner', 'telegram', 'Default Session');
    assert.equal(first.created, true);
    assert.equal(first.session.title, 'Default Session');
    assert.equal((await sessions.getActiveSession('owner', 'telegram'))?.id, first.session.id);

    store.close();
    store = new DocumentStore(dbPath);
    sessions = new SessionManager(store);
    const again = await sessions.getOrCreateActiveSession('owner', 'telegram', 'Default Session');
    assert.equal(again.created, false);
    assert.equal(again.session.id, first.session.id);
    assert.equal((await sessions.listSessions('owner')).length, 1);
  });

  test('getOrCreateActiveSession replaces a pointer whose session was deleted', async () => {
    const first = await sessions.getOrCreateActiveSession('owner', 'telegram');
    await sessions.deleteSession('owner', first.session.id);
    const next = await sessions.getOrCreateActiveSession('owner', 'telegram');
    assert.equal(next.created, true);
    assert.notEqual(next.session.id, first.session.id);
  });

  test('setActiveSession returns false for another user\'s session and writes no pointer', async () => {
    const theirs = await sessions.createSession('other', 'Theirs');
    assert.equal(await sessions.setActiveSession('owner', 'telegram', theirs.id), false);
    assert.equal(await sessions.getActiveSession('owner', 'telegram'), null);
    const mine = await sessions.createSession('owner', 'Mine');
    assert.equal(await sessions.setActiveSession('owner', 'telegram', mine.id), true);
    assert.equal(await sessions.setActiveSession('owner', 'telegram', mine.id), true);
  });
});
