/**
 * Unit Tests: Local Web Server & API Endpoints
 * Authority: FEAT-004 Specification
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { JarvisWebServer } from '../src/web/server.js';
import { ChatStore } from '../src/storage/chat-store.js';
import { DocumentStore } from '../src/storage/collection.js';
import { MemoryManager } from '../src/memory/manager.js';
import type { GenerateOptions, GenerateStreamOptions, LLMProvider } from '../src/services/provider.js';

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

  test('GET /api/models returns available models and active model', async () => {
    const res = await fetch(`${baseUrl}/api/models`);
    assert.equal(res.status, 200);
    const json = (await res.json()) as any;
    assert.ok(Array.isArray(json.models));
    assert.ok(json.models.length > 0);
    assert.ok(json.active);
  });
});

/**
 * Records every prompt it receives and streams a fixed reply in several chunks.
 * `generate()` is what the summarizer calls, so its prompts are kept separately.
 */
class RecordingProvider implements LLMProvider {
  public chatPrompts: string[] = [];
  public summaryPrompts: string[] = [];
  public lastSignal: AbortSignal | undefined;

  constructor(
    private chunks: string[] = ['Noted', ', thanks.'],
    private chunkDelayMs = 0,
    private summary = 'SESSION-SUMMARY: the owner shared a preference.'
  ) {}

  async generate(prompt: string, _options?: GenerateOptions): Promise<string> {
    this.summaryPrompts.push(prompt);
    return this.summary;
  }

  async *generateStream(prompt: string, options: GenerateStreamOptions = {}): AsyncGenerator<string, void, undefined> {
    this.chatPrompts.push(prompt);
    this.lastSignal = options.signal;
    for (const chunk of this.chunks) {
      if (this.chunkDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, this.chunkDelayMs));
      }
      if (options.signal?.aborted) throw new Error('aborted');
      yield chunk;
    }
  }

  async chat(): Promise<string> {
    return this.chunks.join('');
  }

  getModel(): string {
    return 'test-model:1b';
  }

  getBaseUrl(): string {
    return 'http://fake-llm.local';
  }
}

describe('JarvisWebServer chat streaming and memory', () => {
  const port = 3098;
  const baseUrl = `http://127.0.0.1:${port}`;
  let server: JarvisWebServer;
  let chatStore: ChatStore;
  let memory: MemoryManager;
  let provider: RecordingProvider;

  before(async () => {
    chatStore = new ChatStore(':memory:');
    memory = new MemoryManager(new DocumentStore(':memory:'));
    provider = new RecordingProvider();
    server = new JarvisWebServer({
      port,
      chatStore,
      memoryManager: memory,
      userId: 'owner',
      providerFactory: () => provider,
    });
    await server.start();
  });

  after(async () => {
    await server.stop();
  });

  async function createSession(): Promise<string> {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Memory test', model: 'test-model:1b' }),
    });
    const session = (await res.json()) as { id: string };
    return session.id;
  }

  // Prompts deliberately avoid the research trigger words, so no SearXNG call is attempted.
  async function sendChat(sessionId: string, prompt: string): Promise<{ res: Response; frames: string[] }> {
    const res = await fetch(`${baseUrl}/api/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, prompt, model: 'test-model:1b', useResearch: false }),
    });
    const body = await res.text();
    const frames = body
      .split('\n\n')
      .filter((f) => f.startsWith('data: '))
      .map((f) => f.slice(6));
    return { res, frames };
  }

  test('streams one SSE frame per provider chunk, with streaming headers, and saves the reply', async () => {
    const sessionId = await createSession();
    const before = provider.chatPrompts.length;
    const { res, frames } = await sendChat(sessionId, 'Hello there Jarvis');
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    assert.equal(res.headers.get('cache-control'), 'no-cache, no-transform');
    assert.equal(res.headers.get('x-accel-buffering'), 'no');
    assert.deepEqual(frames, [JSON.stringify({ chunk: 'Noted' }), JSON.stringify({ chunk: ', thanks.' }), '[DONE]']);
    assert.equal(provider.chatPrompts.length, before + 1);

    const messages = chatStore.getMessages(sessionId);
    assert.equal(messages[1].role, 'assistant');
    assert.equal(messages[1].content, 'Noted, thanks.');
    assert.equal(messages[1].meta?.partial, undefined);
  });

  test('rejects a request without a prompt', async () => {
    const res = await fetch(`${baseUrl}/api/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'x' }),
    });
    assert.equal(res.status, 400);
  });

  test('the third turn\'s prompt contains text from the first message', async () => {
    const sessionId = await createSession();
    await sendChat(sessionId, 'My favourite colour is green');
    await sendChat(sessionId, 'Second message about lunch plans');
    const before = provider.chatPrompts.length;
    await sendChat(sessionId, 'Third message, recall my colour');
    const thirdPrompt = provider.chatPrompts[before];
    assert.ok(thirdPrompt.includes('My favourite colour is green'), thirdPrompt);
    assert.ok(thirdPrompt.includes('Second message about lunch plans'));
    // The current request appears once, as the request, not duplicated into the history.
    assert.equal(thirdPrompt.split('Third message, recall my colour').length - 1, 1);
  });

  test('a second session\'s context does not contain the first session\'s messages, only its summary', async () => {
    const firstSession = await createSession();
    await sendChat(firstSession, 'ISOLATION-MARKER-ALPHA is my secret plan');
    await sendChat(firstSession, 'Another line for the first chat');
    await sendChat(firstSession, 'Third line for the first chat'); // 6 messages -> summary
    assert.ok(provider.summaryPrompts.some((p) => p.includes('ISOLATION-MARKER-ALPHA')), 'summary should be generated at 6 messages');

    const secondSession = await createSession();
    const before = provider.chatPrompts.length;
    await sendChat(secondSession, 'Brand new chat here');
    const prompt = provider.chatPrompts[before];
    assert.ok(!prompt.includes('ISOLATION-MARKER-ALPHA'), prompt);
    assert.ok(!prompt.includes('Another line for the first chat'));
    assert.ok(prompt.includes('SESSION-SUMMARY'), 'other sessions\' summaries are shared (T2)');
  });

  test('"remember that ..." stores a profile fact that later chats see', async () => {
    const sessionId = await createSession();
    await sendChat(sessionId, 'Remember that my favourite drink is masala chai');
    const facts = await memory.getProfileFacts('owner');
    assert.ok(facts.some((f) => f.value === 'my favourite drink is masala chai'));

    const other = await createSession();
    const before = provider.chatPrompts.length;
    await sendChat(other, 'Suggest a drink for me');
    assert.ok(provider.chatPrompts[before].includes('masala chai'));
  });

  test('records an episode for each completed turn', async () => {
    const sessionId = await createSession();
    await sendChat(sessionId, 'Plan my weekend');
    const episodes = await memory.queryEpisodes({ userId: 'owner', sessionId });
    assert.equal(episodes.length, 1);
    assert.equal(episodes[0].goal, 'Plan my weekend');
    assert.equal(episodes[0].outcome, 'Noted, thanks.');
  });

  test('a client disconnect aborts the provider and saves the partial reply', async () => {
    const slow = new RecordingProvider(['first ', 'second ', 'third'], 150);
    const slowServer = new JarvisWebServer({
      port: port + 1,
      chatStore: new ChatStore(':memory:'),
      memoryManager: memory,
      userId: 'owner',
      providerFactory: () => slow,
    });
    await slowServer.start();
    try {
      const sessionRes = await fetch(`http://127.0.0.1:${port + 1}/api/sessions`, { method: 'POST', body: '{}' });
      const { id: sessionId } = (await sessionRes.json()) as { id: string };
      const controller = new AbortController();
      const res = await fetch(`http://127.0.0.1:${port + 1}/api/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ sessionId, prompt: 'Slow reply please', model: 'test-model:1b' }),
      });
      const reader = res.body?.getReader();
      assert.ok(reader);
      await reader.read();
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 400));

      assert.equal(slow.lastSignal?.aborted, true);
      const store = (slowServer as unknown as { chatStore: ChatStore }).chatStore;
      const saved = store.getMessages(sessionId).find((m) => m.role === 'assistant');
      assert.ok(saved, 'partial reply should be saved');
      assert.equal(saved.meta?.partial, true);
      assert.ok(saved.content.startsWith('first'));
      assert.ok(!saved.content.includes('third'));
    } finally {
      await slowServer.stop();
    }
  });
});
