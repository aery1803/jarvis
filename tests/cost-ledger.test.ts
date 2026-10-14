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
      modelId: 'qwen3:8b',
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
      modelId: 'qwen3:8b',
      lane: 'balanced',
      promptTokens: 50,
      completionTokens: 100,
      latencyMs: 2500,
    });
    await ledger.record({
      modelId: 'qwen3:8b',
      lane: 'balanced',
      promptTokens: 150,
      completionTokens: 200,
      latencyMs: 5000,
    });

    const summary = await ledger.getSummary({ modelId: 'qwen3:8b' });
    assert.equal(summary.totalInvocations, 2);
    assert.equal(summary.totalPromptTokens, 200);
    assert.equal(summary.totalCompletionTokens, 300);
    assert.equal(summary.totalTokens, 500);
    assert.equal(summary.avgLatencyMs, 3750);
  });

  test('recordUsage records chat usage and clamps bad counts', async () => {
    const entry = await ledger.recordUsage({ model: 'qwen3:8b', lane: 'resident', promptTokens: 10, completionTokens: Number.NaN, latencyMs: -5 });
    assert.equal(entry.modelId, 'qwen3:8b');
    assert.equal(entry.completionTokens, 0);
    assert.equal(entry.latencyMs, 0);
    assert.equal(entry.totalTokens, 10);
  });

  test('listByModel and getSummaryByModel group per model', async () => {
    await ledger.recordUsage({ model: 'qwen3:8b', lane: 'resident', promptTokens: 10, completionTokens: 20, latencyMs: 1000 });
    await ledger.recordUsage({ model: 'qwen3:8b', lane: 'resident', promptTokens: 5, completionTokens: 5, latencyMs: 500 });
    await ledger.recordUsage({ model: 'qwen3:14b', lane: 'balanced', promptTokens: 1, completionTokens: 1, latencyMs: 100 });
    assert.equal((await ledger.listByModel('qwen3:8b')).length, 2);
    assert.equal((await ledger.listByModel('qwen3:8b', 1)).length, 1);
    const per = await ledger.getSummaryByModel();
    assert.equal(per['qwen3:8b'].totalInvocations, 2);
    assert.equal(per['qwen3:8b'].totalTokens, 40);
    assert.equal(per['qwen3:14b'].totalInvocations, 1);
  });
});
