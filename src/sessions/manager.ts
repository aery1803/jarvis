import crypto from 'node:crypto';
import { DocumentStore, Collection } from '../storage/collection.js';
import {
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

export class SessionManager {
  private sessionCollection: Collection<JarvisSession>;
  private taskCollection: Collection<JarvisTask>;
  private messageCollection: Collection<JarvisMessage>;
  private activeSessionCollection: Collection<ActiveSessionPointer>;
  private nextTaskNumber = 1;

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
    await this.sessionCollection.insertOne(session);
    return session;
  }

  async getSession(userId: string, sessionId: string): Promise<JarvisSession | null> {
    return this.sessionCollection.findOne({ userId, id: sessionId });
  }

  async listSessions(userId: string): Promise<JarvisSession[]> {
    const list = await this.sessionCollection.find({ userId });
    return list.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }

  async updateSessionTitle(userId: string, sessionId: string, newTitle: string): Promise<boolean> {
    const res = await this.sessionCollection.updateOne(
      { userId, id: sessionId },
      { title: newTitle, updatedAt: new Date().toISOString() }
    );
    return Boolean(res);
  }

  async deleteSession(userId: string, sessionId: string): Promise<boolean> {
    const deleted = await this.sessionCollection.deleteOne({ userId, id: sessionId });
    if (deleted) {
      await this.taskCollection.deleteMany({ userId, sessionId });
      await this.messageCollection.deleteMany({ userId, sessionId });
      await this.activeSessionCollection.deleteMany({ userId, sessionId });
      return true;
    }
    return false;
  }

  // --- Conversation Messages ---

  /**
   * Appends a turn to the user's session and bumps the session's `updatedAt`. Throws
   * `SessionNotFoundError` when the session does not exist for this user, so a caller can never write
   * into another user's session.
   */
  async addMessage(userId: string, sessionId: string, message: NewJarvisMessage): Promise<JarvisMessage> {
    // No `await` between the count and the insert: another turn for the same session (a second browser
    // tab, Telegram) could otherwise run in between and take the same `seq`.
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
    this.messageCollection.insertOne(record);
    this.sessionCollection.updateOne({ userId, id: sessionId }, { updatedAt: now });
    return record;
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
    if (!(await this.getSession(userId, sessionId))) {
      return false;
    }
    await this.activeSessionCollection.insertOne({
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
    const pointer = await this.activeSessionCollection.findOne({ id: `${channel}:${userId}` });
    return pointer ? this.getSession(userId, pointer.sessionId) : null;
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
    const taskNumber = this.nextTaskNumber++;
    const tier = params.tier ?? 1;
    const initialStatus: TaskStatus = tier === 2 && params.approvalActionId ? 'waiting_approval' : 'queued';

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

    await this.taskCollection.insertOne(task);
    return task;
  }

  async getTask(taskId: string): Promise<JarvisTask | null> {
    return this.taskCollection.findOne({ id: taskId });
  }

  async listTasks(filter: Partial<Pick<JarvisTask, 'userId' | 'sessionId' | 'status'>> = {}): Promise<JarvisTask[]> {
    const all = await this.taskCollection.find(filter as Record<string, unknown>);
    return all.sort((a, b) => {
      if (b.priority !== a.priority) {
        return b.priority - a.priority; // higher priority first
      }
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(); // older queued first
    });
  }

  async getNextTask(userId?: string): Promise<JarvisTask | null> {
    const filter: Record<string, unknown> = { status: 'queued' };
    if (userId) {
      filter.userId = userId;
    }
    const queued = await this.taskCollection.find(filter);
    if (queued.length === 0) {
      return null;
    }

    queued.sort((a, b) => {
      if (b.priority !== a.priority) {
        return b.priority - a.priority;
      }
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });

    const next = queued[0];
    await this.updateTaskStatus(next.id, 'running');
    next.status = 'running';
    return next;
  }

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
    const res = await this.taskCollection.updateOne({ id: taskId }, update);
    return Boolean(res);
  }

  async cancelTask(taskId: string, reason = 'Cancelled by user'): Promise<boolean> {
    return this.updateTaskStatus(taskId, 'cancelled', undefined, reason);
  }

  async cancelAllActiveTasks(reason = 'Emergency kill switch triggered'): Promise<number> {
    const activeTasks = await this.taskCollection.find({});
    let count = 0;
    for (const task of activeTasks) {
      if (task.status === 'queued' || task.status === 'running' || task.status === 'waiting_approval') {
        await this.updateTaskStatus(task.id, 'cancelled', undefined, reason);
        count++;
      }
    }
    return count;
  }

  formatTaskTag(task: JarvisTask): string {
    const cleanTitle = task.title.replace(/[\r\n\t]/g, ' ').slice(0, 15).trim();
    return `[#${task.taskNumber} ${cleanTitle}]`;
  }
}
