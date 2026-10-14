import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EvaluationHarness } from '../src/eval/harness.js';
import { ModelBenchmarkSuite } from '../src/eval/benchmark.js';
import { CognitionEngine } from '../src/agents/cognition.js';
import { MockLLMProvider, HybridProvider, GeminiProvider } from '../src/services/provider.js';

describe('EvaluationHarness & Benchmark Suite', () => {
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
      } as any;
    };

    const harness = new EvaluationHarness(mockProvider);
    const report = await harness.runAll();

    assert.equal(report.totalTests, 3);
    assert.equal(report.passedTests, 3);
    assert.equal(report.accuracyRate, 1.0);
    assert.equal(report.meetsTarget, true);
    assert.ok(report.avgLatencyMs >= 0);
  });

  test('ModelBenchmarkSuite should evaluate reasoning, coding, tools, and retrieval', async () => {
    const mockResponses: Record<string, string> = {
      '180 miles': 'The train arrives at 1:30 PM.',
      'strix halo': 'Yes, the AMD Strix Halo uses unified memory architecture.',
      'task a takes 1 hour': 'Task C completes at 12:00 PM.',
      'fibonacci': 'function fibonacci(n: number, memo: Record<number, number> = {}): number { return memo[n]; }',
      'find the bug': 'The bug is an off-by-one error: i <= arr.length causes index out of bounds. The fix is i < arr.length.',
      'security rule': 'All API tokens must be saved in an AES-256 encrypted vault.',
      'check the system host memory': '{"tool": "system_stats", "parameters": {}}',
      'radeon 8060s memory bandwidth': '{"tool": "searxng_search", "parameters": {"query": "Radeon 8060S memory bandwidth"}}',
      'hardware runs': 'Jarvis runs on ASUS ROG Flow Z13 with AMD Radeon 8060S.',
      'three action execution tiers': 'Tier 1 is safe read-only, Tier 2 requires owner approval, and Tier 3 is strictly forbidden.',
    };

    const mockProvider = new MockLLMProvider({ model: 'qwen2.5-coder:7b' });
    mockProvider.generate = async (prompt: string) => {
      for (const [key, val] of Object.entries(mockResponses)) {
        if (prompt.toLowerCase().includes(key.toLowerCase())) {
          return val;
        }
      }
      return 'Generic fallback response.';
    };

    const suite = new ModelBenchmarkSuite();
    const scorecard = await suite.runBenchmark(mockProvider);

    assert.equal(scorecard.modelName, 'qwen2.5-coder:7b');
    assert.ok(scorecard.overallScore >= 90);
    assert.equal(scorecard.grade, 'A+');
    assert.ok(scorecard.estimatedTokensPerSec >= 0);
    assert.ok(scorecard.categories.reasoning.percentage >= 90);
    assert.ok(scorecard.categories.coding.percentage >= 90);
    assert.ok(scorecard.categories.tool_calling.percentage >= 90);
    assert.ok(scorecard.categories.retrieval.percentage >= 90);
    assert.ok(scorecard.recommendedLanes.includes('code'));

    const mdReport = ModelBenchmarkSuite.formatMarkdownReport(scorecard);
    assert.ok(mdReport.includes('Jarvis Model Intelligence Benchmark'));
    assert.ok(mdReport.includes('Overall Intelligence Score:'));

    const termReport = ModelBenchmarkSuite.formatTerminalReport(scorecard);
    assert.ok(termReport.includes('JARVIS MODEL INTELLIGENCE BENCHMARK REPORT'));
  });

  test('CognitionEngine should format advanced chain-of-thought and expert directives', () => {
    const sysPrompt = CognitionEngine.buildSystemPrompt({ taskType: 'code' });
    assert.ok(sysPrompt.includes('elite, highly intelligent autonomous AI assistant'));
    assert.ok(sysPrompt.includes('Step-by-Step Thinking'));
    assert.ok(sysPrompt.includes('Software Engineering Excellence'));
    assert.ok(sysPrompt.includes('Coding Lane Directives'));
    assert.ok(sysPrompt.includes('English Language Mandate'));

    const fullPrompt = CognitionEngine.formatPrompt('Implement a binary search tree in TypeScript', {
      taskType: 'code',
      memoryContext: 'Owner prefers functional style',
      researchFacts: '[Source 1]: BST algorithm standard implementation',
      consensusScore: 0.95,
      activeModel: 'qwen2.5-coder:7b',
    });

    assert.ok(fullPrompt.includes('Owner prefers functional style'));
    assert.ok(fullPrompt.includes('[Source 1]: BST algorithm'));
    assert.ok(fullPrompt.includes('Source agreement: 95%'));
    assert.ok(!/Verified External/i.test(fullPrompt));
    assert.match(fullPrompt, /<untrusted_data>\n\[Source 1\]: BST algorithm standard implementation\n<\/untrusted_data>/);
    assert.ok(fullPrompt.includes('User Request: Implement a binary search tree'));
  });

  test('HybridProvider should fall back cleanly when cloud inference errors or offline', async () => {
    const localProvider = new MockLLMProvider({ cannedResponse: 'Local Ollama Response' });
    const cloudProvider = new MockLLMProvider({ cannedResponse: 'Cloud Gemini Response' });

    // Simulate cloud error
    cloudProvider.generate = async () => {
      throw new Error('Network timeout or rate limit');
    };

    const hybrid = new HybridProvider({
      localProvider,
      cloudProvider,
      preferCloud: true,
    });

    // Should catch the cloud error and fall back to local provider seamlessly
    const response = await hybrid.generate('Explain quantum computing');
    assert.equal(response, 'Local Ollama Response');
  });
});
