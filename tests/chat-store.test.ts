/**
 * Unit Tests: Chat Session & Message Store
 * Authority: CODING_RULES.md (TDD), FEAT-004 Specification
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChatStore } from '../src/storage/chat-store.js';
import { DocumentStore } from '../src/storage/collection.js';
import { SessionManager } from '../src/sessions/manager.js';

describe('ChatStore', () => {
  let store: ChatStore;

  beforeEach(() => {
    store = new ChatStore(':memory:');
  });

  test('should create and retrieve chat sessions', async () => {
    const session1 = await store.createSession('Research on Vulkan', 'qwen2.5:7b');
    const session2 = await store.createSession('Coding Dev Agent', 'qwen2.5-coder:7b');

    assert.ok(session1.id);
    assert.equal(session1.title, 'Research on Vulkan');
    assert.equal(session1.model, 'qwen2.5:7b');
    assert.equal(session2.model, 'qwen2.5-coder:7b');

    const all = await store.getSessions();
    assert.equal(all.length, 2);
    assert.equal((await store.getSession(session2.id!))?.model, 'qwen2.5-coder:7b');
  });

  test('should append and retrieve messages for a specific session', async () => {
    const session = await store.createSession('Test Chat');

    const msg1 = await store.addMessage({
      sessionId: session.id!,
      role: 'user',
      content: 'What is the host memory headroom?',
    });

    const msg2 = await store.addMessage({
      sessionId: session.id!,
      role: 'assistant',
      content: 'Jarvis maintains >= 14 GB host memory headroom.',
      meta: { sources: ['jarvis-master-context.md'] },
    });

    assert.ok(msg1.id);
    assert.ok(msg2.id);
    assert.equal(msg2.sessionId, session.id);
    assert.ok(msg2.createdAt);

    const messages = await store.getMessages(session.id!);
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, 'user');
    assert.equal(messages[1].role, 'assistant');
    assert.equal(messages[1].meta?.sources?.[0], 'jarvis-master-context.md');
  });

  test('should update session title', async () => {
    const session = await store.createSession('Untitled Chat');
    const updated = await store.updateSessionTitle(session.id!, 'AMD Strix Halo Overview');

    assert.equal(updated, true);
    const retrieved = await store.getSession(session.id!);
    assert.equal(retrieved?.title, 'AMD Strix Halo Overview');
  });

  test('should delete session and cascade delete its messages', async () => {
    const session = await store.createSession('To Delete');
    await store.addMessage({ sessionId: session.id!, role: 'user', content: 'Hello' });

    assert.equal((await store.getMessages(session.id!)).length, 1);

    const deleted = await store.deleteSession(session.id!);
    assert.equal(deleted, true);
    assert.equal(await store.getSession(session.id!), null);
    assert.equal((await store.getMessages(session.id!)).length, 0);
  });
});

describe('ChatStore over a shared SessionManager', () => {
  const ownerId = '123456789';
  let documents: DocumentStore;
  let sessions: SessionManager;
  let chat: ChatStore;

  beforeEach(() => {
    documents = new DocumentStore(':memory:');
    sessions = new SessionManager(documents);
    chat = new ChatStore(sessions, ownerId);
  });

  test('web sessions and messages are stored in SessionManager under the owner ID', async () => {
    const session = await chat.createSession('From the browser', 'qwen2.5-coder:7b');
    await chat.addMessage({ sessionId: session.id!, role: 'user', content: 'Typed on the web' });

    const listed = await sessions.listSessions(ownerId);
    assert.deepEqual(listed.map((s) => s.id), [session.id]);
    assert.equal(listed[0].metadata?.model, 'qwen2.5-coder:7b');
    const messages = await sessions.getMessages(ownerId, session.id!);
    assert.deepEqual(messages.map((m) => m.content), ['Typed on the web']);
  });

  test('sessions and messages written through SessionManager (Telegram) are visible to the web', async () => {
    const telegramSession = await sessions.createSession(ownerId, 'Default Session');
    await sessions.addMessage(ownerId, telegramSession.id, { role: 'user', content: 'Sent from Telegram' });
    await sessions.addMessage(ownerId, telegramSession.id, { role: 'assistant', content: 'Answered on Telegram' });

    const webSessions = await chat.getSessions();
    assert.equal(webSessions.length, 1);
    assert.equal(webSessions[0].id, telegramSession.id);
    assert.equal(webSessions[0].title, 'Default Session');
    assert.equal(webSessions[0].model, 'qwen2.5:7b', 'sessions without a stored model report the default');

    const messages = await chat.getMessages(telegramSession.id);
    assert.deepEqual(
      messages.map((m) => [m.sessionId, m.role, m.content]),
      [
        [telegramSession.id, 'user', 'Sent from Telegram'],
        [telegramSession.id, 'assistant', 'Answered on Telegram'],
      ]
    );
  });

  test('other users\' sessions stay hidden from the web owner', async () => {
    const stranger = await sessions.createSession('someone-else', 'Not yours');
    await sessions.addMessage('someone-else', stranger.id, { role: 'user', content: 'private' });

    assert.deepEqual(await chat.getSessions(), []);
    assert.equal(await chat.getSession(stranger.id), null);
    assert.deepEqual(await chat.getMessages(stranger.id), []);
    assert.equal(await chat.deleteSession(stranger.id), false);
    await assert.rejects(chat.addMessage({ sessionId: stranger.id, role: 'user', content: 'cross-user write' }));
  });

  test('close() leaves a shared store open for its other users', async () => {
    chat.close();
    const session = await sessions.createSession(ownerId, 'Still writable');
    assert.ok(await sessions.getSession(ownerId, session.id));
  });
});
