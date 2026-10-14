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

  describe('honest speed metrics', () => {
    test('decode and prompt-evaluation speed come from the backend timings; tokensPerSec stays end-to-end', async () => {
      const entry = await ledger.recordUsage({
        model: 'qwen3:8b',
        lane: 'resident',
        promptTokens: 200,
        completionTokens: 120,
        latencyMs: 19_500,
        loadMs: 12_000,
        promptEvalMs: 500,
        decodeMs: 4_000,
        doneReason: 'stop',
      });
      assert.equal(entry.decodeTokensPerSec, 30);
      assert.equal(entry.promptEvalTokensPerSec, 400);
      assert.equal(entry.loadMs, 12_000);
      assert.equal(entry.doneReason, 'stop');
      assert.equal(entry.tokensPerSec, 6.15, '120 tokens over the full 19.5 s, load and thinking included');
    });

    test('a call without backend timings has no decode figure, not a zero', async () => {
      const entry = await ledger.recordUsage({ model: 'qwen3:8b', lane: 'resident', promptTokens: 10, completionTokens: 20, latencyMs: 1000 });
      assert.ok(!('decodeTokensPerSec' in entry));
      assert.ok(!('loadMs' in entry));
      assert.equal(entry.tokensPerSec, 20);
      const zero = await ledger.recordUsage({ model: 'qwen3:8b', lane: 'resident', promptTokens: 10, completionTokens: 20, latencyMs: 1000, decodeMs: 0 });
      assert.ok(!('decodeTokensPerSec' in zero), 'a zero decode time cannot divide');
      assert.equal(zero.decodeMs, 0);
    });

    test('summaries average decode speed and load only over the rows that have them, including an old row', async () => {
      // A row written before the backend counters were captured, straight into the collection.
      await store.getCollection('cost_ledger').insertOne({
        id: 'ledg-old-1',
        modelId: 'qwen3:8b',
        lane: 'resident',
        promptTokens: 10,
        completionTokens: 10,
        totalTokens: 20,
        latencyMs: 1000,
        tokensPerSec: 10,
        timestamp: '2026-01-01T00:00:00.000Z',
      });
      await ledger.recordUsage({ model: 'qwen3:8b', lane: 'resident', promptTokens: 1, completionTokens: 40, latencyMs: 5000, decodeMs: 1000, loadMs: 3000 });
      await ledger.recordUsage({ model: 'qwen3:8b', lane: 'resident', promptTokens: 1, completionTokens: 60, latencyMs: 5000, decodeMs: 1000, loadMs: 1000 });

      const summary = await ledger.getSummary({ modelId: 'qwen3:8b' });
      assert.equal(summary.totalInvocations, 3);
      assert.equal(summary.avgDecodeTokensPerSec, 50, '(40 + 60) / 2: the old row is not counted as 0');
      assert.equal(summary.avgLoadMs, 2000);
      assert.equal(summary.avgTokensPerSec, 10, 'end-to-end mean over all three rows: (10 + 8 + 12) / 3');

      const byModel = await ledger.getSummaryByModel();
      assert.equal(byModel['qwen3:8b'].avgDecodeTokensPerSec, 50);
    });

    test('summaries are null, not zero, when no row carries the new fields', async () => {
      await ledger.recordUsage({ model: 'qwen3:14b', lane: 'balanced', promptTokens: 1, completionTokens: 5, latencyMs: 500 });
      const summary = await ledger.getSummary({ modelId: 'qwen3:14b' });
      assert.equal(summary.avgDecodeTokensPerSec, null);
      assert.equal(summary.avgLoadMs, null);
      const empty = await ledger.getSummary({ modelId: 'nothing' });
      assert.equal(empty.avgDecodeTokensPerSec, null);
    });

    test('record() computes decodeTokensPerSec for callers that pass decodeMs (agent orchestrator path)', async () => {
      const entry = await ledger.record({ modelId: 'qwen3:8b', lane: 'resident', promptTokens: 5, completionTokens: 25, latencyMs: 2000, decodeMs: 500 });
      assert.equal(entry.decodeTokensPerSec, 50);
    });
  });
});
