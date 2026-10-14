/**
 * Unit Tests: Chat Session & Message Store
 * Authority: CODING_RULES.md (TDD), FEAT-004 Specification
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChatStore } from '../src/storage/chat-store.js';

describe('ChatStore', () => {
  let store: ChatStore;

  beforeEach(() => {
    store = new ChatStore(':memory:');
  });

  test('should create and retrieve chat sessions', () => {
    const session1 = store.createSession('Research on Vulkan', 'qwen2.5:7b');
    const session2 = store.createSession('Coding Dev Agent', 'qwen2.5-coder:7b');

    assert.ok(session1.id);
    assert.equal(session1.title, 'Research on Vulkan');
    assert.equal(session1.model, 'qwen2.5:7b');

    const all = store.getSessions();
    assert.equal(all.length, 2);
  });

  test('should append and retrieve messages for a specific session', () => {
    const session = store.createSession('Test Chat');

    const msg1 = store.addMessage({
      sessionId: session.id,
      role: 'user',
      content: 'What is the host memory headroom?',
    });

    const msg2 = store.addMessage({
      sessionId: session.id,
      role: 'assistant',
      content: 'Jarvis maintains >= 14 GB host memory headroom.',
      meta: { sources: ['jarvis-master-context.md'] },
    });

    assert.ok(msg1.id);
    assert.ok(msg2.id);

    const messages = store.getMessages(session.id);
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, 'user');
    assert.equal(messages[1].role, 'assistant');
    assert.equal(messages[1].meta?.sources?.[0], 'jarvis-master-context.md');
  });

  test('should update session title', () => {
    const session = store.createSession('Untitled Chat');
    const updated = store.updateSessionTitle(session.id, 'AMD Strix Halo Overview');

    assert.equal(updated, true);
    const retrieved = store.getSession(session.id);
    assert.equal(retrieved?.title, 'AMD Strix Halo Overview');
  });

  test('should delete session and cascade delete its messages', () => {
    const session = store.createSession('To Delete');
    store.addMessage({ sessionId: session.id, role: 'user', content: 'Hello' });

    assert.equal(store.getMessages(session.id).length, 1);

    const deleted = store.deleteSession(session.id);
    assert.equal(deleted, true);
    assert.equal(store.getSession(session.id), null);
    assert.equal(store.getMessages(session.id).length, 0);
  });
});
