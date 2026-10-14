/**
 * Unit Tests: MultiModelEnsemble
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MultiModelEnsemble, lexicalSimilarity, type EnsembleResult } from '../src/orchestration/ensemble.js';
import { CapabilityChecker } from '../src/orchestration/capability.js';
import { MemoryGovernor } from '../src/orchestration/governor.js';
import { MockLLMProvider } from '../src/services/provider.js';

const GIB = 1024 * 1024 * 1024;
const INSTALLED = [
  { name: 'qwen3:8b', size: 5225388164 },
  { name: 'qwen3:14b', size: 9276198565 },
  { name: 'qwen3.8:27b', size: 17741872154 },
];

function make(answers: Record<string, string | Error>, installed = INSTALLED) {
  const running = { now: 0, max: 0 };
  const order: string[] = [];
  const checker = new CapabilityChecker({ minHeadroomBytes: 1, env: {} });
  checker.getFreeMemory = () => 200 * GIB;
  checker.getTotalMemory = () => 256 * GIB;
  const ensemble = new MultiModelEnsemble({
    governor: new MemoryGovernor({ capabilityChecker: checker, pacingDelayMs: 0 }),
    getInstalled: async () => installed,
    getVramFreeBytes: async () => 45 * GIB,
    providerFactory: (tag) => {
      const p = new MockLLMProvider({ model: tag });
      p.generate = async () => {
        order.push(tag);
        running.now += 1;
        running.max = Math.max(running.max, running.now);
        await new Promise((r) => setTimeout(r, 2));
        running.now -= 1;
        const a = answers[tag];
        if (a instanceof Error) throw a;
        return a ?? '';
      };
      return p;
    },
  });
  return { ensemble, running, order };
}

describe('MultiModelEnsemble', () => {
  test('runs heavy models one at a time, never concurrently', async () => {
    const { ensemble, running, order } = make({ 'qwen3:8b': 'the answer is 42', 'qwen3:14b': 'the answer is 42', 'qwen3.8:27b': 'the answer is 42' });
    const res = await ensemble.generateSimultaneous('what is the answer');
    assert.equal(running.max, 1);
    assert.deepEqual(order, ['qwen3:8b', 'qwen3:14b', 'qwen3.8:27b']);
    assert.equal(res.corroborated, true);
    assert.equal(res.consensusScore, 1);
  });

  test('skips models that are not installed and says why', async () => {
    const { ensemble } = make({ 'qwen3:8b': 'alpha beta', 'qwen3:14b': 'alpha beta' });
    const res = await ensemble.generateSimultaneous('q', { models: ['qwen3:8b', 'qwen3:14b', 'qwen3:72b', 'qwen2.5:7b'] });
    assert.deepEqual(res.modelsUsed, ['qwen3:8b', 'qwen3:14b']);
    assert.deepEqual(res.skipped?.map((s) => s.model), ['qwen3:72b', 'qwen2.5:7b']);
    assert.ok(res.skipped?.every((s) => s.reason.length > 0));
  });

  test('picks the primary by agreement, not by name', async () => {
    const { ensemble } = make({
      'qwen3:8b': 'paris is the capital of france',
      'qwen3:14b': 'bananas are yellow and tasty fruit',
      'qwen3.8:27b': 'the capital of france is paris',
    });
    const res = await ensemble.generateSimultaneous('capital of france?');
    assert.equal(res.primaryModel, 'qwen3.8:27b');
    assert.ok(res.consensusScore < 1);
  });

  test('a single answer is not presented as consensus', async () => {
    const { ensemble } = make({ 'qwen3:8b': 'only me', 'qwen3:14b': new Error('boom') }, INSTALLED);
    const res = await ensemble.generateSimultaneous('q', { models: ['qwen3:8b', 'qwen3:14b'] });
    assert.equal(res.corroborated, false);
    assert.equal(res.consensusScore, 0);
    assert.equal(res.candidates[1].status, 'rejected');
    const text = MultiModelEnsemble.formatEnsembleResponse(res);
    assert.match(text, /Not corroborated/);
    assert.doesNotMatch(text, /\d+%/);
  });

  test('throws when every model fails or is skipped', async () => {
    const { ensemble } = make({}, []);
    await assert.rejects(ensemble.generateSimultaneous('q'), /All ensemble models failed/);
  });

  test('lexicalSimilarity is word-set Jaccard', () => {
    assert.equal(lexicalSimilarity('a b c', 'a b c'), 1);
    assert.equal(lexicalSimilarity('a b', 'c d'), 0);
    assert.equal(lexicalSimilarity('a b', 'b c'), 1 / 3);
  });

  test('formats a corroborated response with attribution and agreement', () => {
    const mockResult: EnsembleResult = {
      primaryAnswer: 'Gold rate is X.',
      candidates: [
        { model: 'qwen3:8b', answer: 'a', latencyMs: 350, status: 'fulfilled' },
        { model: 'qwen3:14b', answer: 'b', latencyMs: 620, status: 'fulfilled' },
      ],
      consensusScore: 0.95,
      modelsUsed: ['qwen3:8b', 'qwen3:14b'],
      totalLatencyMs: 970,
    };
    const formatted = MultiModelEnsemble.formatEnsembleResponse(mockResult, false);
    assert.match(formatted, /Gold rate is X/);
    assert.match(formatted, /qwen3:8b/);
    assert.match(formatted, /95%/);
    assert.doesNotMatch(formatted, /simultaneously/i);
  });

  test('comparison mode lists every model including skipped and failed ones', () => {
    const mockResult: EnsembleResult = {
      primaryAnswer: 'Final answer',
      candidates: [
        { model: 'qwen3:8b', answer: 'Output from 8B', latencyMs: 250, status: 'fulfilled' },
        { model: 'qwen3:72b', answer: '', latencyMs: 0, status: 'skipped', error: 'not installed' },
        { model: 'qwen3:14b', answer: '', latencyMs: 5, status: 'rejected', error: 'boom' },
      ],
      consensusScore: 0,
      corroborated: false,
      modelsUsed: ['qwen3:8b'],
      totalLatencyMs: 300,
    };
    const formatted = MultiModelEnsemble.formatEnsembleResponse(mockResult, true);
    assert.match(formatted, /Model Comparison Breakdown/i);
    assert.match(formatted, /Output from 8B/);
    assert.match(formatted, /skipped: _not installed_/);
    assert.match(formatted, /failed: _boom_/);
  });
});
