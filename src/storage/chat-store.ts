/**
 * Jarvis Local AI Agent: Chat Session & Message Store
 * Authority: FEAT-004, Section 8.1, Section 11
 *
 * Backed by the MongoDB-style DocumentStore over native SQLite.
 */

import crypto from 'node:crypto';
import { DocumentStore, type Collection } from './collection.js';

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
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  meta?: {
    sources?: string[];
    confidence?: number;
    toolCalls?: any[];
  };
}

export class ChatStore {
  private store: DocumentStore;
  private sessions: Collection<ChatSession>;
  private messages: Collection<ChatMessage>;

  constructor(dbPath?: string) {
    this.store = new DocumentStore(dbPath);
    this.sessions = this.store.collection<ChatSession>('chat_sessions');
    this.messages = this.store.collection<ChatMessage>('chat_messages');
  }

  public createSession(title: string = 'New Conversation', model: string = 'qwen2.5:7b'): ChatSession {
    const now = new Date().toISOString();
    const session: ChatSession = {
      id: `session-${crypto.randomUUID()}`,
      title,
      model,
      createdAt: now,
      updatedAt: now,
    };
    return this.sessions.insertOne(session);
  }

  public getSessions(): ChatSession[] {
    const list = this.sessions.find();
    // Sort newest first
    return list.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }

  public getSession(id: string): ChatSession | null {
    return this.sessions.findOne({ id });
  }

  public updateSessionTitle(id: string, title: string): boolean {
    const now = new Date().toISOString();
    return this.sessions.updateOne({ id }, { title, updatedAt: now });
  }

  public deleteSession(id: string): boolean {
    this.messages.deleteMany({ sessionId: id });
    return this.sessions.deleteOne({ id });
  }

  public addMessage(msg: Omit<ChatMessage, 'id' | 'createdAt'>): ChatMessage {
    const now = new Date().toISOString();
    const record: ChatMessage = {
      ...msg,
      id: `msg-${crypto.randomUUID()}`,
      createdAt: now,
    };

    const inserted = this.messages.insertOne(record);
    this.sessions.updateOne({ id: msg.sessionId }, { updatedAt: now });
    return inserted;
  }

  public getMessages(sessionId: string): ChatMessage[] {
    const msgs = this.messages.find({ sessionId });
    return msgs.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  }

  public close(): void {
    this.store.close();
  }
}
