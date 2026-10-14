import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ModelRegistry } from '../src/orchestration/registry.js';

describe('ModelRegistry', () => {
  test('should initialize with default lanes and verified benchmark models', () => {
    const registry = new ModelRegistry();
    const all = registry.listModels();
    assert.ok(all.length >= 3);

    const qwen7b = registry.getModel('qwen2.5:7b');
    assert.ok(qwen7b);
    assert.equal(qwen7b.lane, 'balanced');
    assert.equal(qwen7b.measuredTokensPerSec, 41.2);

    const qwenCoder = registry.getModel('qwen2.5-coder:7b');
    assert.ok(qwenCoder);
    assert.equal(qwenCoder.lane, 'code');
    assert.equal(qwenCoder.parameterSize, '7B');
  });

  test('should return primary and alternate models for each lane', () => {
    const registry = new ModelRegistry();
    const primaryBalanced = registry.getPrimaryModelForLane('balanced');
    assert.ok(primaryBalanced);
    assert.equal(primaryBalanced.id, 'qwen2.5:7b');

    // Register alternate model
    registry.register({
      id: 'mistral:7b',
      name: 'Mistral 7B',
      lane: 'balanced',
      family: 'mistral',
      parameterSize: '7B',
      quantization: 'q4_k_m',
      memoryRequirementBytes: 4.5 * 1024 * 1024 * 1024,
      contextLength: 32768,
      measuredTokensPerSec: 38.0,
      strengths: ['general reasoning'],
      isPrimary: false,
    });

    const alt = registry.getAlternateModelForLane('balanced', 'qwen2.5:7b');
    assert.ok(alt);
    assert.equal(alt.id, 'mistral:7b');
  });
});
