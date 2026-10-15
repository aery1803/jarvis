import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EvaluationHarness } from '../src/eval/harness.js';
import {
  ModelBenchmarkSuite,
  BenchmarkGuard,
  BenchmarkBusyError,
  benchmarkCache,
  type ModelBenchmarkScorecard,
} from '../src/eval/benchmark.js';
import type { EvalToolbox } from '../src/eval/graders.js';
import {
  extractCodeBlocks,
  extractFinalAnswer,
  isHonestUnknown,
  parseClockTime,
  parseQuantity,
  stripPromptCopies,
} from '../src/eval/answer-check.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { ToolExecutor } from '../src/tools/executor.js';
import { CognitionEngine } from '../src/agents/cognition.js';
import { MockLLMProvider, HybridProvider, type GenerateOptions, type LLMProvider } from '../src/services/provider.js';

const FIBONACCI = [
  '```ts',
  'function fibonacci(n: number, memo: Map<number, number> = new Map()): number {',
  '  if (n < 2) return n;',
  '  const hit = memo.get(n);',
  '  if (hit !== undefined) return hit;',
  '  const value = fibonacci(n - 1, memo) + fibonacci(n - 2, memo);',
  '  memo.set(n, value);',
  '  return value;',
  '}',
  '```',
].join('\n');
const FIXED_SUM = '```ts\nfunction sum(arr: number[]): number {\n  let total = 0;\n  for (let i = 0; i < arr.length; i++) total += arr[i];\n  return total;\n}\n```\nThe loop ran one index past the end.';
const SECURITY_RULE = 'Agents must never keep API tokens in plain text; every secret has to be held in an AES-256 encrypted vault.';

/** The correct reply for each case, found by the text after the scaffold's `User Request:`. */
const CORRECT: Array<[string, string]> = [
  ['180 miles', 'It leaves at 10:30 and drives 3 hours.\nANSWER: 1:30 PM'],
  ['strix halo', 'Premise 2 puts it in the class that uses unified memory.\nANSWER: Yes'],
  ['task a takes', 'A runs 8 to 9, B 9 to 11, C 11 to 12.\nANSWER: 12:00 PM'],
  ['fibonacci', FIBONACCI],
  ['function has a bug', FIXED_SUM],
  ['security rule', SECURITY_RULE],
  ['how much host memory', '{"tool": "system_stats", "parameters": {}}'],
  ['search the web', '{"tool": "web_search", "parameters": {"query": "Radeon 8060S memory bandwidth"}}'],
  ['host ram does the jarvis', 'The context says 31.65 GB.\nANSWER: 31.65 GB'],
  ['which action tier', 'ANSWER: Tier 2'],
  ['tool calls may jarvis', 'The context never says.\nANSWER: not in the provided context'],
  ['train leaves', 'ANSWER: 4:00 PM'],
  ['system stats and memory', '{"tool": "system_stats", "parameters": {}}'],
];

const userRequest = (prompt: string): string => prompt.slice(prompt.lastIndexOf('User Request:') + 'User Request:'.length).toLowerCase();
const correctFor = (prompt: string): string => CORRECT.find(([key]) => userRequest(prompt).includes(key))?.[1] ?? 'no idea';

function makeToolbox(): EvalToolbox {
  const registry = new ToolRegistry();
  registry.registerBuiltinTools({ searchClient: { searchDetailed: async () => ({ source: 'none', results: [] }) } });
  const executor = new ToolExecutor({ registry, gateway: undefined as never });
  return { registry, parseCalls: (text) => executor.parseModelToolCalls(text) };
}

function provider(behaviour: (prompt: string, options: GenerateOptions) => Promise<string>, model = 'qwen3:8b'): LLMProvider {
  return { getModel: () => model, getBaseUrl: () => '', chat: async () => '', generate: behaviour };
}

/** Answers every case correctly except the ones `override` replaces (keyed like `CORRECT`). */
const answering = (override: Record<string, string> = {}, model = 'qwen3:8b'): LLMProvider =>
  provider(async (prompt) => {
    const request = userRequest(prompt);
    const key = Object.keys(override).find((candidate) => request.includes(candidate));
    return key === undefined ? correctFor(prompt) : override[key];
  }, model);

const newSuite = (): ModelBenchmarkSuite => new ModelBenchmarkSuite({ toolbox: makeToolbox() });
const resultOf = (card: ModelBenchmarkScorecard, id: string) => {
  const found = card.results.find((r) => r.id === id);
  assert.ok(found, `no result for ${id}`);
  return found;
};

describe('Benchmark and harness with a model that answers correctly', () => {
  test('every benchmark case passes, with a reason, latency and token counts on each', async () => {
    const card = await newSuite().runBenchmark(provider(async (prompt, options) => {
      options.onUsage?.({ model: 'qwen3:8b', promptTokens: 200, completionTokens: 50, evalDurationMs: 1000 });
      return correctFor(prompt);
    }));
    assert.equal(card.results.length, 11);
    assert.equal(card.status, 'complete');
    assert.deepEqual(card.results.filter((r) => !r.passed).map((r) => `${r.id}: ${r.reason}`), []);
    assert.equal(card.overallScore, 100);
    assert.equal(card.grade, 'A+');
    assert.equal(card.thinking, 'off');
    for (const category of ['reasoning', 'coding', 'tool_calling', 'retrieval']) assert.equal(card.categories[category].percentage, 100, category);
    assert.ok(card.results.every((r) => r.reason.length > 0 && r.latencyMs >= 0 && r.completionTokens === 50 && r.decodeTokensPerSec === 50));
    assert.ok(card.recommendedLanes.includes('code'));
    assert.match(ModelBenchmarkSuite.formatTerminalReport(card), /PASS\s+reasoning-03-sequencing.*50 t\/s/);
    assert.match(ModelBenchmarkSuite.formatMarkdownReport(card), /Overall Intelligence Score/);
  });

  test('the harness cases pass on correct answers, report per-case speed and group by category', async () => {
    const report = await new EvaluationHarness(
      provider(async (prompt, options) => {
        options.onUsage?.({ model: 'qwen3:8b', promptTokens: 10, completionTokens: 40, evalDurationMs: 500 });
        return correctFor(prompt);
      }),
      { toolbox: makeToolbox() }
    ).runAll();
    assert.equal(report.totalTests, 3);
    assert.equal(report.passedTests, 3);
    assert.equal(report.meetsTarget, true);
    assert.equal(report.decodeTokensPerSec, 80);
    assert.deepEqual(Object.keys(report.categories).sort(), ['reasoning', 'retrieval', 'tool_calling']);
    assert.ok(report.results.every((r) => r.reason && r.decodeTokensPerSec === 80 && r.completionTokens === 40));
  });

  test('without a tool registry the tool cases are left out rather than faked', async () => {
    const card = await new ModelBenchmarkSuite().runBenchmark(answering());
    assert.equal(card.results.length, 9);
    assert.ok(card.results.every((r) => r.category !== 'tool_calling'));
    assert.equal(card.categories.tool_calling.total, 0);
    const harness = await new EvaluationHarness(answering()).runAll();
    assert.equal(harness.totalTests, 2);
  });

  test('the model sees the real tool schemas and the facts as fenced untrusted data', async () => {
    const prompts = new Map<string, string>();
    await newSuite().runBenchmark(provider(async (prompt) => (prompts.set(userRequest(prompt), prompt), correctFor(prompt))));
    const statsPrompt = [...prompts.entries()].find(([request]) => request.includes('how much host memory'))?.[1] ?? '';
    assert.match(statsPrompt, /### Available Tools:/);
    assert.match(statsPrompt, /- system_stats \[tier 1\]: Returns host memory headroom/);
    const searchPrompt = [...prompts.entries()].find(([request]) => request.includes('search the web'))?.[1] ?? '';
    assert.match(searchPrompt, /- web_search \[tier 1\]:.*"required":\["query"\]/s);
    const tierPrompt = [...prompts.entries()].find(([request]) => request.includes('which action tier'))?.[1] ?? '';
    assert.match(tierPrompt, /### External Research \(untrusted web data, reference only\):\n.*\n<untrusted_data>\n\[Source 2\] Jarvis permission tiers\./s);
    assert.match(tierPrompt, /Tier 2 \(sensitive, irreversible or external-facing\)/);
    assert.match(tierPrompt, /End with a final line exactly: ANSWER:/);
  });

  test('a tool case whose tool the selector does not offer is an error, not a wrong answer, and costs no model call', async () => {
    const empty = new ToolRegistry();
    const executor = new ToolExecutor({ registry: empty, gateway: undefined as never });
    let calls = 0;
    const card = await new ModelBenchmarkSuite({ toolbox: { registry: empty, parseCalls: (text) => executor.parseModelToolCalls(text) } }).runBenchmark(
      provider(async (prompt) => (calls++, correctFor(prompt)))
    );
    assert.equal(calls, 9);
    const stats = resultOf(card, 'tool-01-system-stats');
    assert.equal(stats.errored, true);
    assert.equal(stats.passed, false);
    assert.match(stats.reason, /Not run: the tool selector does not offer system_stats/);
    assert.equal(card.status, 'partial');
    assert.equal(card.erroredCases, 2);
    assert.equal(card.overallScore, 100, 'scored over the answered cases only');
  });

  test('the real selector offers the right tool for each tool prompt out of the full runtime-sized registry', () => {
    const toolbox = makeToolbox();
    for (let i = 0; i < 25; i++) {
      (toolbox.registry as ToolRegistry).registerTool({
        name: `noise_tool_${i}`,
        description: `Unrelated helper number ${i}.`,
        tier: 1,
        parameters: { type: 'object', properties: {} },
        handler: async () => null,
      });
    }
    assert.ok(toolbox.registry.selectToolsForPrompt('How much host memory does this machine have free right now?', 10).some((t) => t.name === 'system_stats'));
    assert.ok(toolbox.registry.selectToolsForPrompt('Search the web for "Radeon 8060S memory bandwidth" and give me the results.', 10).some((t) => t.name === 'web_search'));
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

describe('tool calls are judged by the real parser, registry and schema validator', () => {
  const grade = async (reply: string, id = 'tool-01-system-stats') => resultOf(await newSuite().runBenchmark(answering({ 'how much host memory': reply, 'search the web': reply })), id);

  test('names the model invented in the live run fail as unregistered, with the name in the reason', async () => {
    for (const invented of ['check_host_memory', 'check_system_host_memory']) {
      const result = await grade(`{"tool": "${invented}", "parameters": {}}`);
      assert.equal(result.passed, false);
      assert.match(result.reason, new RegExp(`'${invented}' is not a registered tool`));
    }
    const search = await grade('{"tool": "searxng_search", "parameters": {"query": "Radeon 8060S memory bandwidth"}}', 'tool-02-search');
    assert.equal(search.passed, false);
    assert.match(search.reason, /'searxng_search' is not a registered tool/);
  });

  test('a registered tool with schema-invalid arguments fails with the validator message', async () => {
    const missing = await grade('{"tool": "web_search", "parameters": {}}', 'tool-02-search');
    assert.match(missing.reason, /web_search arguments are invalid: query is required/);
    const unknownProperty = await grade('{"tool": "system_stats", "parameters": {"verbose": true}}');
    assert.match(unknownProperty.reason, /verbose is not a known property/);
    const badType = await grade('{"tool": "web_search", "parameters": {"query": "Radeon 8060S memory bandwidth", "maxResults": "ten"}}', 'tool-02-search');
    assert.match(badType.reason, /maxResults must be an integer/);
  });

  test('the wrong registered tool, an off-topic query, prose and the prompt template do not pass', async () => {
    assert.match((await grade('{"tool": "file_read", "parameters": {"filePath": "README.md"}}')).reason, /called file_read, but the task needs system_stats/);
    assert.match((await grade('{"tool": "web_search", "parameters": {"query": "weather in Paris"}}', 'tool-02-search')).reason, /not about the Radeon 8060S memory bandwidth/);
    assert.match((await grade('I would check the memory with the stats tool.')).reason, /no parseable tool call/);
    assert.equal((await grade('{"tool": "<name>", "parameters": {...}}')).passed, false);
  });

  test('a valid call passes, bare or fenced', async () => {
    assert.equal((await grade('```json\n{"tool": "system_stats", "parameters": {}}\n```')).passed, true);
    const search = await grade('Sure. {"tool": "web_search", "parameters": {"query": "Radeon 8060S memory bandwidth GB/s", "maxResults": 5}}', 'tool-02-search');
    assert.equal(search.passed, true);
    assert.match(search.reason, /valid web_search call/);
  });
});

describe('retrieval is grounded in supplied facts, and honesty is graded', () => {
  const grade = async (request: string, reply: string, id: string) => resultOf(await newSuite().runBenchmark(answering({ [request]: reply })), id);

  test('the hallucinated Read/Execute/Admin tiers fail; Tier 2 passes; naming several tiers fails', async () => {
    const invented = await grade('which action tier', 'The tiers are Read, Execute and Admin.\nANSWER: Execute', 'retrieval-02-security');
    assert.equal(invented.passed, false);
    assert.match(invented.reason, /not exactly one tier/);
    assert.equal((await grade('which action tier', 'ANSWER: Tier 3', 'retrieval-02-security')).passed, false);
    assert.equal((await grade('which action tier', 'ANSWER: Tier 2 and Tier 3', 'retrieval-02-security')).passed, false);
    assert.equal((await grade('which action tier', 'ANSWER: **Tier 2** (sensitive actions)', 'retrieval-02-security')).passed, true);
  });

  test('the host RAM answer must be the context figure with the right unit, not the 64 GB in the system prompt', async () => {
    assert.equal((await grade('host ram does the jarvis', 'ANSWER: 64 GB', 'retrieval-01-hardware')).passed, false);
    assert.equal((await grade('host ram does the jarvis', 'ANSWER: 31.65 MB', 'retrieval-01-hardware')).passed, false);
    assert.equal((await grade('host ram does the jarvis', 'It is 31.65 GB, though earlier it said 64 GB.', 'retrieval-01-hardware')).reason, 'no final answer line');
    assert.equal((await grade('host ram does the jarvis', 'ANSWER: 31.65', 'retrieval-01-hardware')).passed, true);
  });

  test('when the context lacks the answer, only an honest "not in the context" passes; an invented value or a hedge does not', async () => {
    for (const honest of ['ANSWER: Not in the provided context', "ANSWER: I don't know", 'ANSWER: The context does not say.']) {
      assert.equal((await grade('tool calls may jarvis', honest, 'retrieval-03-honesty')).passed, true, honest);
    }
    for (const invented of ['ANSWER: 5', 'ANSWER: Three tool calls', 'ANSWER: not stated, but probably 5']) {
      const result = await grade('tool calls may jarvis', invented, 'retrieval-03-honesty');
      assert.equal(result.passed, false, invented);
    }
    assert.match((await grade('tool calls may jarvis', 'ANSWER: 5', 'retrieval-03-honesty')).reason, /invented an answer/);
  });
});

describe('reasoning is graded on one committed final answer', () => {
  const keyFor: Record<string, string> = { 'reasoning-01-temporal': '180 miles', 'reasoning-02-deduction': 'strix halo', 'reasoning-03-sequencing': 'task a takes' };
  const grade = async (reply: string, id = 'reasoning-03-sequencing') => resultOf(await newSuite().runBenchmark(answering({ [keyFor[id]]: reply })), id);

  test('the live-run failure: 11:00 AM as the final answer fails even though 12:00 appears in the working', async () => {
    const result = await grade('A is 8:00 to 9:00. B runs 9:00 to 11:00 and C ends at 12:00 if nothing slips.\nTask C is completed at **11:00 AM**\nANSWER: 11:00 AM');
    assert.equal(result.passed, false);
    assert.match(result.reason, /final answer "11:00 AM": expected 12:00 PM/);
  });

  test('a correct number in the prose without an ANSWER line fails with "no final answer line"', async () => {
    const result = await grade('The answer is 12:00 PM, which is noon.');
    assert.equal(result.passed, false);
    assert.equal(result.reason, 'no final answer line');
  });

  test('12:00 PM, noon, 12 pm, 24-hour times and bold formatting are the same answer; ambiguous or compound ones are not', async () => {
    for (const ok of ['ANSWER: 12:00 PM', 'ANSWER: noon', '**ANSWER:** 12 pm', 'answer: 12:00 p.m.', 'ANSWER: At 12:00 PM.', 'ANSWER: 12:00 PM (noon)']) {
      assert.equal((await grade(`work\n${ok}`)).passed, true, ok);
    }
    for (const bad of ['ANSWER: 12:00', 'ANSWER: 12:00 AM', 'ANSWER: 11:00 AM (not 12:00 PM)', 'ANSWER: 12:00 PM or 1:00 PM', 'ANSWER: <a clock time such as 3:45 PM>', 'ANSWER: 3:45 PM']) {
      assert.equal((await grade(`work\n${bad}`)).passed, false, bad);
    }
    assert.equal((await grade('ANSWER: 13:30', 'reasoning-01-temporal')).passed, true);
    assert.equal((await grade('ANSWER: 1:30', 'reasoning-01-temporal')).passed, false, 'no am/pm on a 12-hour time is ambiguous');
    assert.equal((await grade('ANSWER: 11:30 PM', 'reasoning-01-temporal')).passed, false);
  });

  test('the last ANSWER line wins, and Yes/No is compared exactly', async () => {
    assert.equal((await grade('ANSWER: 11:00 AM\nOn reflection:\nANSWER: 12:00 PM')).passed, true);
    assert.equal((await grade('ANSWER: 12:00 PM\nWait, no.\nANSWER: 11:00 AM')).passed, false);
    assert.equal((await grade('ANSWER: Yes.', 'reasoning-02-deduction')).passed, true);
    assert.equal((await grade('ANSWER: Yes or No', 'reasoning-02-deduction')).passed, false);
    assert.equal((await grade('ANSWER: No', 'reasoning-02-deduction')).passed, false);
    assert.equal((await grade('Yes, it does.', 'reasoning-02-deduction')).reason, 'no final answer line');
  });

  test('a reply cut off at the completion cap before its final line says so', async () => {
    const card = await newSuite().runBenchmark(provider(async (prompt, options) => {
      options.onUsage?.({ model: 'qwen3:8b', promptTokens: 1, completionTokens: 768, truncated: true });
      return userRequest(prompt).includes('task a takes') ? 'Let me think step by step. Task A starts at 8:00 and' : correctFor(prompt);
    }));
    assert.equal(resultOf(card, 'reasoning-03-sequencing').reason, 'no final answer line (the reply was cut off at the completion cap)');
  });
});

describe('coding answers are run, not pattern-matched', () => {
  const grade = async (reply: string, id: string, key = id === 'coding-01-algorithm' ? 'fibonacci' : 'function has a bug') =>
    resultOf(await newSuite().runBenchmark(answering({ [key]: reply })), id);

  test('a memoized fibonacci with TypeScript types passes; an iterative one too', async () => {
    assert.equal((await grade(FIBONACCI, 'coding-01-algorithm')).passed, true);
    const iterative = '```typescript\nexport function fibonacci(n: number): number {\n  let a = 0, b = 1;\n  for (let i = 0; i < n; i++) [a, b] = [b, a + b];\n  return a;\n}\n```';
    assert.equal((await grade(iterative, 'coding-01-algorithm')).passed, true);
  });

  test('naive recursion cannot reach fibonacci(50) in the sandbox limit, so words about memoization do not save it', async () => {
    const naive = '```ts\n// memo cache memoization\nfunction fibonacci(n: number): number { return n < 2 ? n : fibonacci(n - 1) + fibonacci(n - 2); }\n```';
    const result = await grade(naive, 'coding-01-algorithm');
    assert.equal(result.passed, false);
    assert.match(result.reason, /the code did not run/);
  });

  test('echoing the prompt, prose, a wrong implementation and a missing or unterminated block all fail', async () => {
    const echoed = 'Write a TypeScript function fibonacci(n: number): number that uses memoization to compute the nth Fibonacci number efficiently.';
    assert.match((await grade(echoed, 'coding-01-algorithm')).reason, /no complete code block/);
    assert.match((await grade('```ts\nfunction fibonacci(n: number): number { return n < 2 ? n : fibonacci(n - 1) + fibonacci(n - 2);', 'coding-01-algorithm')).reason, /no complete code block/);
    const wrong = await grade('```ts\nfunction fibonacci(n: number): number { return n; }\n```', 'coding-01-algorithm');
    assert.match(wrong.reason, /returned wrong results \(fibonacci\(10\) returned 10, expected 55\)/);
    const wrongName = await grade('```ts\nfunction fib(n: number): number { return n; }\n```', 'coding-01-algorithm');
    assert.match(wrongName.reason, /no complete code block that defines fibonacci/);
  });

  test('the debugging case runs the fixed function: the original bug (NaN) and a half fix fail, any correct fix passes', async () => {
    const buggy = '```ts\nfunction sum(arr: number[]): number {\n  let total = 0;\n  for (let i = 0; i <= arr.length; i++) {\n    total += arr[i];\n  }\n  return total;\n}\n```\nThe bug is an off-by-one.';
    const original = await grade(buggy, 'coding-02-debugging');
    assert.equal(original.passed, false);
    assert.match(original.reason, /returned null, expected 6/);
    const reduce = '```js\nconst sum = (arr) => arr.reduce((total, n) => total + n, 0);\n```';
    assert.equal((await grade(reduce, 'coding-02-debugging')).passed, true);
    const forOf = '```ts\nfunction sum(arr: number[]): number { let t = 0; for (const n of arr) t += n; return t; }\n```';
    assert.equal((await grade(forOf, 'coding-02-debugging')).passed, true);
    assert.equal((await grade('Change `<=` to `<`.', 'coding-02-debugging')).passed, false);
  });

  test('the security rule needs every concept in the model\'s own words; the prompt repeated back or a partial rule fails', async () => {
    const rule = (reply: string) => grade(reply, 'coding-03-self-improvement', 'security rule');
    assert.equal((await rule(SECURITY_RULE)).passed, true);
    const echoed = 'Facts to cover: sensitive API tokens; stored in an AES-256 encrypted vault; plain text not allowed.';
    const echo = await rule(echoed);
    assert.equal(echo.passed, false);
    assert.match(echo.reason, /missing in the model's own words/);
    const partial = await rule('Tokens must be encrypted before they are written anywhere.');
    assert.match(partial.reason, /a vault, plain text/);
    assert.equal((await rule("I'm sorry, I cannot help with that security rule.")).passed, false);
  });
});

describe('latency and speed are reported, never graded', () => {
  test('a correct but slow answer passes in the benchmark and the harness, with the latency recorded', async () => {
    mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
    try {
      const slow = provider(async (prompt, options) => {
        mock.timers.tick(45_000);
        options.onUsage?.({ model: 'qwen3:8b', promptTokens: 100, completionTokens: 600, evalDurationMs: 40_000 });
        return correctFor(prompt);
      });
      const card = await newSuite().runBenchmark(slow);
      assert.equal(card.overallScore, 100);
      assert.ok(card.results.every((r) => r.passed && r.latencyMs === 45_000 && r.decodeTokensPerSec === 15));
      assert.equal(card.avgLatencyMs, 45_000);
      const report = await new EvaluationHarness(slow, { toolbox: makeToolbox() }).runAll();
      assert.equal(report.accuracyRate, 1);
      assert.equal(report.meetsTarget, true);
      assert.equal(report.avgLatencyMs, 45_000);
      assert.ok(report.results.every((r) => r.latencyMs === 45_000 && !r.notes));
    } finally {
      mock.timers.reset();
    }
  });
});

describe('ModelBenchmarkSuite honesty and controls', () => {
  test('a model that errors on every case (HTTP 404) is reported as ERROR, not as 0% grade F', async () => {
    const p = provider(async () => {
      throw new Error('Ollama error 404: model "qwen2.5:7b" not found');
    }, 'qwen2.5:7b');
    const card = await newSuite().runBenchmark(p);
    assert.equal(card.status, 'error');
    assert.equal(card.grade, 'ERROR');
    assert.match(card.error ?? '', /404/);
    assert.equal(card.answeredCases, 0);
    assert.equal(card.erroredCases, 11);
    assert.ok(card.results.every((r) => r.errored && !r.passed && /^Failed: .*404/.test(r.reason)));
    assert.deepEqual(card.recommendedLanes, []);
    assert.match(ModelBenchmarkSuite.formatMarkdownReport(card), /ERROR/);
    assert.ok(!/Overall Intelligence Score/.test(ModelBenchmarkSuite.formatMarkdownReport(card)));
    assert.match(ModelBenchmarkSuite.formatTerminalReport(card), /ERROR - the model could not be benchmarked/);
  });

  test('one case that errors is reported as error, not fail; the card is partial and scored over the answered cases', async () => {
    let n = 0;
    const card = await newSuite().runBenchmark(provider(async (prompt) => {
      if (n++ === 0) throw new Error('timeout');
      return correctFor(prompt);
    }));
    assert.equal(card.status, 'partial');
    assert.equal(card.grade, 'INCOMPLETE');
    assert.equal(card.erroredCases, 1);
    assert.equal(card.overallScore, 100);
    const first = card.results[0];
    assert.equal(first.errored, true);
    assert.equal(first.passed, false);
    assert.equal(first.reason, 'Failed: timeout');
    assert.equal(card.categories.reasoning.errored, 1);
    assert.equal(card.categories.reasoning.total, 2);
    assert.match(ModelBenchmarkSuite.formatTerminalReport(card), /ERROR\s+reasoning-01-temporal/);
  });

  test('wrong answers still score as a real F rather than an error', async () => {
    const card = await newSuite().runBenchmark(provider(async () => 'nothing useful'));
    assert.equal(card.status, 'complete');
    assert.equal(card.grade, 'F');
    assert.equal(card.overallScore, 0);
    assert.ok(card.results.every((r) => !r.errored && !r.passed && r.notes === r.reason));
  });

  test('the score is passed / answered, unweighted, with the usual grade bands', async () => {
    // Failing 1 of 11 is 91% (A); failing 3 of 11 is 73% (B).
    const one = await newSuite().runBenchmark(answering({ 'which action tier': 'ANSWER: Tier 3' }));
    assert.equal(one.overallScore, 91);
    assert.equal(one.grade, 'A');
    const three = await newSuite().runBenchmark(answering({ 'which action tier': 'ANSWER: Tier 3', 'strix halo': 'ANSWER: No', 'task a takes': 'ANSWER: 11:00 AM' }));
    assert.equal(three.overallScore, 73);
    assert.equal(three.grade, 'B');
    assert.equal(three.categories.reasoning.percentage, 33);
    assert.equal(three.categories.retrieval.percentage, 67);
  });

  test('tokens/sec uses the backend eval duration when onUsage reports it, not the words estimate', async () => {
    const p = provider(async (prompt, options) => {
      options.onUsage?.({ model: 'qwen3:8b', promptTokens: 100, completionTokens: 50, evalDurationMs: 1000 });
      return correctFor(prompt);
    });
    const card = await newSuite().runBenchmark(p);
    assert.equal(card.tokensPerSecSource, 'backend');
    assert.equal(card.estimatedTokensPerSec, 50);
    assert.equal(card.results[0].completionTokens, 50);
  });

  test('no backend timings means no speed is claimed (no wall-clock or word-count guess)', async () => {
    const wall = provider(async (prompt, options) => {
      options.onUsage?.({ model: 'm', promptTokens: 1, completionTokens: 10 });
      await new Promise((r) => setImmediate(r));
      return correctFor(prompt);
    });
    const card = await newSuite().runBenchmark(wall);
    assert.equal(card.tokensPerSecSource, 'none');
    assert.equal(card.decodeTokensPerSec, 0);
    assert.ok(card.results.every((r) => r.decodeTokensPerSec === undefined));
    const bare = await newSuite().runBenchmark(provider(async (prompt) => correctFor(prompt)));
    assert.equal(bare.tokensPerSecSource, 'none');
    assert.match(ModelBenchmarkSuite.formatMarkdownReport(bare), /decode speed n\/a/);
  });

  test('decode speed comes from eval_duration only: the first call\'s model load never lowers it', async () => {
    let call = 0;
    const p = provider(async (prompt, options) => {
      const first = call++ === 0;
      options.onUsage?.({
        model: 'qwen3:8b',
        promptTokens: 100,
        completionTokens: 40,
        evalDurationMs: 500,
        promptEvalDurationMs: 50,
        loadDurationMs: first ? 9000 : 10,
        totalDurationMs: first ? 9600 : 600,
      });
      return correctFor(prompt);
    });
    const card = await newSuite().runBenchmark(p);
    assert.equal(card.tokensPerSecSource, 'backend');
    assert.equal(card.decodeTokensPerSec, 80, '40 tokens in 500 ms on every case');
    assert.equal(card.results[0].loadMs, 9000);
    assert.equal(card.results[0].promptEvalMs, 50);
    // (9000 + 10 * 10) / 11 cases
    assert.equal(card.avgLoadMs, 827);
    assert.ok(card.avgWarmLatencyMs <= card.avgLatencyMs);
    assert.match(ModelBenchmarkSuite.formatTerminalReport(card), /Decode Speed\s+: 80 tokens\/sec/);
    assert.match(ModelBenchmarkSuite.formatTerminalReport(card), /Average Load\s+: 827 ms/);
  });

  test('cases that report no eval_duration are left out of the decode figure instead of counting as zero', async () => {
    let call = 0;
    const p = provider(async (prompt, options) => {
      options.onUsage?.(call++ === 0 ? { model: 'm', promptTokens: 1, completionTokens: 30, evalDurationMs: 1000 } : { model: 'm', promptTokens: 1, completionTokens: 500 });
      return correctFor(prompt);
    });
    const card = await newSuite().runBenchmark(p);
    assert.equal(card.decodeTokensPerSec, 30);
  });

  test('thinking: qwen3 gets think:false by default, a lifted cap for a model left to think, and every case has at least 768 tokens', async () => {
    const seen: GenerateOptions[] = [];
    const record = (model: string) => provider(async (prompt, options) => (seen.push(options), correctFor(prompt)), model);
    await newSuite().runBenchmark(record('qwen3:8b'));
    assert.ok(seen.every((o) => o.think === false));
    assert.ok(seen.every((o) => o.maxTokens === 768));

    seen.length = 0;
    const card = await newSuite().runBenchmark(record('llama3.2:3b'));
    assert.ok(seen.every((o) => o.think === undefined));
    assert.ok(seen.every((o) => o.maxTokens === 2048), 'a model left on its default gets room to finish any reasoning');
    assert.equal(card.thinking, 'model default');

    seen.length = 0;
    await new ModelBenchmarkSuite({ thinkingMode: 'on', toolbox: makeToolbox() }).runBenchmark(record('qwen3:8b'));
    assert.ok(seen.every((o) => o.think === true));

    seen.length = 0;
    await new ModelBenchmarkSuite({ thinkingMode: 'auto', toolbox: makeToolbox() }).runBenchmark(record('qwen3:8b'));
    assert.ok(seen.every((o) => o.think === undefined));

    seen.length = 0;
    await newSuite().runBenchmark(record('qwen3:8b'), { maxTokens: 100 });
    assert.ok(seen.every((o) => (o.maxTokens ?? 0) >= 768), 'a caller cannot starve a case below 768 tokens');
  });

  test('the eval harness sends think:false to qwen3 and nothing to a non-reasoning model, with at least 768 tokens', async () => {
    const seen: GenerateOptions[] = [];
    const p = (model: string) => provider(async (prompt, options) => (seen.push(options), correctFor(prompt)), model);
    await new EvaluationHarness(p('qwen3:8b'), { toolbox: makeToolbox() }).runAll();
    assert.equal(seen.length, 3);
    assert.ok(seen.every((o) => o.think === false && (o.maxTokens ?? 0) >= 768));
    seen.length = 0;
    await new EvaluationHarness(p('mistral:7b'), { toolbox: makeToolbox() }).runAll();
    assert.ok(seen.every((o) => o.think === undefined));
    seen.length = 0;
    await new EvaluationHarness(p('qwen3:8b'), { thinkingMode: 'on', toolbox: makeToolbox() }).runAll();
    assert.ok(seen.every((o) => o.think === true));
  });

  test('reasoning inside <think> blocks cannot satisfy a case; an unterminated block counts as no answer', async () => {
    const hidden = provider(async (prompt) => `<think>maybe ${correctFor(prompt)}</think>unsure`);
    assert.equal((await newSuite().runBenchmark(hidden)).overallScore, 0);
    const truncated = await newSuite().runBenchmark(provider(async (prompt) => `<think>${correctFor(prompt)} and more thinking`));
    assert.equal(truncated.overallScore, 0);
    assert.match(truncated.results[0].reason, /cut off while thinking/);
    const answered = provider(async (prompt) => `<think>hmm</think>${correctFor(prompt)}`);
    assert.equal((await newSuite().runBenchmark(answered)).overallScore, 100);
  });

  test('an abort signal stops the run between cases and marks the card aborted', async () => {
    const controller = new AbortController();
    let calls = 0;
    const p = provider(async (prompt, options) => {
      calls++;
      assert.equal(options.signal, controller.signal);
      if (calls === 2) controller.abort();
      return correctFor(prompt);
    });
    const card = await newSuite().runBenchmark(p, { signal: controller.signal });
    assert.equal(card.status, 'aborted');
    assert.equal(card.grade, 'INCOMPLETE');
    assert.equal(calls, 2);
  });

  test('a failure caused by an abort is not recorded as an errored case', async () => {
    const controller = new AbortController();
    const p = provider(async () => {
      controller.abort();
      throw new Error('This operation was aborted');
    });
    const card = await newSuite().runBenchmark(p, { signal: controller.signal });
    assert.equal(card.status, 'aborted');
    assert.equal(card.results.length, 0);
  });

  test('benchmark requests carry a bounded context, completion cap and timeout', async () => {
    const seen: GenerateOptions[] = [];
    await newSuite().runBenchmark(provider(async (prompt, options) => (seen.push(options), correctFor(prompt))));
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
    const slow = provider(async (prompt) => (await gate, correctFor(prompt)), 'slow:1b');
    const suite = newSuite();
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
    await newSuite().runBenchmark(provider(async (prompt) => correctFor(prompt)), { onProgress: (done, total) => seen.push(done * 100 + total) });
    assert.equal(seen.length, 11);
    assert.equal(seen[10], 1111);
  });

  test('EvaluationHarness separates provider errors from wrong answers and honours abort', async () => {
    const failing = provider(async () => {
      throw new Error('connection refused');
    });
    const report = await new EvaluationHarness(failing, { toolbox: makeToolbox() }).runAll();
    assert.equal(report.erroredTests, 3);
    assert.equal(report.meetsTarget, false);
    assert.equal(report.results[0].errored, true);
    assert.match(report.results[0].reason, /connection refused/);
    assert.equal(report.categories.reasoning.errored, 1);

    const controller = new AbortController();
    controller.abort();
    const aborted = await new EvaluationHarness(provider(async () => 'x')).runAll({ signal: controller.signal });
    assert.equal(aborted.aborted, true);
    assert.equal(aborted.totalTests, 0);
  });

  test('a wrong harness answer fails that case with its reason and keeps the run below target', async () => {
    const report = await new EvaluationHarness(answering({ 'system stats and memory': 'I would call the stats tool.' }), { toolbox: makeToolbox() }).runAll();
    assert.deepEqual(report.results.map((r) => r.passed), [true, false, true]);
    assert.equal(report.accuracyRate, 0.67);
    assert.equal(report.meetsTarget, false);
    assert.equal(report.results[1].notes, 'no parseable tool call in the reply');
  });
});

describe('answers must be answers: echo, refusal and templates do not pass', () => {
  const echoProvider = (): LLMProvider => ({
    getModel: () => 'echo:1b',
    getBaseUrl: () => '',
    chat: async () => '',
    // The prompt a benchmark case sends ends with the case's own text, so this returns that text and nothing else.
    generate: async (prompt: string) => prompt.slice(prompt.lastIndexOf('User Request:') + 'User Request:'.length).trim(),
  });
  const fixed = (text: string): LLMProvider => ({ getModel: () => 'fixed:1b', getBaseUrl: () => '', chat: async () => '', generate: async () => text });

  test('a model that only repeats the request cannot pass a case', async () => {
    const card = await newSuite().runBenchmark(echoProvider());
    const passed = card.results.filter((r) => r.passed).map((r) => r.id);
    assert.deepEqual(passed, [], `echo passed: ${passed.join(', ')}`);
    assert.equal(card.overallScore, 0);
    assert.equal(card.grade, 'F');
  });

  test('the harness cases cannot be passed by repeating the prompt either', async () => {
    const harness = new EvaluationHarness({ getModel: () => 'echo', getBaseUrl: () => '', chat: async () => '', generate: async (prompt: string) => prompt }, { toolbox: makeToolbox() });
    const report = await harness.runAll();
    assert.equal(report.passedTests, 0);
    assert.ok(report.results.every((r) => r.notes));
  });

  test('a model that repeats the final-answer template, or always says the same thing, passes nothing it should not', async () => {
    const template = await newSuite().runBenchmark(fixed('ANSWER: <a clock time such as 3:45 PM>'));
    assert.equal(template.overallScore, 0);
    const always = await newSuite().runBenchmark(fixed('ANSWER: Yes'));
    assert.deepEqual(always.results.filter((r) => r.passed).map((r) => r.id), ['reasoning-02-deduction']);
  });

  test('a refusal that happens to contain a keyword does not pass', async () => {
    const card = await newSuite().runBenchmark(fixed("I don't know, I am unable to help with that program."));
    assert.equal(card.overallScore, 0);
  });

  test('the harness strips <think> before grading', async () => {
    const report = await new EvaluationHarness(fixed('<think>ANSWER: 4:00 PM</think>unsure')).runAll();
    assert.equal(report.results[0].passed, false);
    assert.equal(report.results[0].reason, 'no final answer line');
  });
});

describe('answer-check helpers', () => {
  test('extractFinalAnswer reads the last ANSWER line and forgives markdown, not a missing label', () => {
    assert.equal(extractFinalAnswer('working\nANSWER: 42'), '42');
    assert.equal(extractFinalAnswer('**ANSWER:** `42`'), '42');
    assert.equal(extractFinalAnswer('- answer : forty two\r\n'), 'forty two');
    assert.equal(extractFinalAnswer('ANSWER: 1\nANSWER: 2'), '2');
    assert.equal(extractFinalAnswer('The answer: 42'), null, 'the label must start the line');
    assert.equal(extractFinalAnswer('ANSWER:\n'), null);
    assert.equal(extractFinalAnswer(''), null);
  });

  test('parseClockTime is strict about what is a single, unambiguous time', () => {
    assert.equal(parseClockTime('12:00 PM'), 720);
    assert.equal(parseClockTime('12:00 AM'), 0);
    assert.equal(parseClockTime('noon'), 720);
    assert.equal(parseClockTime('midnight'), 0);
    assert.equal(parseClockTime('4 pm'), 960);
    assert.equal(parseClockTime('4:05pm'), 965);
    assert.equal(parseClockTime('16:00'), 960);
    assert.equal(parseClockTime('1:30 P.M.'), 810);
    for (const bad of ['12:00', '4', '25:00', '4:75 PM', '13:00 PM', '4:00 PM or 5:00 PM', 'about four', '']) assert.equal(parseClockTime(bad), null, bad);
  });

  test('parseQuantity reads one number with an optional unit and nothing more', () => {
    assert.deepEqual(parseQuantity('31.65 GB'), { value: 31.65, unit: 'gb' });
    assert.deepEqual(parseQuantity('**1,200**'), { value: 1200, unit: null });
    assert.deepEqual(parseQuantity('3 hours.'), { value: 3, unit: 'hour' });
    assert.equal(parseQuantity('about 3'), null);
    assert.equal(parseQuantity('3 or 4'), null);
  });

  test('isHonestUnknown accepts a plain "not in the context" and rejects an invented or hedged number', () => {
    for (const honest of ['not in the provided context', "I don't know", 'unknown', 'The context does not specify this', 'cannot be determined from the context']) assert.equal(isHonestUnknown(honest), true, honest);
    for (const bad of ['5', 'probably around 5, not stated', 'Tier 2', 'three']) assert.equal(isHonestUnknown(bad), false, bad);
  });

  test('stripPromptCopies removes runs of copied words but keeps the model\'s own', () => {
    const prompt = 'Facts to cover: sensitive API tokens; stored in an AES-256 encrypted vault; plain text not allowed.';
    assert.equal(stripPromptCopies('Facts to cover: sensitive API tokens; stored in an AES-256 encrypted vault; plain text not allowed.', prompt, 8), '');
    assert.equal(stripPromptCopies('Never keep tokens in plain text.', prompt, 8), 'never keep tokens in plain text');
  });

  test('extractCodeBlocks returns only complete fenced blocks', () => {
    assert.deepEqual(extractCodeBlocks('a\n```ts\nlet x = 1;\n```\nb\n```\nlet y;\n```'), ['let x = 1;\n', 'let y;\n']);
    assert.deepEqual(extractCodeBlocks('```ts\nlet x = 1;'), []);
  });
});

