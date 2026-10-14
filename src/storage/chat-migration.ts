/**
 * Jarvis Local AI Agent: Legacy Web Chat Migration
 * Authority: Section 11.2, CODING_RULES.md Section 2.3 (schema migrations)
 *
 * Before `ChatStore` delegated to `SessionManager`, the web chat kept its own `data/chat.db` (collections
 * `chat_sessions` and `chat_messages`, without a `userId`). This imports that data once into the shared
 * store under the owner's user ID. The legacy file is opened read-only and is never changed or deleted.
 */

import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { DocumentStore } from './collection.js';
import { SessionConflictError, type SessionManager } from '../sessions/manager.js';
import type { ImportedJarvisMessage } from '../sessions/types.js';
import { logger } from '../utils/logger.js';

export const CHAT_DB_MIGRATION_ID = 'chat-db-to-session-manager-v1';

const LEGACY_SESSIONS_TABLE = 'col_chat_sessions';
const LEGACY_MESSAGES_TABLE = 'col_chat_messages';

const LegacySessionSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  model: z.string().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

const LegacyMessageSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
  createdAt: z.iso.datetime(),
  meta: z
    .object({
      sources: z.array(z.string()).optional(),
      confidence: z.number().optional(),
      toolCalls: z.array(z.unknown()).optional(),
      partial: z.boolean().optional(),
    })
    .optional(),
});

type LegacySession = z.infer<typeof LegacySessionSchema>;

export interface ChatMigrationOptions {
  legacyDbPath: string;
  store: DocumentStore;
  sessionManager: SessionManager;
  /** Owner the legacy web chats, which had no user, are assigned to. */
  userId: string;
}

export interface ChatMigrationResult {
  status: 'migrated' | 'already-migrated' | 'no-legacy-db';
  sessionsImported: number;
  messagesImported: number;
  /** Legacy rows left out: unreadable or malformed, or messages whose session was missing or left out. */
  skipped: number;
}

interface MigrationRecord {
  id: string;
  completedAt: string;
  sessionsImported: number;
  messagesImported: number;
  skipped: number;
}

/** Every row's `doc`, oldest first; rows whose JSON does not parse come back as `undefined`. */
function readLegacyDocs(db: DatabaseSync, table: string): unknown[] {
  const exists = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table);
  if (!exists) {
    return [];
  }
  const rows = db.prepare(`SELECT doc FROM ${table} ORDER BY created_at, rowid`).all() as Array<{ doc: string }>;
  return rows.map((row) => {
    try {
      return JSON.parse(row.doc) as unknown;
    } catch {
      return undefined;
    }
  });
}

/**
 * Imports `data/chat.db` into the shared session store. Runs once: a marker is written when it completes,
 * so sessions deleted afterwards are not imported again. Each session is imported in its own transaction
 * and already-imported ids are skipped, so after an unexpected failure (thrown, no marker) the next run
 * picks up where this one stopped.
 */
export async function migrateLegacyChatDb(options: ChatMigrationOptions): Promise<ChatMigrationResult> {
  const { legacyDbPath, store, sessionManager, userId } = options;
  const migrations = store.collection<MigrationRecord>('migrations');
  if (migrations.findOne({ id: CHAT_DB_MIGRATION_ID })) {
    return { status: 'already-migrated', sessionsImported: 0, messagesImported: 0, skipped: 0 };
  }
  // No marker here: a `chat.db` copied in later (e.g. from another machine) is still imported.
  if (!fs.existsSync(legacyDbPath)) {
    return { status: 'no-legacy-db', sessionsImported: 0, messagesImported: 0, skipped: 0 };
  }

  const legacy = new DatabaseSync(legacyDbPath, { readOnly: true });
  let rawSessions: unknown[];
  let rawMessages: unknown[];
  try {
    rawSessions = readLegacyDocs(legacy, LEGACY_SESSIONS_TABLE);
    rawMessages = readLegacyDocs(legacy, LEGACY_MESSAGES_TABLE);
  } finally {
    legacy.close();
  }

  let skipped = 0;
  const sessions = new Map<string, LegacySession>();
  for (const raw of rawSessions) {
    const parsed = LegacySessionSchema.safeParse(raw);
    if (!parsed.success) {
      skipped++;
      logger.warn('[ChatMigration] Skipping malformed legacy session', {
        code: 'CHAT_MIGRATION_ROW_INVALID',
        id: (raw as { id?: unknown } | undefined)?.id,
        issues: parsed.error.issues.map((issue) => issue.path.join('.')),
      });
      continue;
    }
    sessions.set(parsed.data.id, parsed.data);
  }

  const messagesBySession = new Map<string, ImportedJarvisMessage[]>();
  for (const raw of rawMessages) {
    const parsed = LegacyMessageSchema.safeParse(raw);
    if (!parsed.success || !sessions.has(parsed.data.sessionId)) {
      skipped++;
      logger.warn('[ChatMigration] Skipping legacy message', {
        code: parsed.success ? 'CHAT_MIGRATION_ORPHAN_MESSAGE' : 'CHAT_MIGRATION_ROW_INVALID',
        id: (raw as { id?: unknown } | undefined)?.id,
      });
      continue;
    }
    const { sessionId, ...message } = parsed.data;
    const list = messagesBySession.get(sessionId) ?? [];
    list.push(message);
    messagesBySession.set(sessionId, list);
  }

  let sessionsImported = 0;
  let messagesImported = 0;
  for (const session of sessions.values()) {
    // Same order the legacy `ChatStore.getMessages` returned (stable sort over the rows' insertion order).
    const messages = (messagesBySession.get(session.id) ?? []).sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
    try {
      const result = await sessionManager.importSession(
        {
          id: session.id,
          userId,
          title: session.title,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          metadata: session.model ? { model: session.model } : undefined,
        },
        messages
      );
      if (result.sessionImported) {
        sessionsImported++;
      }
      messagesImported += result.messagesImported;
    } catch (err: unknown) {
      if (!(err instanceof SessionConflictError)) {
        throw err;
      }
      skipped += 1 + messages.length;
      logger.warn('[ChatMigration] Skipping legacy session whose id belongs to another user', {
        code: 'CHAT_MIGRATION_SESSION_CONFLICT',
        sessionId: session.id,
      });
    }
  }

  migrations.insertOne({
    id: CHAT_DB_MIGRATION_ID,
    completedAt: new Date().toISOString(),
    sessionsImported,
    messagesImported,
    skipped,
  });
  logger.info(`[ChatMigration] Imported ${sessionsImported} sessions and ${messagesImported} messages from ${legacyDbPath}`, {
    skipped,
  });
  return { status: 'migrated', sessionsImported, messagesImported, skipped };
}
