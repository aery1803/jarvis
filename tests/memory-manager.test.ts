import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DocumentStore } from '../src/storage/collection.js';
import { MemoryManager } from '../src/memory/manager.js';
import { encryptSensitive, decryptSensitive } from '../src/memory/crypto.js';

describe('MemoryManager & Crypto', () => {
  const testDbPath = path.resolve(process.cwd(), 'data', 'test-memory.db');
  let store: DocumentStore;
  let memory: MemoryManager;
  let keyDir: string;
  let vault: { keyPath: string; env: NodeJS.ProcessEnv };

  beforeEach(() => {
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
    keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-memory-'));
    vault = { keyPath: path.join(keyDir, 'vault.key'), env: {} };
    store = new DocumentStore(testDbPath);
    memory = new MemoryManager(store, { vault });
  });

  afterEach(() => {
    fs.rmSync(keyDir, { recursive: true, force: true });
    store.close();
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  test('should encrypt and decrypt sensitive strings with AES-256-GCM', () => {
    const secret = 'super-secret-api-token-998877';
    const encrypted = encryptSensitive(secret, vault);

    assert.ok(encrypted.ciphertext);
    assert.ok(encrypted.iv);
    assert.ok(encrypted.authTag);
    assert.notEqual(encrypted.ciphertext, secret);

    const decrypted = decryptSensitive(encrypted, vault);
    assert.equal(decrypted, secret);
  });

  test('should manage T1 Owner Profile facts and format them for prompt', async () => {
    await memory.setProfileFact('owner-1', 'preferred_tone', 'Concise and technical', 'style');
    await memory.setProfileFact('owner-1', 'editor', 'VS Code', 'preference');

    const facts = await memory.getProfileFacts('owner-1');
    assert.equal(facts.length, 2);

    const promptText = await memory.formatProfileForPrompt('owner-1');
    assert.ok(promptText.includes('preferred_tone'));
    assert.ok(promptText.includes('Concise and technical'));
    assert.ok(promptText.includes('VS Code'));
  });

  test('should store and retrieve T2 session summaries', async () => {
    await memory.saveSessionSummary('owner-1', 'session-101', 'Discussed SQLite migration', 4);
    await memory.saveSessionSummary('owner-1', 'session-101', 'Finalized tool calling schema', 8);

    const summaries = await memory.getSessionSummaries('owner-1', 'session-101');
    assert.equal(summaries.length, 2);
    assert.ok(summaries[0].summary.includes('tool calling'));
  });

  test('should record and query T3 episodic memories', async () => {
    const episode = await memory.recordEpisode({
      userId: 'owner-1',
      sessionId: 'session-101',
      goal: 'Benchmark Ollama models',
      steps: ['Run benchmark script', 'Record tokens/sec'],
      outcome: 'Qwen 7b achieved 41 t/s',
      feedback: 'positive',
    });

    assert.ok(episode.id.startsWith('ep-'));
    const results = await memory.queryEpisodes({ userId: 'owner-1', feedback: 'positive' });
    assert.equal(results.length, 1);
    assert.equal(results[0].goal, 'Benchmark Ollama models');
  });

  test('should securely store and retrieve sensitive items from encrypted vault', async () => {
    await memory.storeSensitive('owner-1', 'db_password', 'p@ssw0rd123!');
    const retrieved = await memory.retrieveSensitive('owner-1', 'db_password');
    assert.equal(retrieved, 'p@ssw0rd123!');

    const missing = await memory.retrieveSensitive('owner-1', 'unknown_tag');
    assert.equal(missing, null);
  });

  test('should assemble prompt context within token budget without raw memory leaks', async () => {
    await memory.setProfileFact('owner-1', 'framework', 'Node.js', 'preference');
    await memory.saveSessionSummary('owner-1', 'session-101', 'Set up project board #2', 2);

    const ctx = await memory.buildPromptContext({
      userId: 'owner-1',
      sessionId: 'session-101',
      maxTokens: 500,
      includeTiers: ['T0', 'T1', 'T2'],
      workingContext: {
        currentTask: 'Build Telegram bot',
        recentTurns: [{ role: 'user', content: 'Start Phase 2' }],
      },
    });

    assert.ok(ctx.systemPromptAdditions.includes('Node.js'));
    assert.ok(ctx.systemPromptAdditions.includes('Set up project board #2'));
    assert.ok(ctx.workingContextFormatted.includes('Build Telegram bot'));
    assert.ok(ctx.totalEstimatedTokens > 0);
    assert.ok(ctx.includedTiers.includes('T1'));
    assert.ok(ctx.includedTiers.includes('T2'));
    assert.ok(ctx.includedTiers.includes('T0'));
  });
});
