import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EvaluationHarness } from '../src/eval/harness.js';
import { MockLLMProvider } from '../src/services/provider.js';

describe('EvaluationHarness & Quality Gates', () => {
  test('should run evaluation cases and measure accuracy and latency', async () => {
    // Configure mock provider that answers accurately for benchmark cases
    const mockResponses: Record<string, string> = {
      'train leaves': 'The train arrives at 4:00 PM.',
      'system stats': 'Current system stats: 32 GB RAM free, 46 GB Vulkan VRAM.',
      'hardware runs': 'Jarvis runs on the ASUS ROG Flow Z13 with Radeon 8060S.',
    };

    const mockProvider = new MockLLMProvider();
    mockProvider.generate = async (prompt: string) => {
      let matchedText = 'Generic assistant answer.';
      for (const [key, val] of Object.entries(mockResponses)) {
        if (prompt.toLowerCase().includes(key)) {
          matchedText = val;
          break;
        }
      }
      return {
        text: matchedText,
        usage: { promptTokens: 20, completionTokens: 25, totalTokens: 45 },
      };
    };

    const harness = new EvaluationHarness(mockProvider);
    const report = await harness.runAll();

    assert.equal(report.totalTests, 3);
    assert.equal(report.passedTests, 3);
    assert.equal(report.accuracyRate, 1.0);
    assert.equal(report.meetsTarget, true);
    assert.ok(report.avgLatencyMs >= 0);
  });
});
