/**
 * Jarvis Local AI Agent: Chat Session & Message Store
 * Authority: FEAT-004, Section 8.1, Section 11
 *
 * The web chat's view of the shared `SessionManager`, scoped to one owner `userId`, so web and Telegram
 * read and write the same sessions and turns. Keeps the web API's `ChatSession`/`ChatMessage` shapes;
 * a session's model lives in its `metadata.model`.
 */

import { DocumentStore } from './collection.js';
import { SessionManager } from '../sessions/manager.js';
import type { JarvisMessage, JarvisMessageMeta, JarvisSession, MessageRole } from '../sessions/types.js';

/** Memory and session owner for web chats when no Telegram owner ID is configured. */
export const DEFAULT_CHAT_USER_ID = 'owner';

/** The resident baseline model installed on the owner's box; `JARVIS_DEFAULT_CHAT_MODEL` overrides it. */
export const FALLBACK_CHAT_MODEL = 'qwen3:8b';

export function resolveDefaultChatModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.JARVIS_DEFAULT_CHAT_MODEL?.trim() || FALLBACK_CHAT_MODEL;
}

export const DEFAULT_CHAT_MODEL = resolveDefaultChatModel();

export interface ChatStoreOptions {
  /** Model a session reports when none was stored with it; defaults to `DEFAULT_CHAT_MODEL`. */
  defaultModel?: string;
}

export interface ChatSession {
  id?: string;
  title: string;
  model: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id?: string;
  sessionId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  meta?: JarvisMessageMeta;
}

function toChatSession(session: JarvisSession, defaultModel: string): ChatSession {
  const model = session.metadata?.model;
  return {
    id: session.id,
    title: session.title,
    model: typeof model === 'string' && model ? model : defaultModel,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function toChatMessage(message: JarvisMessage): ChatMessage {
  return {
    id: message.id,
    sessionId: message.sessionId,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    meta: message.meta,
  };
}

export class ChatStore {
  private sessions: SessionManager;
  private ownedStore: DocumentStore | null;
  private userId: string;
  private defaultModel: string;

  /**
   * `source` is either a database path, for a store of its own that `close()` closes, or the shared
   * `SessionManager`, whose store `close()` leaves open for the Telegram bot.
   */
  constructor(
    source: string | SessionManager = ':memory:',
    userId: string = DEFAULT_CHAT_USER_ID,
    options: ChatStoreOptions = {}
  ) {
    this.defaultModel = options.defaultModel?.trim() || DEFAULT_CHAT_MODEL;
    if (typeof source === 'string') {
      this.ownedStore = new DocumentStore(source);
      this.sessions = new SessionManager(this.ownedStore);
    } else {
      this.ownedStore = null;
      this.sessions = source;
    }
    this.userId = userId;
  }

  public getDefaultModel(): string {
    return this.defaultModel;
  }

  public async createSession(title: string = 'New Conversation', model: string = this.defaultModel): Promise<ChatSession> {
    return toChatSession(await this.sessions.createSession(this.userId, title, { model }), this.defaultModel);
  }

  public async getSessions(): Promise<ChatSession[]> {
    return (await this.sessions.listSessions(this.userId)).map((session) => toChatSession(session, this.defaultModel));
  }

  public async getSession(id: string): Promise<ChatSession | null> {
    const session = await this.sessions.getSession(this.userId, id);
    return session ? toChatSession(session, this.defaultModel) : null;
  }

  public async updateSessionTitle(id: string, title: string): Promise<boolean> {
    return this.sessions.updateSessionTitle(this.userId, id, title);
  }

  public async deleteSession(id: string): Promise<boolean> {
    return this.sessions.deleteSession(this.userId, id);
  }

  /** Throws `SessionNotFoundError` when the session is not one of the owner's. */
  public async addMessage(msg: Omit<ChatMessage, 'id' | 'createdAt'>): Promise<ChatMessage> {
    const message = await this.sessions.addMessage(this.userId, msg.sessionId, {
      role: msg.role,
      content: msg.content,
      meta: msg.meta,
    });
    return toChatMessage(message);
  }

  public async getMessages(sessionId: string): Promise<ChatMessage[]> {
    return (await this.sessions.getMessages(this.userId, sessionId)).map(toChatMessage);
  }

  public close(): void {
    this.ownedStore?.close();
  }
}
