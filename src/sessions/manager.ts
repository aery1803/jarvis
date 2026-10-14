import { DocumentStore, Collection } from '../storage/collection.js';
import { JarvisSession, JarvisTask, TaskStatus } from './types.js';

export class SessionManager {
  private sessionCollection: Collection<JarvisSession>;
  private taskCollection: Collection<JarvisTask>;
  private nextTaskNumber = 1;

  constructor(private store: DocumentStore) {
    this.sessionCollection = this.store.getCollection<JarvisSession>('sessions');
    this.taskCollection = this.store.getCollection<JarvisTask>('tasks');
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
      return true;
    }
    return false;
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
