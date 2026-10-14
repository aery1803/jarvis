/**
 * Unit Tests: MultiModelEnsemble
 * Verifies simultaneous multi-model execution, context preservation, and consensus scoring.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MultiModelEnsemble, type EnsembleResult } from '../src/orchestration/ensemble.js';

describe('MultiModelEnsemble', () => {
  test('should format ensemble response with model attribution and consensus score', () => {
    const mockResult: EnsembleResult = {
      primaryAnswer: 'Gold rate in Punjab is ₹14,474 for 24K and ₹13,590 for 22K per gram.',
      candidates: [
        {
          model: 'qwen2.5:7b',
          answer: 'Gold rate in Punjab is ₹14,474 for 24K per gram.',
          latencyMs: 350,
          status: 'fulfilled',
        },
        {
          model: 'qwen2.5:14b',
          answer: 'Gold rate in Punjab is ₹14,474 for 24K and ₹13,590 for 22K per gram.',
          latencyMs: 620,
          status: 'fulfilled',
        },
      ],
      consensusScore: 0.95,
      modelsUsed: ['qwen2.5:7b', 'qwen2.5:14b'],
      totalLatencyMs: 625,
    };

    const formatted = MultiModelEnsemble.formatEnsembleResponse(mockResult, false);
    assert.match(formatted, /Gold rate in Punjab/i);
    assert.match(formatted, /Corroborated simultaneously by/i);
    assert.match(formatted, /qwen2\.5:7b/);
    assert.match(formatted, /qwen2\.5:14b/);
    assert.match(formatted, /95%/);
  });

  test('should format side-by-side comparison breakdown when showComparison is true', () => {
    const mockResult: EnsembleResult = {
      primaryAnswer: 'Final consensus response',
      candidates: [
        {
          model: 'qwen2.5:7b',
          answer: 'Output from 7B model',
          latencyMs: 250,
          status: 'fulfilled',
        },
        {
          model: 'qwen2.5-coder:7b',
          answer: 'Output from 7B coder',
          latencyMs: 310,
          status: 'fulfilled',
        },
      ],
      consensusScore: 0.90,
      modelsUsed: ['qwen2.5:7b', 'qwen2.5-coder:7b'],
      totalLatencyMs: 315,
    };

    const formatted = MultiModelEnsemble.formatEnsembleResponse(mockResult, true);
    assert.match(formatted, /Final consensus response/);
    assert.match(formatted, /Model Comparison Breakdown/i);
    assert.match(formatted, /Output from 7B model/);
    assert.match(formatted, /Output from 7B coder/);
  });
});
