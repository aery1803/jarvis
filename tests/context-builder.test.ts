/**
 * Unit Tests: Conversation Context Builder (Memory Tiers T0, T1, T2, T4)
 * Authority: Section 8 (Memory), FEAT-004
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DocumentStore } from '../src/storage/collection.js';
import { MemoryManager } from '../src/memory/manager.js';
import { MockLLMProvider } from '../src/services/provider.js';
import {
  buildConversationContext,
  summarizeAndStoreSession,
  parseRememberCommand,
  pickSmallestModel,
  shouldSummarize,
  estimateTokens,
  type ConversationMemory,
  type ConversationTurn,
} from '../src/memory/context-builder.js';

describe('buildConversationContext', () => {
  let memory: MemoryManager;

  beforeEach(() => {
    memory = new MemoryManager(new DocumentStore(':memory:'));
  });

  test('includes the current conversation turns in order', async () => {
    const turns: ConversationTurn[] = [
      { role: 'user', content: 'My favourite colour is green' },
      { role: 'assistant', content: 'Noted.' },
    ];
    const ctx = await buildConversationContext({ memory, userId: 'owner', sessionId: 's1', prompt: 'What colour?', turns });
    assert.ok(ctx.text.indexOf('My favourite colour is green') < ctx.text.indexOf('Noted.'));
    assert.deepEqual(ctx.includedTiers, ['T0']);
    assert.equal(ctx.turnsIncluded, 2);
  });

  test('keeps the newest turns and drops the oldest when the budget is reached', async () => {
    const turns: ConversationTurn[] = Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `turn-${i} ${'x'.repeat(200)}`,
    }));
    const ctx = await buildConversationContext({ memory, userId: 'owner', sessionId: 's1', prompt: 'p', turns, maxTokens: 600 });
    assert.ok(ctx.text.includes('turn-39 '));
    assert.ok(!ctx.text.includes('turn-0 '));
    assert.ok(ctx.turnsIncluded > 0 && ctx.turnsIncluded < 40);
    assert.ok(ctx.estimatedTokens <= 600, `estimated ${ctx.estimatedTokens}`);
  });

  test('clamps a single very long message so it cannot consume the budget', async () => {
    const turns: ConversationTurn[] = [
      { role: 'user', content: 'early but important' },
      { role: 'user', content: `PASTE-START ${'y'.repeat(50_000)}` },
    ];
    const ctx = await buildConversationContext({ memory, userId: 'owner', sessionId: 's1', prompt: 'p', turns, maxTokens: 2000 });
    assert.ok(ctx.text.includes('PASTE-START'));
    assert.ok(ctx.text.includes('early but important'));
    assert.ok(ctx.text.includes('chars omitted'));
    assert.ok(estimateTokens(ctx.text) <= 2000);
  });

  test('includes the owner profile (T1) and other sessions\' summaries (T2), but not this session\'s own summary', async () => {
    await memory.setProfileFact('owner', 'favourite colour', 'green');
    await memory.saveSessionSummary('owner', 'other-session', 'OTHER-SESSION-SUMMARY', 6);
    await memory.saveSessionSummary('owner', 's1', 'THIS-SESSION-SUMMARY', 6);
    await memory.saveSessionSummary('someone-else', 'x', 'FOREIGN-USER-SUMMARY', 6);
    const ctx = await buildConversationContext({ memory, userId: 'owner', sessionId: 's1', prompt: 'p', turns: [] });
    assert.ok(ctx.text.includes('green'));
    assert.ok(ctx.text.includes('OTHER-SESSION-SUMMARY'));
    assert.ok(!ctx.text.includes('THIS-SESSION-SUMMARY'));
    assert.ok(!ctx.text.includes('FOREIGN-USER-SUMMARY'));
    assert.deepEqual(ctx.includedTiers, ['T1', 'T2']);
  });

  test('uses only the latest summary per other session', async () => {
    await memory.saveSessionSummary('owner', 'other', 'OLD-SUMMARY', 6);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await memory.saveSessionSummary('owner', 'other', 'NEW-SUMMARY', 12);
    const ctx = await buildConversationContext({ memory, userId: 'owner', sessionId: 's1', prompt: 'p', turns: [] });
    assert.ok(ctx.text.includes('NEW-SUMMARY'));
    assert.ok(!ctx.text.includes('OLD-SUMMARY'));
  });

  test('includes relevant knowledge (T4) wrapped as data', async () => {
    await memory.saveKnowledge({ userId: 'owner', title: 'Kubernetes notes', content: 'KNOWLEDGE-BODY', tags: ['kubernetes'] });
    const ctx = await buildConversationContext({ memory, userId: 'owner', sessionId: 's1', prompt: 'help with kubernetes please', turns: [] });
    assert.ok(ctx.text.includes('KNOWLEDGE-BODY'));
    assert.ok(ctx.text.includes('<data'));
    assert.ok(ctx.includedTiers.includes('T4'));
  });

  test('never throws when the store fails; returns the turns it still has', async () => {
    const failing: ConversationMemory = {
      formatProfileForPrompt: async () => {
        throw new Error('db locked');
      },
      getSessionSummaries: async () => {
        throw new Error('db locked');
      },
      searchKnowledge: async () => {
        throw new Error('db locked');
      },
      saveSessionSummary: async () => {
        throw new Error('db locked');
      },
    };
    const ctx = await buildConversationContext({
      memory: failing,
      userId: 'owner',
      sessionId: 's1',
      prompt: 'p',
      turns: [{ role: 'user', content: 'still here' }],
    });
    assert.ok(ctx.text.includes('still here'));
    assert.deepEqual(ctx.includedTiers, ['T0']);
  });

  test('works with no memory manager at all', async () => {
    const ctx = await buildConversationContext({ userId: 'owner', sessionId: 's1', prompt: 'p' });
    assert.equal(ctx.text, '');
    assert.equal(ctx.estimatedTokens, 0);
  });
});

describe('summarizeAndStoreSession', () => {
  test('stores a summary generated by the given summarizer', async () => {
    const memory = new MemoryManager(new DocumentStore(':memory:'));
    const summarizer = new MockLLMProvider({ cannedResponse: '  Owner likes green.  ' });
    const summary = await summarizeAndStoreSession({
      memory,
      summarizer,
      userId: 'owner',
      sessionId: 's1',
      turns: [
        { role: 'user', content: 'My favourite colour is green' },
        { role: 'assistant', content: 'Noted.' },
      ],
    });
    assert.equal(summary, 'Owner likes green.');
    const stored = await memory.getSessionSummaries('owner', 's1');
    assert.equal(stored[0].summary, 'Owner likes green.');
  });

  test('returns null instead of throwing when the summarizer fails', async () => {
    const memory = new MemoryManager(new DocumentStore(':memory:'));
    const summarizer = new MockLLMProvider();
    summarizer.generate = async () => {
      throw new Error('model offline');
    };
    const summary = await summarizeAndStoreSession({
      memory,
      summarizer,
      userId: 'owner',
      sessionId: 's1',
      turns: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(summary, null);
  });
});

describe('summaries of deleted sessions and the summarizer request', () => {
  test('a summary whose session no longer exists is not injected when the live sessions are known', async () => {
    const memory = new MemoryManager(new DocumentStore(':memory:'));
    await memory.saveSessionSummary('owner', 'gone', 'The owner talked about a secret project in the deleted chat.', 6);
    await memory.saveSessionSummary('owner', 'alive', 'The owner talked about gardening in another chat.', 6);
    const unfiltered = await buildConversationContext({ memory, userId: 'owner', sessionId: 'now', prompt: 'hello' });
    assert.ok(unfiltered.text.includes('secret project'), 'without the filter both are injected');
    const filtered = await buildConversationContext({ memory, userId: 'owner', sessionId: 'now', prompt: 'hello', liveSessionIds: new Set(['alive', 'now']) });
    assert.ok(!filtered.text.includes('secret project'));
    assert.ok(filtered.text.includes('gardening'));
  });

  test('the summary request carries the abort signal and timeout, and strips <think> from input and output', async () => {
    const memory = new MemoryManager(new DocumentStore(':memory:'));
    const controller = new AbortController();
    let seenPrompt = '';
    let seenOptions: { signal?: AbortSignal; timeoutMs?: number } = {};
    const summarizer = new MockLLMProvider();
    summarizer.generate = async (prompt, options) => {
      seenPrompt = prompt;
      seenOptions = { signal: options?.signal, timeoutMs: options?.timeoutMs };
      return '<think>planning the summary</think>Owner prefers short answers.';
    };
    const summary = await summarizeAndStoreSession({
      memory,
      summarizer,
      userId: 'owner',
      sessionId: 's1',
      signal: controller.signal,
      timeoutMs: 120_000,
      turns: [
        { role: 'user', content: 'Keep it short' },
        { role: 'assistant', content: '<think>the owner wants brevity</think>Will do.' },
      ],
    });
    assert.equal(summary, 'Owner prefers short answers.');
    assert.equal(seenOptions.signal, controller.signal);
    assert.equal(seenOptions.timeoutMs, 120_000);
    assert.ok(seenPrompt.includes('Will do.'));
    assert.ok(!seenPrompt.includes('the owner wants brevity'), 'reasoning is not part of the summary input');
    assert.equal((await memory.getSessionSummaries('owner', 's1'))[0].summary, 'Owner prefers short answers.');
  });
});

describe('helpers', () => {
  test('shouldSummarize fires at 6 messages and every 6 thereafter', () => {
    assert.deepEqual(
      [1, 2, 5, 6, 7, 11, 12, 18].map(shouldSummarize),
      [false, false, false, true, false, false, true, true]
    );
  });

  test('parseRememberCommand only matches explicit "remember that ..."', () => {
    assert.deepEqual(parseRememberCommand('Remember that my favourite colour is green.'), {
      key: 'my-favourite-colour',
      value: 'my favourite colour is green',
    });
    assert.deepEqual(parseRememberCommand('please remember that I prefer short answers'), {
      key: 'i-prefer-short-answers',
      value: 'I prefer short answers',
    });
    assert.equal(parseRememberCommand('my favourite colour is green'), null);
    assert.equal(parseRememberCommand('do you remember that film?'), null);
  });

  test('pickSmallestModel chooses the smallest parameter count and skips embedding models', () => {
    assert.equal(pickSmallestModel(['qwen3:8b', 'qwen2.5:7b', 'qwen2.5:0.5b', 'nomic-embed-text:137m', 'llama3.2:3b']), 'qwen2.5:0.5b');
    assert.equal(pickSmallestModel(['gemma3:270m', 'qwen3:8b']), 'gemma3:270m');
    assert.equal(pickSmallestModel(['custom-model']), null);
  });
});

// Sessions stay isolated: the profile (T1) and other sessions' summaries (T2) are the only sanctioned cross-session channels.
describe('buildConversationContext session isolation', () => {
  test('T3 lists only the current session\'s own past tasks', async () => {
    const memory = new MemoryManager(new DocumentStore(':memory:'));
    await memory.recordEpisode({ userId: 'owner', sessionId: 'here', goal: 'Deploy the staging server', steps: [], outcome: 'HERE-OUTCOME' });
    await memory.recordEpisode({ userId: 'owner', sessionId: 'elsewhere', goal: 'Deploy the staging server again', steps: [], outcome: 'ELSEWHERE-OUTCOME' });

    const ctx = await buildConversationContext({ memory, userId: 'owner', sessionId: 'here', prompt: 'Deploy the staging server please' });
    assert.ok(ctx.includedTiers.includes('T3'));
    assert.ok(ctx.text.includes('HERE-OUTCOME'));
    assert.ok(!ctx.text.includes('ELSEWHERE-OUTCOME'));
    assert.ok(!ctx.text.includes('again'), "another session's goal text does not appear either");
  });

  test('a brand-new session gets no T3 section even when other sessions did matching work', async () => {
    const memory = new MemoryManager(new DocumentStore(':memory:'));
    await memory.recordEpisode({ userId: 'owner', sessionId: 'old', goal: 'Deploy the staging server', steps: [], outcome: 'OLD-OUTCOME' });
    const ctx = await buildConversationContext({ memory, userId: 'owner', sessionId: 'new', prompt: 'Deploy the staging server' });
    assert.ok(!ctx.includedTiers.includes('T3'));
    assert.ok(!ctx.text.includes('OLD-OUTCOME'));
  });

  test('the sanctioned channels still cross sessions: the profile (T1) and other sessions\' summaries (T2)', async () => {
    const memory = new MemoryManager(new DocumentStore(':memory:'));
    await memory.setProfileFact('owner', 'drink', 'masala chai');
    await memory.saveSessionSummary('owner', 'old', 'SUMMARY-OF-OLD-CHAT', 6);
    const ctx = await buildConversationContext({ memory, userId: 'owner', sessionId: 'new', prompt: 'hello there' });
    assert.ok(ctx.includedTiers.includes('T1') && ctx.includedTiers.includes('T2'));
    assert.ok(ctx.text.includes('masala chai'));
    assert.ok(ctx.text.includes('SUMMARY-OF-OLD-CHAT'));
  });

  test('a memory without queryEpisodes still works and yields no T3', async () => {
    const ctx = await buildConversationContext({
      memory: {
        formatProfileForPrompt: async () => '',
        getSessionSummaries: async () => [],
        searchKnowledge: async () => [],
        saveSessionSummary: async () => {
          throw new Error('unused');
        },
      },
      userId: 'owner',
      sessionId: 's',
      prompt: 'anything',
    });
    assert.deepEqual(ctx.includedTiers, []);
  });
});
