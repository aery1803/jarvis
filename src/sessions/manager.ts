import crypto from 'node:crypto';
import { DocumentStore, Collection } from '../storage/collection.js';
import { newestFirst } from '../utils/ordering.js';
import { redactSensitive } from '../memory/sensitive.js';
import type {
  ActiveSessionPointer,
  ImportedJarvisMessage,
  JarvisMessage,
  JarvisSession,
  JarvisTask,
  NewJarvisMessage,
  TaskStatus,
} from './types.js';

export class SessionNotFoundError extends Error {
  constructor(
    public readonly userId: string,
    public readonly sessionId: string
  ) {
    super(`Session ${sessionId} not found for user ${userId}`);
    this.name = 'SessionNotFoundError';
  }
}

/** An imported session's id already belongs to another user. */
export class SessionConflictError extends Error {
  constructor(public readonly sessionId: string) {
    super(`Cannot import session ${sessionId}: the id is owned by another user`);
    this.name = 'SessionConflictError';
  }
}

/** Lets `runTask` stop waiting for work that ignores its `AbortSignal` once the task is cancelled. */
class TaskAbortedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'TaskAbortedError';
  }
}

export type TaskRunOutcome<T> =
  | { status: 'done'; value: T }
  | { status: 'failed'; error: string }
  | { status: 'cancelled'; reason: string }
  | { status: 'skipped'; reason: string };

const ACTIVE_STATUSES: TaskStatus[] = ['queued', 'running', 'waiting_approval'];
const MAX_TASK_TEXT_CHARS = 2_000;

function abortReason(signal: AbortSignal): string {
  return typeof signal.reason === 'string' ? signal.reason : 'Cancelled';
}

function clampTaskText(text: string): string {
  const safe = redactSensitive(text);
  return safe.length > MAX_TASK_TEXT_CHARS ? `${safe.slice(0, MAX_TASK_TEXT_CHARS)}...` : safe;
}

export class SessionManager {
  private sessionCollection: Collection<JarvisSession>;
  private taskCollection: Collection<JarvisTask>;
  private messageCollection: Collection<JarvisMessage>;
  private activeSessionCollection: Collection<ActiveSessionPointer>;
  private lastTaskNumber = 0;
  private runningTasks = new Map<string, AbortController>();

  constructor(private store: DocumentStore) {
    this.sessionCollection = this.store.getCollection<JarvisSession>('sessions');
    this.taskCollection = this.store.getCollection<JarvisTask>('tasks');
    this.messageCollection = this.store.getCollection<JarvisMessage>('messages');
    this.activeSessionCollection = this.store.getCollection<ActiveSessionPointer>('active_sessions');
  }

  // --- Session Management ---

  async createSession(userId: string, title = 'New Conversation', metadata?: Record<string, unknown>): Promise<JarvisSession> {
    const now = new Date().toISOString();
    const session: JarvisSession = {
      id: `sess-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      userId,
      title,
      createdAt: now,
      updatedAt: now,
      metadata,
    };
    this.sessionCollection.insertUnique(session);
    return session;
  }

  async getSession(userId: string, sessionId: string): Promise<JarvisSession | null> {
    return this.sessionCollection.findOne({ userId, id: sessionId });
  }

  /** Most recently active first; same-millisecond ties fall back to insertion order (see utils/ordering.ts). */
  async listSessions(userId: string): Promise<JarvisSession[]> {
    const list = await this.sessionCollection.find({ userId });
    return newestFirst(list, (session) => session.updatedAt);
  }

  async updateSessionTitle(userId: string, sessionId: string, newTitle: string): Promise<boolean> {
    const res = await this.sessionCollection.updateOne(
      { userId, id: sessionId },
      { title: newTitle, updatedAt: new Date().toISOString() }
    );
    return Boolean(res);
  }

  /**
   * Removes the session and everything that points at it in one transaction, children first, so a failure
   * midway leaves the whole session in place instead of orphaned rows. Work still running for the
   * session's tasks is aborted.
   */
  async deleteSession(userId: string, sessionId: string): Promise<boolean> {
    if (!userId || !sessionId) {
      return false;
    }
    const taskIds: string[] = [];
    const deleted = this.store.transaction(() => {
      if (!this.sessionCollection.findOne({ userId, id: sessionId })) {
        return false;
      }
      for (const task of this.taskCollection.find({ userId, sessionId })) taskIds.push(task.id);
      this.messageCollection.deleteMany({ userId, sessionId });
      this.taskCollection.deleteMany({ userId, sessionId });
      this.activeSessionCollection.deleteMany({ userId, sessionId });
      this.sessionCollection.deleteOne({ userId, id: sessionId });
      return true;
    });
    if (deleted) {
      for (const taskId of taskIds) this.abortRunning(taskId, 'Session deleted');
    }
    return deleted;
  }

  /** Removes messages, tasks and active pointers whose session no longer exists (left by older, non-atomic deletes). */
  async purgeOrphanedRows(): Promise<{ messages: number; tasks: number; pointers: number }> {
    return this.store.transaction(() => {
      const sessionIds = new Set(this.sessionCollection.find().map((session) => session.id));
      const purge = <T extends { id?: string | number; sessionId: string }>(collection: Collection<T>): number => {
        let removed = 0;
        for (const row of collection.find()) {
          if (!sessionIds.has(row.sessionId) && collection.deleteOne({ id: row.id } as never)) removed++;
        }
        return removed;
      };
      return {
        messages: purge(this.messageCollection),
        tasks: purge(this.taskCollection),
        pointers: purge(this.activeSessionCollection),
      };
    });
  }

  // --- Conversation Messages ---

  /**
   * Appends a turn to the user's session and bumps the session's `updatedAt`. Throws
   * `SessionNotFoundError` when the session does not exist for this user, so a caller can never write
   * into another user's session.
   */
  async addMessage(userId: string, sessionId: string, message: NewJarvisMessage): Promise<JarvisMessage> {
    // One transaction around the count and the insert: another turn for the same session (a second browser
    // tab, the Telegram process) could otherwise take the same `seq`.
    return this.store.transaction(() => {
      if (!this.sessionCollection.findOne({ userId, id: sessionId })) {
        throw new SessionNotFoundError(userId, sessionId);
      }
      const now = new Date().toISOString();
      const record: JarvisMessage = {
        id: `msg-${crypto.randomUUID()}`,
        userId,
        sessionId,
        seq: this.messageCollection.count({ userId, sessionId }) + 1,
        role: message.role,
        content: message.content,
        createdAt: now,
        meta: message.meta,
      };
      this.messageCollection.insertUnique(record);
      this.sessionCollection.updateOne({ userId, id: sessionId }, { updatedAt: now });
      return record;
    });
  }

  /** The session's turns, oldest first; empty for a session that is missing or belongs to another user. */
  async getMessages(userId: string, sessionId: string): Promise<JarvisMessage[]> {
    const messages = await this.messageCollection.find({ userId, sessionId });
    return messages.sort((a, b) => a.seq - b.seq);
  }

  /**
   * Imports a session and its messages (oldest first) with their original ids and timestamps, skipping
   * anything already imported, so an interrupted import can be run again. Each call is one transaction.
   * `insertOne` replaces by id, so an id that already belongs to another user is refused with
   * `SessionConflictError` instead of being overwritten.
   */
  async importSession(
    session: JarvisSession,
    messages: ImportedJarvisMessage[]
  ): Promise<{ sessionImported: boolean; messagesImported: number }> {
    return this.store.transaction(() => {
      const existing = this.sessionCollection.findOne({ id: session.id });
      if (existing && existing.userId !== session.userId) {
        throw new SessionConflictError(session.id);
      }
      if (!existing) {
        this.sessionCollection.insertOne(session);
      }

      let seq = this.messageCollection.count({ userId: session.userId, sessionId: session.id });
      let messagesImported = 0;
      for (const message of messages) {
        if (this.messageCollection.findOne({ id: message.id })) {
          continue;
        }
        seq++;
        this.messageCollection.insertOne({ ...message, userId: session.userId, sessionId: session.id, seq });
        messagesImported++;
      }
      return { sessionImported: !existing, messagesImported };
    });
  }

  // --- Active Session per Channel ---

  /** Points a user's channel (e.g. `telegram`) at one of their sessions; false if the session is not theirs. */
  async setActiveSession(userId: string, channel: string, sessionId: string): Promise<boolean> {
    return this.store.transaction(() => this.pointChannelAt(userId, channel, sessionId));
  }

  private pointChannelAt(userId: string, channel: string, sessionId: string): boolean {
    if (!this.sessionCollection.findOne({ userId, id: sessionId })) {
      return false;
    }
    this.activeSessionCollection.upsertOne({
      id: `${channel}:${userId}`,
      userId,
      channel,
      sessionId,
      updatedAt: new Date().toISOString(),
    });
    return true;
  }

  /** The session the channel last pointed at, or null if none was set or that session has since been deleted. */
  async getActiveSession(userId: string, channel: string): Promise<JarvisSession | null> {
    const pointer = this.activeSessionCollection.findOne({ id: `${channel}:${userId}` });
    return pointer ? this.getSession(userId, pointer.sessionId) : null;
  }

  /** The channel's active session, creating one and pointing the channel at it, in one step, when there is none. */
  async getOrCreateActiveSession(
    userId: string,
    channel: string,
    title = 'New Conversation',
    metadata?: Record<string, unknown>
  ): Promise<{ session: JarvisSession; created: boolean }> {
    return this.store.transaction(() => {
      const pointer = this.activeSessionCollection.findOne({ id: `${channel}:${userId}` });
      const existing = pointer ? this.sessionCollection.findOne({ userId, id: pointer.sessionId }) : null;
      if (existing) {
        return { session: existing, created: false };
      }
      const now = new Date().toISOString();
      const session = this.sessionCollection.insertUnique({
        id: `sess-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
        userId,
        title,
        createdAt: now,
        updatedAt: now,
        metadata,
      });
      this.pointChannelAt(userId, channel, session.id);
      return { session, created: true };
    });
  }

  // --- Task Queue & Scheduling ---

  async createTask(params: {
    userId: string;
    sessionId: string;
    title: string;
    description?: string;
    tier?: 1 | 2 | 3;
    priority?: number;
    approvalActionId?: string;
  }): Promise<JarvisTask> {
    const now = new Date().toISOString();
    const tier = params.tier ?? 1;
    const initialStatus: TaskStatus = tier === 2 && params.approvalActionId ? 'waiting_approval' : 'queued';

    // The number is derived from the stored tasks, not a counter that restarts at 1 with the process.
    return this.store.transaction(() => {
      const taskNumber = Math.max(this.taskCollection.max('taskNumber') ?? 0, this.lastTaskNumber) + 1;
      this.lastTaskNumber = taskNumber;
      const task: JarvisTask = {
        id: `task-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
        taskNumber,
        sessionId: params.sessionId,
        userId: params.userId,
        title: params.title,
        description: params.description,
        status: initialStatus,
        tier,
        priority: params.priority ?? 5,
        approvalActionId: params.approvalActionId,
        createdAt: now,
        updatedAt: now,
      };
      return this.taskCollection.insertUnique(task);
    });
  }

  async getTask(taskId: string): Promise<JarvisTask | null> {
    return this.taskCollection.findOne({ id: taskId });
  }

  async listTasks(filter: Partial<Pick<JarvisTask, 'userId' | 'sessionId' | 'status'>> = {}): Promise<JarvisTask[]> {
    const all = await this.taskCollection.find(filter as Record<string, unknown>);
    return all.sort((a, b) => b.priority - a.priority || a.taskNumber - b.taskNumber); // higher priority first, then oldest
  }

  /** Claims the best queued task (highest priority, then oldest) by moving it to `running`. */
  async getNextTask(userId?: string): Promise<JarvisTask | null> {
    return this.store.transaction(() => {
      const filter: Record<string, unknown> = { status: 'queued' };
      if (userId) {
        filter.userId = userId;
      }
      const [next] = this.taskCollection.find(filter).sort((a, b) => b.priority - a.priority || a.taskNumber - b.taskNumber);
      if (!next || !this.transition(next.id, ['queued'], 'running')) {
        return null;
      }
      return { ...next, status: 'running' as const };
    });
  }

  /** Sets a status without checking the current one. Prefer `completeTask`, `failTask`, `cancelTask` and `runTask`. */
  async updateTaskStatus(
    taskId: string,
    status: TaskStatus,
    result?: string,
    error?: string
  ): Promise<boolean> {
    const update: Partial<JarvisTask> = {
      status,
      updatedAt: new Date().toISOString(),
    };
    if (result !== undefined) {
      update.result = result;
    }
    if (error !== undefined) {
      update.error = error;
    }
    const res = this.taskCollection.updateOne({ id: taskId }, update);
    if (status === 'cancelled') {
      this.abortRunning(taskId, error ?? 'Cancelled');
    }
    return Boolean(res);
  }

  /** Moves a task to `status` only from one of the `from` states, so a finished or cancelled task is never revived. */
  private transition(taskId: string, from: TaskStatus[], status: TaskStatus, result?: string, error?: string): boolean {
    return this.store.transaction(() => {
      const task = this.taskCollection.findOne({ id: taskId });
      if (!task || !from.includes(task.status)) {
        return false;
      }
      const update: Partial<JarvisTask> = { status, updatedAt: new Date().toISOString() };
      if (result !== undefined) update.result = clampTaskText(result);
      if (error !== undefined) update.error = clampTaskText(error);
      return this.taskCollection.updateOne({ id: taskId }, update);
    });
  }

  private abortRunning(taskId: string, reason: string): boolean {
    const controller = this.runningTasks.get(taskId);
    if (!controller) return false;
    this.runningTasks.delete(taskId);
    controller.abort(reason);
    return true;
  }

  async completeTask(taskId: string, result?: string): Promise<boolean> {
    return this.transition(taskId, ['queued', 'running'], 'done', result);
  }

  async failTask(taskId: string, error: string): Promise<boolean> {
    return this.transition(taskId, ['queued', 'running', 'waiting_approval'], 'failed', undefined, error);
  }

  /**
   * Runs `fn` as the task: queued -> running -> done, or failed with the error. `fn` receives an
   * `AbortSignal` that `cancelTask`, `cancelAllActiveTasks` (the kill switch) and `deleteSession` abort;
   * on abort the call returns `cancelled` at once even if `fn` ignores the signal. A task that is not
   * `queued` (for instance `waiting_approval`) is not run. Never throws for a failing `fn`.
   */
  async runTask<T>(taskId: string, fn: (signal: AbortSignal) => Promise<T> | T): Promise<TaskRunOutcome<T>> {
    const task = this.taskCollection.findOne({ id: taskId });
    if (!task) {
      return { status: 'skipped', reason: `Task ${taskId} not found` };
    }
    if (!this.transition(taskId, ['queued'], 'running')) {
      return { status: 'skipped', reason: `Task is ${task.status}, not queued` };
    }

    const controller = new AbortController();
    this.runningTasks.set(taskId, controller);
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new TaskAbortedError(abortReason(controller.signal))), { once: true });
    });
    aborted.catch(() => undefined);
    const work = Promise.resolve().then(() => fn(controller.signal));
    work.catch(() => undefined);

    try {
      const value = await Promise.race([work, aborted]);
      const done = this.transition(taskId, ['running'], 'done', typeof value === 'string' ? value : undefined);
      return done ? { status: 'done', value } : { status: 'cancelled', reason: this.cancelReason(taskId) };
    } catch (err: unknown) {
      if (err instanceof TaskAbortedError || controller.signal.aborted) {
        return { status: 'cancelled', reason: this.cancelReason(taskId) };
      }
      const message = err instanceof Error ? err.message : String(err);
      this.transition(taskId, ['running'], 'failed', undefined, message);
      return { status: 'failed', error: clampTaskText(message) };
    } finally {
      if (this.runningTasks.get(taskId) === controller) this.runningTasks.delete(taskId);
    }
  }

  private cancelReason(taskId: string): string {
    return this.taskCollection.findOne({ id: taskId })?.error ?? 'Cancelled';
  }

  /** Cancels an active task and aborts its work if it is running; false if it was already finished. */
  async cancelTask(taskId: string, reason = 'Cancelled by user'): Promise<boolean> {
    const cancelled = this.transition(taskId, ACTIVE_STATUSES, 'cancelled', undefined, reason);
    if (cancelled) this.abortRunning(taskId, reason);
    return cancelled;
  }

  /** Kill switch path: aborts every in-flight task, then marks every active task cancelled. Returns how many were marked. */
  async cancelAllActiveTasks(reason = 'Emergency kill switch triggered'): Promise<number> {
    for (const controller of [...this.runningTasks.values()]) controller.abort(reason);
    this.runningTasks.clear();

    let count = 0;
    for (const status of ACTIVE_STATUSES) {
      for (const task of this.taskCollection.find({ status })) {
        if (this.transition(task.id, ACTIVE_STATUSES, 'cancelled', undefined, reason)) count++;
      }
    }
    return count;
  }

  formatTaskTag(task: JarvisTask): string {
    const cleanTitle = task.title.replace(/[\r\n\t]/g, ' ').slice(0, 15).trim();
    return `[#${task.taskNumber} ${cleanTitle}]`;
  }
}
