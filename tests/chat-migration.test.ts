/**
 * Unit Tests: Legacy `data/chat.db` -> SessionManager Migration
 * Authority: CODING_RULES.md (TDD; schema migrations verified explicitly), Section 11.2
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DocumentStore } from '../src/storage/collection.js';
import { SessionManager } from '../src/sessions/manager.js';
import { ChatStore } from '../src/storage/chat-store.js';
import { migrateLegacyChatDb } from '../src/storage/chat-migration.js';

const OWNER_ID = '123456789';

/** Writes rows the way `ChatStore` stored them before it delegated to `SessionManager`. */
function writeLegacyChatDb(dbPath: string, rows: { sessions: Record<string, unknown>[]; messages: Record<string, unknown>[] }): void {
  const legacy = new DocumentStore(dbPath);
  const sessions = legacy.collection<{ id?: string }>('chat_sessions');
  const messages = legacy.collection<{ id?: string }>('chat_messages');
  for (const row of rows.sessions) sessions.insertOne(row);
  for (const row of rows.messages) messages.insertOne(row);
  legacy.close();
}

function sha256(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

const legacySessions = [
  {
    id: 'session-aaa',
    title: 'Vulkan research',
    model: 'qwen2.5:7b',
    createdAt: '2026-09-01T08:00:00.000Z',
    updatedAt: '2026-09-01T08:10:00.000Z',
  },
  {
    id: 'session-bbb',
    title: 'Coding help',
    model: 'qwen2.5-coder:7b',
    createdAt: '2026-09-02T09:00:00.000Z',
    updatedAt: '2026-09-02T09:30:00.000Z',
  },
];

const legacyMessages = [
  { id: 'msg-1', sessionId: 'session-aaa', role: 'user', content: 'Is Vulkan working?', createdAt: '2026-09-01T08:00:00.000Z' },
  {
    id: 'msg-2',
    sessionId: 'session-aaa',
    role: 'assistant',
    content: 'Yes, on the 8060S.',
    createdAt: '2026-09-01T08:00:00.000Z',
    meta: { sources: ['https://example.test/vulkan'] },
  },
  { id: 'msg-3', sessionId: 'session-aaa', role: 'user', content: 'Great, thanks', createdAt: '2026-09-01T08:09:00.000Z' },
  {
    id: 'msg-4',
    sessionId: 'session-bbb',
    role: 'assistant',
    content: 'Here is a partial answer',
    createdAt: '2026-09-02T09:01:00.000Z',
    meta: { partial: true },
  },
];

describe('migrateLegacyChatDb', () => {
  let tmpDir: string;
  let legacyDbPath: string;
  let store: DocumentStore;
  let sessions: SessionManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-chat-migration-'));
    legacyDbPath = path.join(tmpDir, 'chat.db');
    store = new DocumentStore(path.join(tmpDir, 'jarvis.db'));
    sessions = new SessionManager(store);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('imports legacy sessions and messages under the owner ID, keeping ids, order, and metadata', async () => {
    writeLegacyChatDb(legacyDbPath, { sessions: legacySessions, messages: legacyMessages });

    const result = await migrateLegacyChatDb({ legacyDbPath, store, sessionManager: sessions, userId: OWNER_ID });
    assert.deepEqual(result, { status: 'migrated', sessionsImported: 2, messagesImported: 4, skipped: 0 });

    const owned = await sessions.listSessions(OWNER_ID);
    assert.deepEqual(owned.map((s) => s.id), ['session-bbb', 'session-aaa']);
    const aaa = owned.find((s) => s.id === 'session-aaa');
    assert.equal(aaa?.title, 'Vulkan research');
    assert.equal(aaa?.createdAt, '2026-09-01T08:00:00.000Z');
    assert.equal(aaa?.updatedAt, '2026-09-01T08:10:00.000Z');

    const messages = await sessions.getMessages(OWNER_ID, 'session-aaa');
    assert.deepEqual(
      messages.map((m) => [m.id, m.seq, m.role, m.content]),
      [
        ['msg-1', 1, 'user', 'Is Vulkan working?'],
        ['msg-2', 2, 'assistant', 'Yes, on the 8060S.'],
        ['msg-3', 3, 'user', 'Great, thanks'],
      ]
    );
    assert.deepEqual(messages[1].meta, { sources: ['https://example.test/vulkan'] });

    // The web keeps working against the migrated data, model included.
    const web = new ChatStore(sessions, OWNER_ID);
    const coding = await web.getSession('session-bbb');
    assert.equal(coding?.model, 'qwen2.5-coder:7b');
    const codingMessages = await web.getMessages('session-bbb');
    assert.equal(codingMessages[0].meta?.partial, true);
  });

  test('runs once: a second run neither duplicates rows nor restores sessions deleted since', async () => {
    writeLegacyChatDb(legacyDbPath, { sessions: legacySessions, messages: legacyMessages });
    await migrateLegacyChatDb({ legacyDbPath, store, sessionManager: sessions, userId: OWNER_ID });
    await sessions.deleteSession(OWNER_ID, 'session-bbb');

    const second = await migrateLegacyChatDb({ legacyDbPath, store, sessionManager: sessions, userId: OWNER_ID });
    assert.deepEqual(second, { status: 'already-migrated', sessionsImported: 0, messagesImported: 0, skipped: 0 });

    assert.deepEqual((await sessions.listSessions(OWNER_ID)).map((s) => s.id), ['session-aaa']);
    assert.equal((await sessions.getMessages(OWNER_ID, 'session-aaa')).length, 3);
  });

  test('completes an interrupted earlier run without duplicating what it already imported', async () => {
    writeLegacyChatDb(legacyDbPath, { sessions: legacySessions, messages: legacyMessages });
    await sessions.importSession(
      { ...legacySessions[0], userId: OWNER_ID, metadata: { model: 'qwen2.5:7b' } },
      [{ id: 'msg-1', role: 'user', content: 'Is Vulkan working?', createdAt: '2026-09-01T08:00:00.000Z' }]
    );

    const result = await migrateLegacyChatDb({ legacyDbPath, store, sessionManager: sessions, userId: OWNER_ID });
    assert.deepEqual(result, { status: 'migrated', sessionsImported: 1, messagesImported: 3, skipped: 0 });
    assert.deepEqual(
      (await sessions.getMessages(OWNER_ID, 'session-aaa')).map((m) => [m.id, m.seq]),
      [
        ['msg-1', 1],
        ['msg-2', 2],
        ['msg-3', 3],
      ]
    );
  });

  test('skips malformed rows and messages without a session, and imports the rest', async () => {
    writeLegacyChatDb(legacyDbPath, {
      sessions: [...legacySessions, { id: 'session-broken', title: 42 }],
      messages: [
        ...legacyMessages,
        { id: 'msg-orphan', sessionId: 'session-gone', role: 'user', content: 'No session', createdAt: '2026-09-03T00:00:00.000Z' },
        { id: 'msg-bad-role', sessionId: 'session-aaa', role: 'tool', content: 'x', createdAt: '2026-09-01T08:05:00.000Z' },
        { id: 'msg-of-broken', sessionId: 'session-broken', role: 'user', content: 'Lost with its session', createdAt: '2026-09-03T00:00:00.000Z' },
      ],
    });

    const result = await migrateLegacyChatDb({ legacyDbPath, store, sessionManager: sessions, userId: OWNER_ID });
    assert.deepEqual(result, { status: 'migrated', sessionsImported: 2, messagesImported: 4, skipped: 4 });
    assert.equal(await sessions.getSession(OWNER_ID, 'session-broken'), null);
    assert.equal((await sessions.getMessages(OWNER_ID, 'session-aaa')).length, 3);
  });

  test('reports a missing legacy database without marking the migration done', async () => {
    const missing = await migrateLegacyChatDb({ legacyDbPath, store, sessionManager: sessions, userId: OWNER_ID });
    assert.deepEqual(missing, { status: 'no-legacy-db', sessionsImported: 0, messagesImported: 0, skipped: 0 });
    assert.equal(fs.existsSync(legacyDbPath), false, 'the legacy file must not be created');

    writeLegacyChatDb(legacyDbPath, { sessions: legacySessions.slice(0, 1), messages: legacyMessages.slice(0, 3) });
    const later = await migrateLegacyChatDb({ legacyDbPath, store, sessionManager: sessions, userId: OWNER_ID });
    assert.equal(later.status, 'migrated');
    assert.equal(later.sessionsImported, 1);
  });

  test('leaves the legacy database file untouched', async () => {
    writeLegacyChatDb(legacyDbPath, { sessions: legacySessions, messages: legacyMessages });
    const before = sha256(legacyDbPath);

    await migrateLegacyChatDb({ legacyDbPath, store, sessionManager: sessions, userId: OWNER_ID });

    assert.equal(sha256(legacyDbPath), before);
  });
});
