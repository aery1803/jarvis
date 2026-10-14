/**
 * Unit Tests: Local Web Server & API Endpoints
 * Authority: FEAT-004 Specification
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { JarvisWebServer } from '../src/web/server.js';
import { ChatStore } from '../src/storage/chat-store.js';

describe('JarvisWebServer', () => {
  let server: JarvisWebServer;
  let baseUrl: string;
  let chatStore: ChatStore;

  before(async () => {
    chatStore = new ChatStore(':memory:');
    server = new JarvisWebServer({
      port: 3099,
      chatStore,
    });
    await server.start();
    baseUrl = 'http://127.0.0.1:3099';
  });

  after(async () => {
    await server.stop();
  });

  test('GET /api/health returns system status and memory headroom', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200);

    const json = (await res.json()) as any;
    assert.equal(json.status, 'ok');
    assert.ok(json.freeMemoryBytes > 0);
  });

  test('POST /api/sessions creates a new chat session', async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New Web Chat', model: 'qwen2.5:7b' }),
    });

    assert.equal(res.status, 201);
    const session = (await res.json()) as any;
    assert.ok(session.id);
    assert.equal(session.title, 'New Web Chat');
  });

  test('GET /api/sessions lists created sessions', async () => {
    const res = await fetch(`${baseUrl}/api/sessions`);
    assert.equal(res.status, 200);

    const sessions = (await res.json()) as any[];
    assert.ok(Array.isArray(sessions));
    assert.equal(sessions.length, 1);
  });

  test('GET / serves the Web UI HTML application', async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /<!DOCTYPE html>/i);
    assert.match(text, /Jarvis/i);
  });
});
