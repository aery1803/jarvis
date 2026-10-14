/**
 * Unit Tests: Local Web Server & API Endpoints
 * Authority: FEAT-004 Specification
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { JarvisWebServer, shouldResearchPrompt } from '../src/web/server.js';
import { ChatStore } from '../src/storage/chat-store.js';
import { DocumentStore } from '../src/storage/collection.js';
import { MemoryManager } from '../src/memory/manager.js';
import { SessionManager } from '../src/sessions/manager.js';
import type { GenerateOptions, GenerateStreamOptions, LLMProvider } from '../src/services/provider.js';

const JSON_HEADERS = { 'Content-Type': 'application/json', 'X-Jarvis-Client': 'web' };

const FAKE_OLLAMA = {
  baseUrl: 'http://fake-ollama.local',
  reachable: true,
  loaded: [],
  installed: [
    { name: 'qwen3:8b', sizeBytes: 5225388164, parameterSize: '8.2B', quantization: 'Q4_K_M', family: 'qwen3' },
    { name: 'qwen3:32b', sizeBytes: 20201253829, parameterSize: '32.8B', quantization: 'Q4_K_M', family: 'qwen3' },
  ],
};

describe('JarvisWebServer', () => {
  let server: JarvisWebServer;
  let baseUrl: string;
  let chatStore: ChatStore;

  before(async () => {
    chatStore = new ChatStore(':memory:');
    server = new JarvisWebServer({
      port: 3099,
      chatStore,
      probes: {
        ollama: async () => FAKE_OLLAMA,
        gpu: async () => ({ probe: 'llama.cpp', devices: [{ index: 0, backend: 'Vulkan', name: 'Radeon 8060S', totalBytes: 48 * 2 ** 30, freeBytes: 45 * 2 ** 30 }] }),
      },
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
      headers: JSON_HEADERS,
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

  test('GET /api/models reports installed models with sizes and the real default as active', async () => {
    const res = await fetch(`${baseUrl}/api/models`);
    assert.equal(res.status, 200);
    const json = (await res.json()) as any;
    assert.deepEqual(json.models, ['qwen3:8b', 'qwen3:32b']);
    assert.equal(json.active, 'qwen3:8b');
    assert.equal(json.activeInstalled, true);
    assert.equal(json.modelDetails[1].sizeBytes, 20201253829);
  });

  test('GET /api/health adds both memory pools once the cached GPU probe has landed', async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const json = (await (await fetch(`${baseUrl}/api/health`)).json()) as any;
    assert.equal(json.vramTotalBytes, 48 * 2 ** 30);
    assert.equal(json.vramFreeBytes, 45 * 2 ** 30);
    assert.equal(json.killSwitch, undefined);
  });

  test('requests whose URL starts with // do not crash the process and are refused or 404', async () => {
    for (const target of ['//', '//etc/passwd', '///x', '/%2e%2e/%2e%2e/package.json', '/..%2f..%2fpackage.json', '/%00', '/%zz']) {
      const res = await rawGet(3099, target);
      assert.ok([400, 404].includes(res.status), `${target} -> ${res.status}`);
    }
    assert.equal((await fetch(`${baseUrl}/api/health`)).status, 200);
  });

  test('a directory is not served and unknown extensions get a safe content type', async () => {
    assert.equal((await rawGet(3099, '/')).status, 200);
    const js = await fetch(`${baseUrl}/app.js`);
    assert.equal(js.headers.get('cache-control'), 'no-store');
    assert.match(js.headers.get('content-type') ?? '', /javascript/);
    assert.equal(js.headers.get('access-control-allow-origin'), null);
    assert.equal(js.headers.get('x-content-type-options'), 'nosniff');
  });

  test('never sends CORS headers and refuses preflights', async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, { method: 'OPTIONS', headers: { Origin: 'http://evil.example' } });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });

  test('state-changing requests need X-Jarvis-Client and a same-origin Origin', async () => {
    const noHeader = await fetch(`${baseUrl}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(noHeader.status, 403);
    const evil = await fetch(`${baseUrl}/api/sessions`, { method: 'POST', headers: { ...JSON_HEADERS, Origin: 'http://evil.example' }, body: '{}' });
    assert.equal(evil.status, 403);
    const same = await fetch(`${baseUrl}/api/sessions`, { method: 'POST', headers: { ...JSON_HEADERS, Origin: baseUrl }, body: '{}' });
    assert.equal(same.status, 201);
    const del = await fetch(`${baseUrl}/api/sessions/abc`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
    assert.equal(del.status, 403);
  });

  test('a foreign Host header (DNS rebinding) is refused', async () => {
    const res = await rawGet(3099, '/api/sessions', { Host: 'evil.example:3099' });
    assert.equal(res.status, 403);
  });

  test('request bodies: invalid JSON is 400, wrong content type 415, oversize 413, multi-byte text survives', async () => {
    const bad = await fetch(`${baseUrl}/api/sessions`, { method: 'POST', headers: JSON_HEADERS, body: '{not json' });
    assert.equal(bad.status, 400);
    const wrongType = await fetch(`${baseUrl}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'text/plain', 'X-Jarvis-Client': 'web' }, body: '{}' });
    assert.equal(wrongType.status, 415);
    const huge = await fetch(`${baseUrl}/api/sessions`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ title: 'x'.repeat(1024 * 1024 + 10) }) });
    assert.equal(huge.status, 413);
    const title = '日本語🙂'.repeat(5000);
    const ok = await fetch(`${baseUrl}/api/sessions`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ title }) });
    assert.equal(ok.status, 201);
    assert.equal(((await ok.json()) as any).title, title);
  });

  test('a new session without a model gets the configured default, not an uninstalled one', async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, { method: 'POST', headers: JSON_HEADERS, body: '{}' });
    assert.equal(((await res.json()) as any).model, 'qwen3:8b');
  });

  test('GET /api/benchmark is refused; benchmarks are POST only', async () => {
    const res = await fetch(`${baseUrl}/api/benchmark`);
    assert.equal(res.status, 405);
  });
});

describe('JarvisWebServer startup failures', () => {
  test('start() rejects with a clear message when the port is taken', async () => {
    const first = new JarvisWebServer({ port: 0, chatStore: new ChatStore(':memory:') });
    await first.start();
    const second = new JarvisWebServer({ port: first.getPort(), chatStore: new ChatStore(':memory:') });
    try {
      await assert.rejects(second.start(), /already in use/);
    } finally {
      await second.stop();
      await first.stop();
    }
  });
});

describe('JarvisWebServer models and benchmark failure modes', () => {
  test('/api/models is 503 with an empty list when Ollama is unreachable', async () => {
    const server = new JarvisWebServer({
      port: 0,
      chatStore: new ChatStore(':memory:'),
      probes: { ollama: async () => ({ baseUrl: 'x', reachable: false, installed: [], loaded: [], error: 'connect ECONNREFUSED' }) },
    });
    await server.start();
    try {
      const res = await fetch(`http://127.0.0.1:${server.getPort()}/api/models`);
      assert.equal(res.status, 503);
      const json = (await res.json()) as any;
      assert.deepEqual(json.models, []);
      assert.match(json.error, /ECONNREFUSED/);
    } finally {
      await server.stop();
    }
  });

  test('a benchmark against a failing model is a 502 error, not a scorecard of zeros', async () => {
    const failing: LLMProvider = {
      generate: async () => {
        throw new Error('model not found');
      },
      chat: async () => '',
      getModel: () => 'qwen3:8b',
      getBaseUrl: () => 'http://fake',
    };
    const server = new JarvisWebServer({ port: 0, chatStore: new ChatStore(':memory:'), providerFactory: () => failing });
    await server.start();
    try {
      const res = await fetch(`http://127.0.0.1:${server.getPort()}/api/benchmark`, { method: 'POST', headers: JSON_HEADERS, body: '{}' });
      assert.equal(res.status, 502);
      assert.match(((await res.json()) as any).error, /model not found/);
    } finally {
      await server.stop();
    }
  });

  test('a second benchmark while one runs is 409', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow: LLMProvider = {
      generate: async () => {
        await gate;
        return 'Yes 1:30 PM';
      },
      chat: async () => '',
      getModel: () => 'qwen3:8b',
      getBaseUrl: () => 'http://fake',
    };
    const server = new JarvisWebServer({ port: 0, chatStore: new ChatStore(':memory:'), providerFactory: () => slow });
    await server.start();
    try {
      const url = `http://127.0.0.1:${server.getPort()}/api/benchmark`;
      const first = fetch(url, { method: 'POST', headers: JSON_HEADERS, body: '{}' });
      await new Promise((resolve) => setTimeout(resolve, 30));
      const second = await fetch(url, { method: 'POST', headers: JSON_HEADERS, body: '{}' });
      assert.equal(second.status, 409);
      release();
      assert.equal((await first).status, 200);
    } finally {
      release();
      await server.stop();
    }
  });

  test('the kill switch refuses chat with 503 and shows up in /api/health', async () => {
    const server = new JarvisWebServer({
      port: 0,
      chatStore: new ChatStore(':memory:'),
      killSwitch: { isKilled: () => true, getKillReason: () => 'owner pressed stop' },
    });
    await server.start();
    try {
      const base = `http://127.0.0.1:${server.getPort()}`;
      const health = (await (await fetch(`${base}/api/health`)).json()) as any;
      assert.deepEqual(health.killSwitch, { engaged: true, reason: 'owner pressed stop' });
      const chat = await fetch(`${base}/api/chat/stream`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ sessionId: 'x', prompt: 'hi' }) });
      assert.equal(chat.status, 503);
    } finally {
      await server.stop();
    }
  });
});

describe('research gating', () => {
  test('an explicit toggle wins; the heuristic only applies when it is absent', () => {
    assert.equal(shouldResearchPrompt('what is the latest news?', false), false);
    assert.equal(shouldResearchPrompt('hello', true), true);
    assert.equal(shouldResearchPrompt('search for ryzen ai max specs', undefined), true);
    assert.equal(shouldResearchPrompt('what is a closure?', undefined), false);
    assert.equal(shouldResearchPrompt('The newsletter is ready', undefined), false);
  });
});

function rawGet(port: number, target: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: target, method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

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
      headers: JSON_HEADERS,
      body: JSON.stringify({ title: 'Memory test', model: 'test-model:1b' }),
    });
    const session = (await res.json()) as { id: string };
    return session.id;
  }

  // Prompts deliberately avoid the research trigger words, so no SearXNG call is attempted.
  async function sendChat(sessionId: string, prompt: string): Promise<{ res: Response; frames: string[] }> {
    const res = await fetch(`${baseUrl}/api/chat/stream`, {
      method: 'POST',
      headers: JSON_HEADERS,
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

    const messages = await chatStore.getMessages(sessionId);
    assert.equal(messages[1].role, 'assistant');
    assert.equal(messages[1].content, 'Noted, thanks.');
    assert.equal(messages[1].meta?.partial, undefined);
  });

  test('a model that fails with no output yields an SSE error frame and no fabricated assistant message', async () => {
    const broken: LLMProvider = {
      generate: async () => '',
      generateStream: () => {
        throw new Error('model "qwen3:8b" not found');
      },
      chat: async () => '',
      getModel: () => 'qwen3:8b',
      getBaseUrl: () => 'http://fake',
    };
    const searches: string[] = [];
    const failServer = new JarvisWebServer({
      port: port + 5,
      chatStore: new ChatStore(':memory:'),
      providerFactory: () => broken,
      searchClientFactory: () => ({
        search: async (query: string) => {
          searches.push(query);
          return [];
        },
      }),
    });
    await failServer.start();
    try {
      const base = `http://127.0.0.1:${port + 5}`;
      const { id } = (await (await fetch(`${base}/api/sessions`, { method: 'POST', headers: JSON_HEADERS, body: '{}' })).json()) as { id: string };
      const res = await fetch(`${base}/api/chat/stream`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ sessionId: id, prompt: 'what is the latest news?', model: 'qwen3:8b', useResearch: false }),
      });
      const frames = (await res.text())
        .split('\n\n')
        .filter((f) => f.startsWith('data: '))
        .map((f) => f.slice(6));
      assert.equal(frames.length, 2);
      assert.match(JSON.parse(frames[0]).error, /not found/);
      assert.equal(frames[1], '[DONE]');
      assert.ok(!frames.some((f) => f.includes('Jarvis local response')));
      const store = (failServer as unknown as { chatStore: ChatStore }).chatStore;
      assert.deepEqual((await store.getMessages(id)).map((m) => m.role), ['user']);
      assert.deepEqual(searches, [], 'useResearch:false must not touch the internet');
    } finally {
      await failServer.stop();
    }
  });

  test('rejects a request without a prompt', async () => {
    const res = await fetch(`${baseUrl}/api/chat/stream`, {
      method: 'POST',
      headers: JSON_HEADERS,
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
    // Past-task episodes (goal -> outcome) are a separate, shared tier, so the first chat's goals may appear there.
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
      const sessionRes = await fetch(`http://127.0.0.1:${port + 1}/api/sessions`, { method: 'POST', headers: JSON_HEADERS, body: '{}' });
      const { id: sessionId } = (await sessionRes.json()) as { id: string };
      const controller = new AbortController();
      const res = await fetch(`http://127.0.0.1:${port + 1}/api/chat/stream`, {
        method: 'POST',
        headers: JSON_HEADERS,
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
      const saved = (await store.getMessages(sessionId)).find((m) => m.role === 'assistant');
      assert.ok(saved, 'partial reply should be saved');
      assert.equal(saved.meta?.partial, true);
      assert.ok(saved.content.startsWith('first'));
      assert.ok(!saved.content.includes('third'));
    } finally {
      await slowServer.stop();
    }
  });
});

describe('JarvisWebServer over the shared SessionManager', () => {
  const port = 3096;
  const baseUrl = `http://127.0.0.1:${port}`;
  const ownerId = '123456789';
  let documents: DocumentStore;
  let sessions: SessionManager;
  let server: JarvisWebServer;
  let provider: RecordingProvider;

  before(async () => {
    documents = new DocumentStore(':memory:');
    sessions = new SessionManager(documents);
    provider = new RecordingProvider();
    server = new JarvisWebServer({
      port,
      sessionManager: sessions,
      memoryManager: new MemoryManager(documents),
      userId: ownerId,
      providerFactory: () => provider,
    });
    await server.start();
  });

  after(async () => {
    await server.stop();
    // `stop()` must not close a store the Telegram bot still uses.
    assert.ok(await sessions.createSession(ownerId, 'still open'));
    documents.close();
  });

  test('a session created on the web is a SessionManager session of the owner, with its turns', async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ title: 'Web chat', model: 'test-model:1b' }),
    });
    assert.equal(res.status, 201);
    const { id: sessionId } = (await res.json()) as { id: string };

    await fetch(`${baseUrl}/api/chat/stream`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ sessionId, prompt: 'Hello from the browser', model: 'test-model:1b', useResearch: false }),
    }).then((r) => r.text());

    const session = await sessions.getSession(ownerId, sessionId);
    assert.equal(session?.title, 'Web chat');
    const messages = await sessions.getMessages(ownerId, sessionId);
    assert.deepEqual(
      messages.map((m) => [m.role, m.content]),
      [
        ['user', 'Hello from the browser'],
        ['assistant', 'Noted, thanks.'],
      ]
    );
  });

  test('a Telegram session and its turns are served by the existing session routes', async () => {
    const telegramSession = await sessions.createSession(ownerId, 'Default Session');
    await sessions.addMessage(ownerId, telegramSession.id, { role: 'user', content: 'TG-WEB-MARKER asked on Telegram' });
    await sessions.addMessage(ownerId, telegramSession.id, { role: 'assistant', content: 'Answered on Telegram' });

    const listed = (await (await fetch(`${baseUrl}/api/sessions`)).json()) as Array<{ id: string; title: string; model: string }>;
    const entry = listed.find((s) => s.id === telegramSession.id);
    assert.ok(entry, 'the Telegram session is listed on the web');
    assert.equal(entry.title, 'Default Session');
    assert.equal(typeof entry.model, 'string');

    const messages = (await (await fetch(`${baseUrl}/api/sessions/${telegramSession.id}/messages`)).json()) as Array<{
      sessionId: string;
      role: string;
      content: string;
    }>;
    assert.deepEqual(
      messages.map((m) => [m.sessionId, m.role, m.content]),
      [
        [telegramSession.id, 'user', 'TG-WEB-MARKER asked on Telegram'],
        [telegramSession.id, 'assistant', 'Answered on Telegram'],
      ]
    );

    // Continuing that conversation on the web carries the Telegram turns into the prompt.
    const before = provider.chatPrompts.length;
    await fetch(`${baseUrl}/api/chat/stream`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ sessionId: telegramSession.id, prompt: 'Continuing on the web', model: 'test-model:1b', useResearch: false }),
    }).then((r) => r.text());
    assert.ok(provider.chatPrompts[before].includes('TG-WEB-MARKER asked on Telegram'), provider.chatPrompts[before]);
  });

  test('another user\'s session is neither listed nor writable from the web', async () => {
    const stranger = await sessions.createSession('someone-else', 'Not the owner');

    const listed = (await (await fetch(`${baseUrl}/api/sessions`)).json()) as Array<{ id: string }>;
    assert.ok(!listed.some((s) => s.id === stranger.id));

    const res = await fetch(`${baseUrl}/api/chat/stream`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ sessionId: stranger.id, prompt: 'Sneaky write', model: 'test-model:1b', useResearch: false }),
    });
    assert.equal(res.status, 404);
    assert.deepEqual(await sessions.getMessages('someone-else', stranger.id), []);
  });

  test('streaming to an unknown session returns 404 before any SSE frame', async () => {
    const before = provider.chatPrompts.length;
    const res = await fetch(`${baseUrl}/api/chat/stream`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ sessionId: 'sess-does-not-exist', prompt: 'Anyone there', model: 'test-model:1b', useResearch: false }),
    });
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    assert.equal(provider.chatPrompts.length, before);
  });
});
