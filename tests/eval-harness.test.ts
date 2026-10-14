import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EvaluationHarness } from '../src/eval/harness.js';
import {
  ModelBenchmarkSuite,
  BenchmarkGuard,
  BenchmarkBusyError,
  benchmarkCache,
  type ModelBenchmarkScorecard,
} from '../src/eval/benchmark.js';
import { CognitionEngine } from '../src/agents/cognition.js';
import { MockLLMProvider, HybridProvider, GeminiProvider, type GenerateOptions, type LLMProvider } from '../src/services/provider.js';

describe('EvaluationHarness & Benchmark Suite', () => {
  test('should run evaluation cases and measure accuracy and latency', async () => {
    // Configure mock provider that answers accurately for benchmark cases
    const mockResponses: Record<string, string> = {
      'train leaves': 'The train arrives at 4:00 PM.',
      'system stats': '{"tool": "system_stats", "parameters": {}}',
      'host ram': '31.65 GB',
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
      'fibonacci': 'function fibonacci(n: number, memo: Record<number, number> = {}): number { return n < 2 ? n : (memo[n] ??= fibonacci(n - 1, memo) + fibonacci(n - 2, memo)); }',
      'find the bug': 'The bug is an off-by-one error: i <= arr.length causes index out of bounds. The fix is i < arr.length.',
      'security rule': 'Rule: API tokens must be saved in an AES-256 encrypted vault and never written to plain text files or logs.',
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

describe('ModelBenchmarkSuite honesty and controls', () => {
  const answers: Array<[string, string]> = [
    ['180 miles', 'The train arrives at 1:30 PM.'],
    ['strix halo', 'Yes, it uses unified memory.'],
    ['task a takes 1 hour', 'Done at 12:00 PM.'],
    ['fibonacci', 'function fibonacci(n, memo = {}) { return n < 2 ? n : (memo[n] ??= fibonacci(n - 1, memo) + fibonacci(n - 2, memo)); }'],
    ['find the bug', 'off-by-one: use i < arr.length'],
    ['security rule', 'Rule: tokens must live in an AES-256 vault and never touch plain text files.'],
    ['check the system host memory', '{"tool": "system_stats", "parameters": {}}'],
    ['radeon 8060s memory bandwidth', '{"tool": "searxng_search", "parameters": {"query": "Radeon 8060S memory bandwidth"}}'],
    ['hardware runs', 'ASUS ROG Flow Z13'],
    ['three action execution tiers', 'Tier 1, Tier 2, Tier 3'],
  ];

  function provider(
    behaviour: (prompt: string, options: GenerateOptions) => Promise<string>,
    model = 'qwen3:8b'
  ): LLMProvider {
    return { getModel: () => model, getBaseUrl: () => '', chat: async () => '', generate: behaviour };
  }

  const answerFor = (prompt: string): string => answers.find(([k]) => prompt.toLowerCase().includes(k))?.[1] ?? 'no idea';

  test('a model that errors on every case (HTTP 404) is reported as ERROR, not as 0% grade F', async () => {
    const p = provider(async () => {
      throw new Error('Ollama error 404: model "qwen2.5:7b" not found');
    }, 'qwen2.5:7b');
    const card = await new ModelBenchmarkSuite().runBenchmark(p);
    assert.equal(card.status, 'error');
    assert.equal(card.grade, 'ERROR');
    assert.match(card.error ?? '', /404/);
    assert.equal(card.answeredCases, 0);
    assert.equal(card.erroredCases, 10);
    assert.deepEqual(card.recommendedLanes, []);
    assert.match(ModelBenchmarkSuite.formatMarkdownReport(card), /ERROR/);
    assert.ok(!/Overall Intelligence Score/.test(ModelBenchmarkSuite.formatMarkdownReport(card)));
    assert.match(ModelBenchmarkSuite.formatTerminalReport(card), /ERROR - the model could not be benchmarked/);
  });

  test('some errored cases make the card partial with an INCOMPLETE grade, scored only over answered cases', async () => {
    let n = 0;
    const p = provider(async (prompt) => {
      if (n++ === 0) throw new Error('timeout');
      return answerFor(prompt);
    });
    const card = await new ModelBenchmarkSuite().runBenchmark(p);
    assert.equal(card.status, 'partial');
    assert.equal(card.grade, 'INCOMPLETE');
    assert.equal(card.erroredCases, 1);
    assert.equal(card.overallScore, 100);
    assert.equal(card.categories.reasoning.errored, 1);
    assert.equal(card.categories.reasoning.total, 2);
  });

  test('wrong answers still score as a real F rather than an error', async () => {
    const card = await new ModelBenchmarkSuite().runBenchmark(provider(async () => 'nothing useful'));
    assert.equal(card.status, 'complete');
    assert.equal(card.grade, 'F');
    assert.equal(card.overallScore, 0);
  });

  test('tokens/sec uses the backend eval duration when onUsage reports it, not the words estimate', async () => {
    const p = provider(async (prompt, options) => {
      options.onUsage?.({ model: 'qwen3:8b', promptTokens: 100, completionTokens: 50, evalDurationMs: 1000 });
      return answerFor(prompt);
    });
    const card = await new ModelBenchmarkSuite().runBenchmark(p);
    assert.equal(card.tokensPerSecSource, 'backend');
    assert.equal(card.estimatedTokensPerSec, 50);
    assert.equal(card.results[0].completionTokens, 50);
  });

  test('tokens/sec falls back to wall-clock, then to the labelled word estimate', async () => {
    const wall = provider(async (prompt, options) => {
      options.onUsage?.({ model: 'm', promptTokens: 1, completionTokens: 10 });
      await new Promise((r) => setTimeout(r, 2));
      return answerFor(prompt);
    });
    assert.equal((await new ModelBenchmarkSuite().runBenchmark(wall)).tokensPerSecSource, 'wall-clock');
    const est = provider(async (prompt) => {
      await new Promise((r) => setTimeout(r, 2));
      return answerFor(prompt);
    });
    assert.equal((await new ModelBenchmarkSuite().runBenchmark(est)).tokensPerSecSource, 'estimated');
  });

  test('the weighted score honours case weights', async () => {
    const suite = new ModelBenchmarkSuite();
    // coding-01 has weight 5; failing only that case must cost more than failing a weight-3 case.
    const failOnly = async (needle: string): Promise<ModelBenchmarkScorecard> =>
      suite.runBenchmark(provider(async (prompt) => (prompt.toLowerCase().includes(needle) ? 'nope' : answerFor(prompt))));
    const heavy = await failOnly('fibonacci');
    const light = await failOnly('hardware runs');
    assert.ok(heavy.overallScore < light.overallScore);
  });

  test('reasoning inside <think> blocks cannot satisfy a pattern; an unterminated block counts as no answer', async () => {
    const p = provider(async (prompt) => `<think>maybe ${answerFor(prompt)}</think>unsure`);
    assert.equal((await new ModelBenchmarkSuite().runBenchmark(p)).overallScore, 0);
    const truncated = provider(async (prompt) => `<think>${answerFor(prompt)} and more thinking`);
    assert.equal((await new ModelBenchmarkSuite().runBenchmark(truncated)).overallScore, 0);
    const answered = provider(async (prompt) => `<think>hmm</think>${answerFor(prompt)}`);
    assert.equal((await new ModelBenchmarkSuite().runBenchmark(answered)).overallScore, 100);
  });

  test('an abort signal stops the run between cases and marks the card aborted', async () => {
    const controller = new AbortController();
    let calls = 0;
    const p = provider(async (prompt, options) => {
      calls++;
      assert.equal(options.signal, controller.signal);
      if (calls === 2) controller.abort();
      return answerFor(prompt);
    });
    const card = await new ModelBenchmarkSuite().runBenchmark(p, { signal: controller.signal });
    assert.equal(card.status, 'aborted');
    assert.equal(card.grade, 'INCOMPLETE');
    assert.equal(calls, 2);
  });

  test('benchmark requests carry a bounded context, completion cap and timeout', async () => {
    const seen: GenerateOptions[] = [];
    await new ModelBenchmarkSuite().runBenchmark(provider(async (prompt, options) => (seen.push(options), answerFor(prompt))));
    assert.equal(seen[0].contextTokens, 4096);
    assert.equal(seen[0].maxTokens, 768);
    assert.equal(seen[0].timeoutMs, 120_000);
  });

  test('the guard allows one benchmark at a time and runExclusive rejects a concurrent run', async () => {
    const guard = new BenchmarkGuard();
    const release = guard.tryAcquire('a');
    assert.ok(release);
    assert.equal(guard.tryAcquire('b'), null);
    assert.equal(guard.current()?.label, 'a');
    release();
    release();
    assert.equal(guard.isBusy(), false);

    let finish!: () => void;
    const gate = new Promise<void>((r) => (finish = r));
    const slow = provider(async (prompt) => (await gate, answerFor(prompt)), 'slow:1b');
    const suite = new ModelBenchmarkSuite();
    const first = suite.runExclusive(slow, {}, guard);
    await assert.rejects(suite.runExclusive(provider(async () => 'x'), {}, guard), BenchmarkBusyError);
    finish();
    const card = await first;
    assert.equal(card.status, 'complete');
    assert.equal(guard.isBusy(), false);
    assert.equal(benchmarkCache.get('slow:1b')?.overallScore, 100);
    assert.equal(benchmarkCache.get('slow:1b', -1), null, 'stale entries are not served');
  });

  test('onProgress reports each completed case', async () => {
    const seen: number[] = [];
    await new ModelBenchmarkSuite().runBenchmark(provider(async (prompt) => answerFor(prompt)), { onProgress: (done, total) => seen.push(done * 100 + total) });
    assert.equal(seen.length, 10);
    assert.equal(seen[9], 1010);
  });

  test('EvaluationHarness separates provider errors from wrong answers and honours abort', async () => {
    const failing = provider(async () => {
      throw new Error('connection refused');
    });
    const report = await new EvaluationHarness(failing).runAll();
    assert.equal(report.erroredTests, 3);
    assert.equal(report.meetsTarget, false);
    assert.equal(report.results[0].errored, true);

    const controller = new AbortController();
    controller.abort();
    const aborted = await new EvaluationHarness(provider(async () => 'x')).runAll({ signal: controller.signal });
    assert.equal(aborted.aborted, true);
    assert.equal(aborted.totalTests, 0);
  });
});

describe('answers must be answers: echo, refusal, near-miss and non-calls do not pass', () => {
  const echoProvider = (): LLMProvider => ({
    getModel: () => 'echo:1b',
    getBaseUrl: () => '',
    chat: async () => '',
    // The prompt a benchmark case sends ends with the case's own text, so this returns that text and nothing else.
    generate: async (prompt: string) => prompt.slice(prompt.lastIndexOf('User Request:') + 'User Request:'.length).trim(),
  });
  const fixed = (text: string): LLMProvider => ({ getModel: () => 'fixed:1b', getBaseUrl: () => '', chat: async () => '', generate: async () => text });

  test('a model that only repeats the request cannot pass a case', async () => {
    const card = await new ModelBenchmarkSuite().runBenchmark(echoProvider());
    const passed = card.results.filter((r) => r.passed).map((r) => r.id);
    assert.deepEqual(passed, [], `echo passed: ${passed.join(', ')}`);
    assert.equal(card.overallScore, 0);
    assert.equal(card.grade, 'F');
  });

  test('the harness cases cannot be passed by repeating the prompt either', async () => {
    const harness = new EvaluationHarness({ getModel: () => 'echo', getBaseUrl: () => '', chat: async () => '', generate: async (prompt: string) => prompt });
    const report = await harness.runAll();
    assert.equal(report.passedTests, 0);
    assert.ok(report.results.every((r) => r.notes));
  });

  test('a refusal that happens to contain a pattern word does not pass retrieval', async () => {
    const card = await new ModelBenchmarkSuite().runBenchmark(fixed("I don't know, I am unable to help with that program."));
    assert.equal(card.results.find((r) => r.id === 'retrieval-01-hardware')?.passed, false);
    assert.equal(card.overallScore, 0);
  });

  test('11:30 is not 1:30, and a bare tool template is not a tool call', async () => {
    const wrongTime = await new ModelBenchmarkSuite().runBenchmark(fixed('It arrives at 11:30 PM.'));
    assert.equal(wrongTime.results.find((r) => r.id === 'reasoning-01-temporal')?.passed, false);
    const template = await new ModelBenchmarkSuite().runBenchmark(fixed('{"tool": "tool_name", "parameters": {}} {"tool": "searxng_search", "parameters": {"query": "..."}}'));
    assert.equal(template.results.find((r) => r.id === 'tool-01-system-stats')?.passed, false);
    assert.equal(template.results.find((r) => r.id === 'tool-02-search')?.passed, false);
  });

  test('a tool case needs the JSON to parse with the right tool and a real query', async () => {
    const good = await new ModelBenchmarkSuite().runBenchmark(
      fixed('Sure.\n```json\n{"tool": "searxng_search", "parameters": {"query": "Radeon 8060S memory bandwidth"}}\n```\n{"tool": "system_stats", "parameters": {}}')
    );
    assert.equal(good.results.find((r) => r.id === 'tool-02-search')?.passed, true);
    assert.equal(good.results.find((r) => r.id === 'tool-01-system-stats')?.passed, true);
  });

  test('a stub or a prose description of memoization is not an implementation', async () => {
    const stub = await new ModelBenchmarkSuite().runBenchmark(fixed('Write function fibonacci(n: number): number using memoization with a cache.'));
    assert.equal(stub.results.find((r) => r.id === 'coding-01-algorithm')?.passed, false);
  });

  test('the harness strips <think> before matching and rejects a tool-case answer that is only prose', async () => {
    const harness = new EvaluationHarness(fixed('<think>4:00 PM maybe</think>unsure'));
    const reasoning = await harness.runTest({ id: 'r', category: 'reasoning', prompt: 'When?', expectedPattern: /4:00/ });
    assert.equal(reasoning.passed, false);
    const prose = await new EvaluationHarness(fixed('Current system stats and memory look fine.')).runAll();
    assert.equal(prose.results.find((r) => r.testId === 'eval-tool-01')?.passed, false);
  });
});
