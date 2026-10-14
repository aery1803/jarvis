export type TaskStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface JarvisSession {
  _id?: string;
  id: string;
  userId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface JarvisTask {
  _id?: string;
  id: string;
  taskNumber: number;
  sessionId: string;
  userId: string;
  title: string;
  description?: string;
  status: TaskStatus;
  tier: 1 | 2 | 3;
  priority: number; // Higher number = higher priority (interactive = 10, background = 1)
  approvalActionId?: string;
  result?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskTag {
  taskNumber: number;
  tag: string; // e.g. "[#1 general]"
}
