import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DocumentStore } from '../src/storage/collection.js';
import { CostLedger } from '../src/orchestration/ledger.js';

describe('CostLedger', () => {
  const testDbPath = path.resolve(process.cwd(), 'data', 'test-ledger.db');
  let store: DocumentStore;
  let ledger: CostLedger;

  beforeEach(() => {
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
    store = new DocumentStore(testDbPath);
    ledger = new CostLedger(store);
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  test('should record inference execution and compute token throughput', async () => {
    const entry = await ledger.record({
      taskId: 'task-100',
      agentId: 'researcher',
      modelId: 'qwen2.5:7b',
      lane: 'balanced',
      promptTokens: 100,
      completionTokens: 200,
      latencyMs: 5000,
    });

    assert.equal(entry.totalTokens, 300);
    assert.equal(entry.tokensPerSec, 40.0); // 200 tokens in 5s = 40 t/s
    assert.ok(entry.id.startsWith('ledg-'));
  });

  test('should aggregate summary statistics across recorded entries', async () => {
    await ledger.record({
      modelId: 'qwen2.5:7b',
      lane: 'balanced',
      promptTokens: 50,
      completionTokens: 100,
      latencyMs: 2500,
    });
    await ledger.record({
      modelId: 'qwen2.5:7b',
      lane: 'balanced',
      promptTokens: 150,
      completionTokens: 200,
      latencyMs: 5000,
    });

    const summary = await ledger.getSummary({ modelId: 'qwen2.5:7b' });
    assert.equal(summary.totalInvocations, 2);
    assert.equal(summary.totalPromptTokens, 200);
    assert.equal(summary.totalCompletionTokens, 300);
    assert.equal(summary.totalTokens, 500);
    assert.equal(summary.avgLatencyMs, 3750);
  });
});
