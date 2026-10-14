import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DocumentStore } from '../src/storage/collection.js';
import { SessionManager } from '../src/sessions/manager.js';
import { MemoryManager } from '../src/memory/manager.js';
import { KillSwitch } from '../src/security/kill-switch.js';
import { TelegramBotClient } from '../src/telegram/bot.js';
import type { TelegramUpdate } from '../src/telegram/types.js';
import { MockLLMProvider } from '../src/services/provider.js';
import { ChatStore } from '../src/storage/chat-store.js';

describe('TelegramBotClient', () => {
  const testDbPath = path.resolve(process.cwd(), 'data', 'test-telegram.db');
  let store: DocumentStore;
  let sessions: SessionManager;
  let memory: MemoryManager;
  let killSwitch: KillSwitch;
  let llmProvider: MockLLMProvider;
  let bot: TelegramBotClient;
  let sentMessages: Array<{ method: string; body: any }> = [];

  beforeEach(() => {
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
    store = new DocumentStore(testDbPath);
    sessions = new SessionManager(store);
    memory = new MemoryManager(store);
    killSwitch = new KillSwitch(store, sessions);
    llmProvider = new MockLLMProvider({ cannedResponse: 'Jarvis test answer' });
    sentMessages = [];

    bot = new TelegramBotClient({
      token: 'mock-test-token',
      ownerId: '123456789',
      sessionManager: sessions,
      memoryManager: memory,
      killSwitch: killSwitch,
      llmProvider,
    });

    // Mock API calls to prevent external network requests during unit tests
    bot.apiCall = async <T>(method: string, body?: Record<string, unknown>): Promise<T> => {
      sentMessages.push({ method, body });
      if (method === 'sendMessage' || method === 'editMessageText') {
        return {
          message_id: 100 + sentMessages.length,
          chat: { id: (body?.chat_id as number) ?? 123456789, type: 'private' },
          date: Math.floor(Date.now() / 1000),
          text: (body?.text as string) ?? '',
        } as T;
      }
      if (method === 'answerCallbackQuery' || method === 'sendChatAction') {
        return true as T;
      }
      return {} as T;
    };
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  test('should split long messages cleanly into chunks <= 4000 chars', () => {
    const longText = 'A'.repeat(5000);
    const chunks = bot.splitMessage(longText, 4000);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].length, 4000);
    assert.equal(chunks[1].length, 1000);
  });

  test('should reject unauthorized non-owner messages and log auth failure', async () => {
    const intruderUpdate: TelegramUpdate = {
      update_id: 1,
      message: {
        message_id: 50,
        from: { id: 999999999, is_bot: false, first_name: 'Intruder' },
        chat: { id: 999999999, type: 'private' },
        date: 12345,
        text: 'Hello Jarvis',
      },
    };

    await bot.handleUpdate(intruderUpdate);

    // Verify rejection message was sent
    const denyMsg = sentMessages.find((m) => m.method === 'sendMessage');
    assert.ok(denyMsg);
    assert.ok(denyMsg.body.text.includes('Access Denied'));

    // Verify audit log recorded auth failure
    const auditLogs = await killSwitch.getRecentAuditLogs();
    assert.equal(auditLogs[0].eventType, 'AUTH_FAILURE');
  });

  test('should handle /status command from authorized owner', async () => {
    const ownerUpdate: TelegramUpdate = {
      update_id: 2,
      message: {
        message_id: 51,
        from: { id: 123456789, is_bot: false, first_name: 'Owner' },
        chat: { id: 123456789, type: 'private' },
        date: 12345,
        text: '/status',
      },
    };

    await bot.handleUpdate(ownerUpdate);

    const statusMsg = sentMessages.find((m) => m.method === 'sendMessage');
    assert.ok(statusMsg);
    assert.ok(statusMsg.body.text.includes('Jarvis System Status'));
    assert.ok(statusMsg.body.text.includes('Memory:'));
  });

  test('should handle /new and /sessions commands', async () => {
    const newUpdate: TelegramUpdate = {
      update_id: 3,
      message: {
        message_id: 52,
        from: { id: 123456789, is_bot: false, first_name: 'Owner' },
        chat: { id: 123456789, type: 'private' },
        date: 12345,
        text: '/new Automation Plan',
      },
    };

    await bot.handleUpdate(newUpdate);

    const newSessionMsg = sentMessages.find(
      (m) => m.method === 'sendMessage' && m.body.text.includes('Created and switched to session')
    );
    assert.ok(newSessionMsg);
    assert.ok(newSessionMsg.body.text.includes('Automation Plan'));
  });

  test('should process Tier 2 approval callback query from owner', async () => {
    const callbackUpdate: TelegramUpdate = {
      update_id: 4,
      callback_query: {
        id: 'cb-1',
        from: { id: 123456789, is_bot: false, first_name: 'Owner' },
        message: {
          message_id: 77,
          chat: { id: 123456789, type: 'private' },
          date: 12345,
          text: 'Approve git commit?',
        },
        data: 'approve:act-git-commit-1',
      },
    };

    await bot.handleUpdate(callbackUpdate);

    const answered = sentMessages.find((m) => m.method === 'answerCallbackQuery');
    assert.ok(answered);
    assert.equal(answered.body.text, 'Action Approved.');

    const edited = sentMessages.find((m) => m.method === 'editMessageText');
    assert.ok(edited);
    assert.ok(edited.body.text.includes('[APPROVED]'));

    const logs = await killSwitch.getRecentAuditLogs();
    assert.equal(logs[0].eventType, 'ACTION_APPROVED');
  });

  test('should trigger emergency stop on /kill command', async () => {
    const killUpdate: TelegramUpdate = {
      update_id: 5,
      message: {
        message_id: 55,
        from: { id: 123456789, is_bot: false, first_name: 'Owner' },
        chat: { id: 123456789, type: 'private' },
        date: 12345,
        text: '/kill',
      },
    };

    await bot.handleUpdate(killUpdate);

    assert.equal(killSwitch.isKilled(), true);
    const killMsg = sentMessages.find((m) => m.method === 'sendMessage' && m.body.text.includes('EMERGENCY STOP TRIGGERED'));
    assert.ok(killMsg);
  });

  test('should handle /models and /model commands', async () => {
    const modelsUpdate: TelegramUpdate = {
      update_id: 6,
      message: {
        message_id: 56,
        from: { id: 123456789, is_bot: false, first_name: 'Owner' },
        chat: { id: 123456789, type: 'private' },
        date: 12345,
        text: '/models',
      },
    };

    await bot.handleUpdate(modelsUpdate);
    const modelsMsg = sentMessages.find((m) => m.method === 'sendMessage' && m.body.text.includes('Installed Local Models'));
    assert.ok(modelsMsg);

    const switchUpdate: TelegramUpdate = {
      update_id: 7,
      message: {
        message_id: 57,
        from: { id: 123456789, is_bot: false, first_name: 'Owner' },
        chat: { id: 123456789, type: 'private' },
        date: 12346,
        text: '/model qwen2.5-coder:7b',
      },
    };

    await bot.handleUpdate(switchUpdate);
    assert.equal(llmProvider.getModel(), 'qwen2.5-coder:7b');
  });

  test('should handle regular chat messages with answer generation', async () => {
    const chatUpdate: TelegramUpdate = {
      update_id: 8,
      message: {
        message_id: 58,
        from: { id: 123456789, is_bot: false, first_name: 'Owner' },
        chat: { id: 123456789, type: 'private' },
        date: 12347,
        text: 'What is the UMA memory configuration?',
      },
    };

    await bot.handleUpdate(chatUpdate);
    const reply = sentMessages.find((m) => m.method === 'sendMessage' && m.body.text.includes('Jarvis test answer'));
    assert.ok(reply);
  });

  function ownerText(updateId: number, text: string): TelegramUpdate {
    return {
      update_id: updateId,
      message: {
        message_id: 200 + updateId,
        from: { id: 123456789, is_bot: false, first_name: 'Owner' },
        chat: { id: 123456789, type: 'private' },
        date: 12400 + updateId,
        text,
      },
    };
  }

  test('the second chat message\'s prompt includes the first message (T0 turns)', async () => {
    const prompts: string[] = [];
    llmProvider.generate = async (prompt: string) => {
      prompts.push(prompt);
      return 'Jarvis test answer';
    };
    await bot.handleUpdate(ownerText(20, 'My favourite colour is green'));
    await bot.handleUpdate(ownerText(21, 'Recall my colour'));
    const chatPrompts = prompts.filter((p) => p.includes('User Request:'));
    assert.equal(chatPrompts.length, 2);
    assert.ok(chatPrompts[1].includes('My favourite colour is green'), chatPrompts[1]);
  });

  test('a new session does not see the previous session\'s turns', async () => {
    const prompts: string[] = [];
    llmProvider.generate = async (prompt: string) => {
      prompts.push(prompt);
      return 'Jarvis test answer';
    };
    await bot.handleUpdate(ownerText(30, 'TG-ISOLATION-MARKER first session'));
    await bot.handleUpdate(ownerText(31, '/new Second Workspace'));
    await bot.handleUpdate(ownerText(32, 'Fresh start here'));
    const last = prompts.filter((p) => p.includes('User Request:')).at(-1) ?? '';
    assert.ok(last.includes('Fresh start here'));
    assert.ok(!last.includes('TG-ISOLATION-MARKER'));
  });

  function capturePrompts(): string[] {
    const prompts: string[] = [];
    llmProvider.generate = async (prompt: string) => {
      prompts.push(prompt);
      return 'Jarvis test answer';
    };
    return prompts;
  }

  const chatPromptsOf = (prompts: string[]) => prompts.filter((p) => p.includes('User Request:'));

  test('chat turns are stored as SessionManager messages of the active session', async () => {
    await bot.handleUpdate(ownerText(60, 'Plan the grocery run'));

    const owned = await sessions.listSessions('123456789');
    assert.equal(owned.length, 1);
    assert.equal(owned[0].title, 'Default Session');
    const messages = await sessions.getMessages('123456789', owned[0].id);
    assert.deepEqual(
      messages.map((m) => [m.role, m.content]),
      [
        ['user', 'Plan the grocery run'],
        ['assistant', 'Jarvis test answer'],
      ]
    );
  });

  test('turns and the active session survive a bot restart', async () => {
    const prompts = capturePrompts();
    await bot.handleUpdate(ownerText(61, 'RESTART-MARKER my project is called Jarvis'));
    const [sessionBefore] = await sessions.listSessions('123456789');

    // Simulates a process restart: a fresh connection, managers, and bot over the same database file.
    store.close();
    store = new DocumentStore(testDbPath);
    sessions = new SessionManager(store);
    memory = new MemoryManager(store);
    const restarted = new TelegramBotClient({
      token: 'mock-test-token',
      ownerId: '123456789',
      sessionManager: sessions,
      memoryManager: memory,
      killSwitch: new KillSwitch(store, sessions),
      llmProvider,
    });
    restarted.apiCall = bot.apiCall;

    await restarted.handleUpdate(ownerText(62, 'Name the project I mentioned'));

    const afterRestart = chatPromptsOf(prompts).at(-1) ?? '';
    assert.ok(afterRestart.includes('RESTART-MARKER my project is called Jarvis'), afterRestart);
    const owned = await sessions.listSessions('123456789');
    assert.deepEqual(owned.map((s) => s.id), [sessionBefore.id], 'no new Default Session after a restart');
    assert.equal((await sessions.getMessages('123456789', sessionBefore.id)).length, 4);
  });

  test('a session started on the web can be continued on Telegram with /switch', async () => {
    const prompts = capturePrompts();
    const web = new ChatStore(sessions, '123456789');
    const webSession = await web.createSession('Started on the web');
    await web.addMessage({ sessionId: webSession.id!, role: 'user', content: 'WEB-MARKER planning a trip to Goa' });
    await web.addMessage({ sessionId: webSession.id!, role: 'assistant', content: 'Sounds fun' });

    await bot.handleUpdate(ownerText(70, `/switch ${webSession.id}`));
    await bot.handleUpdate(ownerText(71, 'Continue the trip plan'));

    const last = chatPromptsOf(prompts).at(-1) ?? '';
    assert.ok(last.includes('WEB-MARKER planning a trip to Goa'), last);
    const webView = await web.getMessages(webSession.id!);
    assert.deepEqual(webView.slice(2).map((m) => [m.role, m.content]), [
      ['user', 'Continue the trip plan'],
      ['assistant', 'Jarvis test answer'],
    ]);
  });

  test('deleting the active session elsewhere starts a fresh Telegram session', async () => {
    const prompts = capturePrompts();
    await bot.handleUpdate(ownerText(80, 'DELETED-MARKER soon to be gone'));
    const [first] = await sessions.listSessions('123456789');
    await sessions.deleteSession('123456789', first.id);

    await bot.handleUpdate(ownerText(81, 'Starting over'));

    const last = chatPromptsOf(prompts).at(-1) ?? '';
    assert.ok(!last.includes('DELETED-MARKER'), last);
    const owned = await sessions.listSessions('123456789');
    assert.equal(owned.length, 1);
    assert.notEqual(owned[0].id, first.id);
    assert.equal((await sessions.getMessages('123456789', owned[0].id)).length, 2);
  });

  test('"remember that ..." stores a profile fact', async () => {
    await bot.handleUpdate(ownerText(40, 'Remember that my editor is Neovim'));
    const facts = await memory.getProfileFacts('123456789');
    assert.ok(facts.some((f) => f.value === 'my editor is Neovim'));
  });

  test('a completed chat turn records an episode', async () => {
    await bot.handleUpdate(ownerText(50, 'Draft my weekly plan'));
    const episodes = await memory.queryEpisodes({ userId: '123456789' });
    assert.equal(episodes.length, 1);
    assert.equal(episodes[0].goal, 'Draft my weekly plan');
  });

  test('a Markdown parse failure is retried as plain text instead of being dropped', async () => {
    const calls: Array<Record<string, unknown> | undefined> = [];
    bot.apiCall = async <T>(method: string, body?: Record<string, unknown>): Promise<T> => {
      calls.push(body);
      if (method === 'sendMessage' && body?.parse_mode) {
        throw new Error("Telegram API error [sendMessage]: Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 7");
      }
      return { message_id: 1, chat: { id: 1, type: 'private' }, date: 0, text: String(body?.text ?? '') } as T;
    };
    const sent = await bot.sendMessage(123456789, 'snake_case and *unclosed', { parse_mode: 'Markdown' });
    assert.equal(sent.length, 1);
    assert.equal(calls.length, 2);
    assert.equal(calls[1]?.parse_mode, undefined);
    assert.equal(calls[1]?.text, 'snake_case and *unclosed');
  });

  test('non-parse send failures still throw', async () => {
    bot.apiCall = async <T>(): Promise<T> => {
      throw new Error('Telegram API error [sendMessage]: Forbidden: bot was blocked by the user');
    };
    await assert.rejects(bot.sendMessage(123456789, 'hi', { parse_mode: 'Markdown' }), /Forbidden/);
  });
});
