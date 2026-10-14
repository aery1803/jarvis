import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DocumentStore } from '../src/storage/collection.js';
import { SessionManager } from '../src/sessions/manager.js';
import { MemoryManager } from '../src/memory/manager.js';
import { KillSwitch } from '../src/security/kill-switch.js';
import { TelegramBotClient } from '../src/telegram/bot.js';
import { TelegramUpdate } from '../src/telegram/types.js';
import { MockLLMProvider } from '../src/services/provider.js';

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
        text: '/model qwen2.5-coder:1.5b',
      },
    };

    await bot.handleUpdate(switchUpdate);
    assert.equal(llmProvider.getModel(), 'qwen2.5-coder:1.5b');
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
});
