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

export type MessageRole = 'user' | 'assistant' | 'system';

export interface JarvisMessageMeta {
  sources?: string[];
  confidence?: number;
  toolCalls?: unknown[];
  /** True when the stream ended early (client disconnect or provider failure) and `content` is incomplete. */
  partial?: boolean;
}

/** One conversation turn, shared by every surface (web chat, Telegram) that writes to the session. */
export interface JarvisMessage {
  _id?: string;
  id: string;
  userId: string;
  sessionId: string;
  /** 1-based position in the session; orders turns that share a `createdAt` millisecond. */
  seq: number;
  role: MessageRole;
  content: string;
  createdAt: string;
  meta?: JarvisMessageMeta;
}

export type NewJarvisMessage = Pick<JarvisMessage, 'role' | 'content' | 'meta'>;

/** A message being imported with its original id and timestamp (e.g. from the legacy `data/chat.db`). */
export type ImportedJarvisMessage = Pick<JarvisMessage, 'id' | 'role' | 'content' | 'createdAt' | 'meta'>;

/** Which session a user's channel (e.g. `telegram`) is currently writing to; survives restarts. */
export interface ActiveSessionPointer {
  id: string; // `${channel}:${userId}`
  userId: string;
  channel: string;
  sessionId: string;
  updatedAt: string;
}

export interface TaskTag {
  taskNumber: number;
  tag: string; // e.g. "[#1 general]"
}
