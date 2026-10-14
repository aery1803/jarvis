/**
 * Jarvis Local AI Agent: Comprehensive Model Benchmark Suite
 * Evaluates local and remote LLMs across Reasoning, Coding, Tool Calling, and Retrieval.
 */

import type { GenerationUsage, LLMProvider } from '../services/provider.js';
import { CognitionEngine } from '../agents/cognition.js';
import { resolveThink, type ThinkingMode } from '../services/thinking-control.js';
import { findToolCall, isPromptEcho, isRefusal, stripThinking } from './answer-check.js';
import os from 'node:os';

export interface BenchmarkCase {
  id: string;
  category: 'reasoning' | 'coding' | 'tool_calling' | 'retrieval';
  title: string;
  prompt: string;
  /** Anchor it to the answer: a pattern that also matches the prompt's own words passes on an echo. */
  expectedPattern: RegExp | string;
  /** An extra check on the answer (parse the emitted JSON, check the code's structure). Both must hold. */
  verify?: (output: string) => boolean;
  weight: number; // 1 to 5
}

export interface BenchmarkCaseResult {
  id: string;
  category: string;
  title: string;
  passed: boolean;
  /** True when the model could not be queried at all (HTTP error, network, timeout). Not a wrong answer. */
  errored?: boolean;
  score: number; // 0.0 to 1.0
  latencyMs: number;
  outputPreview: string;
  notes?: string;
  promptTokens?: number;
  completionTokens?: number;
  /** Backend-reported decode time (`eval_duration`), when available. */
  evalDurationMs?: number;
  /** Backend-reported model load time (`load_duration`); large only on the call that loaded the model. */
  loadMs?: number;
  /** Backend-reported prompt evaluation time (`prompt_eval_duration`). */
  promptEvalMs?: number;
}

export interface CategorySummary {
  category: string;
  passed: number;
  /** Cases that got an answer from the model; errored cases are excluded. */
  total: number;
  errored?: number;
  percentage: number;
  avgLatencyMs: number;
}

export type BenchmarkGrade = 'A+' | 'A' | 'B+' | 'B' | 'C' | 'F' | 'ERROR' | 'INCOMPLETE';

/**
 * `complete`: every case got an answer. `partial`: some cases could not be run. `error`: no case could be run
 * (for example the model returned HTTP 404), so there is no score. `aborted`: stopped by the caller.
 */
export type BenchmarkStatus = 'complete' | 'partial' | 'error' | 'aborted';

/** `backend`: computed from Ollama's own counters. `none`: the backend reported none, so no speed is claimed. */
export type TokensPerSecSource = 'backend' | 'none';

export interface ModelBenchmarkScorecard {
  modelName: string;
  status: BenchmarkStatus;
  /** Why the benchmark could not run (first failure message). Set when status is `error`, `partial` or `aborted`. */
  error?: string;
  /** Weighted score over answered cases, 0 to 100. Meaningless when status is `error`; check `status` / `grade` first. */
  overallScore: number;
  grade: BenchmarkGrade;
  answeredCases: number;
  erroredCases: number;
  totalLatencyMs: number;
  /** End-to-end mean per case, including model load, prompt evaluation and any thinking. */
  avgLatencyMs: number;
  /** Mean per case with the backend-reported load time taken out, so the first call's model load does not count. */
  avgWarmLatencyMs: number;
  /** Mean `load_duration` over cases that reported one; 0 when none did. */
  avgLoadMs: number;
  /** Decode speed: total completion tokens / total `eval_duration` (excludes load and prompt evaluation). 0 when `tokensPerSecSource` is `none`. */
  decodeTokensPerSec: number;
  /** Same value as `decodeTokensPerSec`, kept under its original name for older readers. */
  estimatedTokensPerSec: number;
  tokensPerSecSource: TokensPerSecSource;
  categories: Record<string, CategorySummary>;
  results: BenchmarkCaseResult[];
  recommendedLanes: string[];
  timestamp: string;
  systemSpecs: {
    platform: string;
    freeMemoryGB: number;
    totalMemoryGB: number;
  };
}

export interface BenchmarkRunOptions {
  signal?: AbortSignal;
  /** Completion cap per case (default 768; thinking models need room to finish reasoning). */
  maxTokens?: number;
  /** Context window requested per case (default 4096; the benchmark prompts are small). */
  contextTokens?: number;
  /** Per-case request timeout (default 120000). */
  caseTimeoutMs?: number;
  onProgress?: (completed: number, total: number, result: BenchmarkCaseResult) => void;
}

export interface ModelBenchmarkSuiteOptions {
  /** Default `off`: qwen3 would otherwise spend the completion cap on a hidden reasoning block and score the cap, not the model. */
  thinkingMode?: ThinkingMode;
}

export class BenchmarkBusyError extends Error {
  public readonly runningLabel: string;

  constructor(runningLabel: string) {
    super(`A benchmark is already running (${runningLabel}). Only one runs at a time.`);
    this.name = 'BenchmarkBusyError';
    this.runningLabel = runningLabel;
  }
}

/** Allows one benchmark at a time across the process (web and Telegram share the singleton below). */
export class BenchmarkGuard {
  private active: { label: string; startedAt: number } | null = null;

  /** Returns a release function, or null when a benchmark is already running. The release function is idempotent. */
  public tryAcquire(label: string): (() => void) | null {
    if (this.active) return null;
    const token = { label, startedAt: Date.now() };
    this.active = token;
    return () => {
      if (this.active === token) this.active = null;
    };
  }

  public isBusy(): boolean {
    return this.active !== null;
  }

  public current(): { label: string; startedAt: number } | null {
    return this.active ? { ...this.active } : null;
  }
}

export const benchmarkGuard = new BenchmarkGuard();

/** Most recent scorecard per model, so an HTTP GET can read results without re-running the model. */
export class BenchmarkCache {
  private cards = new Map<string, ModelBenchmarkScorecard>();

  public set(card: ModelBenchmarkScorecard): void {
    this.cards.set(card.modelName, card);
  }

  public get(model: string, maxAgeMs?: number): ModelBenchmarkScorecard | null {
    const card = this.cards.get(model);
    if (!card) return null;
    if (maxAgeMs !== undefined && Date.now() - Date.parse(card.timestamp) > maxAgeMs) return null;
    return card;
  }

  public list(): ModelBenchmarkScorecard[] {
    return Array.from(this.cards.values());
  }
}

export const benchmarkCache = new BenchmarkCache();

function coerceOutput(response: unknown): string {
  if (typeof response === 'string') return response;
  if (typeof response === 'object' && response !== null && typeof (response as { text?: unknown }).text === 'string') {
    return (response as { text: string }).text;
  }
  return String(response);
}

/** Why an output does not count, or null when it passes: a pattern match alone is never enough. */
export function judgeAnswer(testCase: Pick<BenchmarkCase, 'prompt' | 'expectedPattern' | 'verify'>, output: string): { passed: boolean; note?: string } {
  if (output.trim() === '') return { passed: false, note: 'empty answer' };
  if (isRefusal(output)) return { passed: false, note: 'the model declined or did not know' };
  if (isPromptEcho(output, testCase.prompt)) return { passed: false, note: 'the output repeats the question' };
  const matched =
    typeof testCase.expectedPattern === 'string'
      ? output.toLowerCase().includes(testCase.expectedPattern.toLowerCase())
      : testCase.expectedPattern.test(output);
  if (!matched) return { passed: false };
  if (testCase.verify && !testCase.verify(output)) return { passed: false, note: 'the answer failed its structural check' };
  return { passed: true };
}

function gradeFor(score: number): BenchmarkGrade {
  if (score >= 95) return 'A+';
  if (score >= 90) return 'A';
  if (score >= 80) return 'B+';
  if (score >= 70) return 'B';
  if (score >= 50) return 'C';
  return 'F';
}

export class ModelBenchmarkSuite {
  private testCases: BenchmarkCase[] = [];
  private thinkingMode: ThinkingMode;

  constructor(options: ModelBenchmarkSuiteOptions = {}) {
    this.thinkingMode = options.thinkingMode ?? 'off';
    this.initStandardCases();
  }

  private initStandardCases(): void {
    // 1. REASONING & LOGIC
    this.addCase({
      id: 'reasoning-01-temporal',
      category: 'reasoning',
      title: 'Time & Distance Calculation',
      prompt: 'If a train departs at 10:30 AM and travels 180 miles at 60 mph without stopping, what time does it arrive?',
      expectedPattern: /(?<![\d:])(?:1:30\s*(?:pm|p\.m\.)|13:30)(?![\d])/i,
      weight: 3,
    });

    this.addCase({
      id: 'reasoning-02-deduction',
      category: 'reasoning',
      title: 'Syllogistic Logical Deduction',
      prompt: 'Premise 1: All high-memory APUs use unified memory. Premise 2: The AMD Strix Halo is a high-memory APU. Does the Strix Halo use unified memory? Answer directly with Yes or No, and state why.',
      expectedPattern: /^[^\p{L}\p{N}]*yes\b(?!\s+or\s+no\b)/iu,
      weight: 3,
    });

    this.addCase({
      id: 'reasoning-03-sequencing',
      category: 'reasoning',
      title: 'Task Sequencing & Dependencies',
      prompt: 'Task A takes 1 hour. Task B depends on A and takes 2 hours. Task C depends on B and takes 1 hour. If we start Task A at 8:00 AM, at what time is Task C completed?',
      expectedPattern: /(?<![\d:])(?:12:00(?!\s*am)|12\s*pm)(?![\d])|\bnoon\b/i,
      weight: 4,
    });

    // 2. CODING & ALGORITHMS
    this.addCase({
      id: 'coding-01-algorithm',
      category: 'coding',
      title: 'TypeScript Memoized Algorithm',
      prompt: 'Write a TypeScript function fibonacci(n: number): number that uses memoization to compute the nth Fibonacci number efficiently.',
      // The prompt names `function fibonacci(n: number): number`; only an implementation has a body that returns.
      expectedPattern: /(?:function\s+fibonacci|const\s+fibonacci\s*=)[^{]*\{[\s\S]*\breturn\b/i,
      verify: (output) => /\b(?:memo\w*|cache|Map)\b/i.test(output),
      weight: 5,
    });

    this.addCase({
      id: 'coding-02-debugging',
      category: 'coding',
      title: 'Boundary Bug Identification',
      prompt: 'Find the bug in this function:\nfunction sum(arr: number[]): number {\n  let total = 0;\n  for (let i = 0; i <= arr.length; i++) {\n    total += arr[i];\n  }\n  return total;\n}\nWhat causes the bug and what is the fix?',
      expectedPattern: /\bi\s*<\s*(?:arr|array)\.length\b|\boff[- ]by[- ]one\b|\bout[- ]of[- ](?:bounds|range)\b/i,
      weight: 4,
    });

    this.addCase({
      id: 'coding-03-self-improvement',
      category: 'coding',
      title: 'Security Rule Formulation',
      prompt: 'Write a clean security rule for an autonomous AI agent specifying that all sensitive API tokens must be stored in an AES-256 encrypted vault rather than plain text.',
      expectedPattern: /\b(?:must|shall|never|required|prohibited|forbidden)\b/i,
      verify: (output) => /\b(?:vault|encrypt\w*|aes-256)\b/i.test(output) && /\b(?:tokens?|secrets?|credentials?|keys?)\b/i.test(output),
      weight: 4,
    });

    // 3. TOOL CALLING & JSON SCHEMA
    this.addCase({
      id: 'tool-01-system-stats',
      category: 'tool_calling',
      title: 'System Stats Tool Invocation',
      prompt: 'You are Jarvis. To answer this request, emit a JSON tool call with format {"tool": "tool_name", "parameters": {}} to check the system host memory.',
      expectedPattern: /"tool"\s*:\s*"system_stats"/i,
      // The emitted JSON is parsed: the prompt's own `tool_name` template is not a tool.
      verify: (output) => findToolCall(output, 'system_stats') !== null,
      weight: 4,
    });

    this.addCase({
      id: 'tool-02-search',
      category: 'tool_calling',
      title: 'Search Tool Parameter Schema',
      prompt: 'You need to research "Radeon 8060S memory bandwidth". Output a JSON tool call with {"tool": "searxng_search", "parameters": {"query": "..."}}.',
      expectedPattern: /"tool"\s*:\s*"searxng_search"/i,
      // The prompt's template has `"query": "..."`; a real call carries a query about the topic.
      verify: (output) => {
        const query = findToolCall(output, 'searxng_search')?.parameters.query;
        return typeof query === 'string' && /\b8060s\b/i.test(query) && /\bbandwidth\b/i.test(query);
      },
      weight: 4,
    });

    // 4. ARCHITECTURE & RETRIEVAL
    this.addCase({
      id: 'retrieval-01-hardware',
      category: 'retrieval',
      title: 'Workstation Hardware Profile',
      prompt: 'What hardware runs the Jarvis autonomous assistant?',
      // The hardware profile is injected by `CognitionEngine.formatPrompt`, so this reads it back; a refusal or an unrelated reply fails.
      expectedPattern: /\b(?:ASUS|ROG|Flow\s*Z13|Z13|Radeon|8060S|Ryzen)\b/i,
      weight: 3,
    });

    this.addCase({
      id: 'retrieval-02-security',
      category: 'retrieval',
      title: 'Three-Tier Safety Architecture',
      prompt: 'What are the three action execution tiers in Jarvis security?',
      expectedPattern: /\bTier 1\b/i,
      verify: (output) => /\bTier 2\b/i.test(output) && /\bTier 3\b/i.test(output),
      weight: 3,
    });
  }

  addCase(testCase: BenchmarkCase): void {
    this.testCases.push(testCase);
  }

  /**
   * Runs the suite only if no other benchmark is running; throws `BenchmarkBusyError` otherwise. Completed and partial
   * scorecards are stored in `benchmarkCache`.
   */
  async runExclusive(provider: LLMProvider, options: BenchmarkRunOptions = {}, guard: BenchmarkGuard = benchmarkGuard): Promise<ModelBenchmarkScorecard> {
    const release = guard.tryAcquire(provider.getModel());
    if (!release) throw new BenchmarkBusyError(guard.current()?.label ?? 'unknown');
    try {
      const card = await this.runBenchmark(provider, options);
      if (card.status === 'complete' || card.status === 'partial') benchmarkCache.set(card);
      return card;
    } finally {
      release();
    }
  }

  async runBenchmark(provider: LLMProvider, options: BenchmarkRunOptions = {}): Promise<ModelBenchmarkScorecard> {
    const results: BenchmarkCaseResult[] = [];
    const modelName = provider.getModel();
    let totalLatency = 0;
    let aborted = false;

    const think = resolveThink(this.thinkingMode, modelName);
    for (const tc of this.testCases) {
      if (options.signal?.aborted) {
        aborted = true;
        break;
      }
      const start = Date.now();
      const reported: GenerationUsage[] = [];
      let result: BenchmarkCaseResult;
      try {
        const promptToSend = CognitionEngine.formatPrompt(tc.prompt, {
          taskType: tc.category === 'coding' ? 'code' : 'chat',
          activeModel: modelName,
        });
        const response = await provider.generate(promptToSend, {
          temperature: 0.2,
          // A model left to think needs room to finish its reasoning before the visible answer starts.
          maxTokens: options.maxTokens ?? (think === false ? 768 : 2048),
          think,
          contextTokens: options.contextTokens ?? 4096,
          signal: options.signal,
          timeoutMs: options.caseTimeoutMs ?? 120_000,
          onUsage: (u) => {
            reported.push(u);
          },
        });
        const latencyMs = Date.now() - start;
        const usage: GenerationUsage | undefined = reported[reported.length - 1];
        totalLatency += latencyMs;

        const output = stripThinking(coerceOutput(response));

        const judged = judgeAnswer(tc, output);
        const passed = judged.passed;

        result = {
          id: tc.id,
          category: tc.category,
          title: tc.title,
          passed,
          score: passed ? 1.0 : 0.0,
          latencyMs,
          outputPreview: output.slice(0, 100).replace(/\n/g, ' '),
          ...(judged.note ? { notes: judged.note } : {}),
          promptTokens: usage?.promptTokens,
          completionTokens: usage?.completionTokens,
          evalDurationMs: usage?.evalDurationMs,
          loadMs: usage?.loadDurationMs,
          promptEvalMs: usage?.promptEvalDurationMs,
        };
      } catch (err: unknown) {
        if (options.signal?.aborted) {
          aborted = true;
          break;
        }
        const latencyMs = Date.now() - start;
        totalLatency += latencyMs;
        result = {
          id: tc.id,
          category: tc.category,
          title: tc.title,
          passed: false,
          errored: true,
          score: 0.0,
          latencyMs,
          outputPreview: '',
          notes: `Failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      results.push(result);
      options.onProgress?.(results.length, this.testCases.length, result);
    }

    const answered = results.filter((r) => !r.errored);
    const errored = results.filter((r) => r.errored);
    const weightOf = (id: string): number => this.testCases.find((c) => c.id === id)?.weight ?? 1;

    // Category Aggregations
    const categories: Record<string, CategorySummary> = {};
    for (const cat of ['reasoning', 'coding', 'tool_calling', 'retrieval']) {
      const inCat = results.filter((r) => r.category === cat);
      const items = inCat.filter((r) => !r.errored);
      const passed = items.filter((r) => r.passed).length;
      const total = items.length;
      const avgLat = total > 0 ? Math.round(items.reduce((a, r) => a + r.latencyMs, 0) / total) : 0;
      categories[cat] = {
        category: cat,
        passed,
        total,
        errored: inCat.length - total,
        percentage: total > 0 ? Math.round((passed / total) * 100) : 0,
        avgLatencyMs: avgLat,
      };
    }

    // Weighted score over the cases that actually got an answer
    const totalWeight = answered.reduce((sum, r) => sum + weightOf(r.id), 0);
    const earnedWeight = answered.reduce((sum, r) => sum + weightOf(r.id) * r.score, 0);
    const overallScore = totalWeight > 0 ? Math.round((earnedWeight / totalWeight) * 100) : 0;

    let status: BenchmarkStatus = 'complete';
    let error: string | undefined;
    if (aborted) {
      status = 'aborted';
      error = 'Benchmark was cancelled before every case ran.';
    } else if (results.length > 0 && answered.length === 0) {
      status = 'error';
      error = errored[0]?.notes?.replace(/^Failed: /, '') ?? 'The model could not be queried.';
    } else if (errored.length > 0) {
      status = 'partial';
      error = `${errored.length} of ${results.length} cases could not be run: ${errored[0].notes?.replace(/^Failed: /, '') ?? 'unknown error'}`;
    }

    const grade: BenchmarkGrade = status === 'error' ? 'ERROR' : status === 'complete' ? gradeFor(overallScore) : 'INCOMPLETE';

    const withBackend = answered.filter((r) => r.completionTokens !== undefined && r.evalDurationMs !== undefined && r.evalDurationMs > 0);
    let tokensPerSec = 0;
    let tokensPerSecSource: TokensPerSecSource = 'none';
    if (withBackend.length > 0) {
      const tokens = withBackend.reduce((a, r) => a + (r.completionTokens ?? 0), 0);
      const seconds = withBackend.reduce((a, r) => a + (r.evalDurationMs ?? 0), 0) / 1000;
      tokensPerSec = Math.round((tokens / seconds) * 10) / 10;
      tokensPerSecSource = 'backend';
    }

    const loaded = results.filter((r) => r.loadMs !== undefined);
    const avgLoadMs = loaded.length > 0 ? Math.round(loaded.reduce((a, r) => a + (r.loadMs ?? 0), 0) / loaded.length) : 0;
    const warmLatencyTotal = results.reduce((a, r) => a + Math.max(0, r.latencyMs - (r.loadMs ?? 0)), 0);

    // Determine recommended lanes
    const recommendedLanes: string[] = [];
    if (status === 'complete') {
      if (categories.coding?.percentage >= 80) recommendedLanes.push('code');
      if (categories.reasoning?.percentage >= 80) recommendedLanes.push('balanced');
      if (overallScore >= 70 && tokensPerSec > 60) recommendedLanes.push('fast');
      if (recommendedLanes.length === 0) recommendedLanes.push('general');
    }

    const freeRAM = Math.round((os.freemem() / (1024 * 1024 * 1024)) * 10) / 10;
    const totalRAM = Math.round((os.totalmem() / (1024 * 1024 * 1024)) * 10) / 10;

    return {
      modelName,
      status,
      error,
      overallScore,
      grade,
      answeredCases: answered.length,
      erroredCases: errored.length,
      totalLatencyMs: totalLatency,
      avgLatencyMs: results.length > 0 ? Math.round(totalLatency / results.length) : 0,
      avgWarmLatencyMs: results.length > 0 ? Math.round(warmLatencyTotal / results.length) : 0,
      avgLoadMs,
      decodeTokensPerSec: tokensPerSec,
      estimatedTokensPerSec: tokensPerSec,
      tokensPerSecSource,
      categories,
      results,
      recommendedLanes,
      timestamp: new Date().toISOString(),
      systemSpecs: {
        platform: os.platform(),
        freeMemoryGB: freeRAM,
        totalMemoryGB: totalRAM,
      },
    };
  }

  static formatMarkdownReport(card: ModelBenchmarkScorecard): string {
    if (card.status === 'error') {
      return [`*Jarvis Model Intelligence Benchmark*`, `*Model:* \`${card.modelName}\``, `*Result:* ERROR - the model could not be benchmarked.`, `*Reason:* ${card.error ?? 'unknown'}`].join('\n');
    }

    const catLines = Object.values(card.categories)
      .map((c) => (c.total === 0 ? `- *${c.category.toUpperCase()}*: no answers` : `- *${c.category.toUpperCase()}*: ${c.percentage}% (${c.passed}/${c.total}) | Avg: ${c.avgLatencyMs}ms`))
      .join('\n');

    const speed = card.tokensPerSecSource === 'none' ? 'decode speed n/a (the backend reported no timings)' : `${card.decodeTokensPerSec} decode tokens/sec`;
    return [
      `📊 *Jarvis Model Intelligence Benchmark*`,
      `══════════════════════════════════════`,
      `*Model:* \`${card.modelName}\``,
      `*Overall Intelligence Score:* **${card.overallScore}%** (Grade: **${card.grade}**)`,
      ...(card.status !== 'complete' ? [`*Note:* ${card.status.toUpperCase()} - ${card.error ?? ''}`] : []),
      `*Throughput:* ${speed} | Avg Latency: ${card.avgLatencyMs}ms (${card.avgWarmLatencyMs}ms without model load) | Avg Load: ${card.avgLoadMs}ms`,
      `*Host Memory:* ${card.systemSpecs.freeMemoryGB} GB free / ${card.systemSpecs.totalMemoryGB} GB total`,
      ``,
      `*Category Breakdown:*`,
      catLines,
      ``,
      `*Recommended Lane:* \`${card.recommendedLanes.join(', ') || 'none'}\``,
    ].join('\n');
  }

  static formatTerminalReport(card: ModelBenchmarkScorecard): string {
    if (card.status === 'error') {
      return [
        '==============================================================',
        '           JARVIS MODEL INTELLIGENCE BENCHMARK REPORT          ',
        '==============================================================',
        ` Model Tested     : ${card.modelName}`,
        ` Result           : ERROR - the model could not be benchmarked`,
        ` Reason           : ${card.error ?? 'unknown'}`,
        '==============================================================',
      ].join('\n');
    }

    const lines = [
      '==============================================================',
      '           JARVIS MODEL INTELLIGENCE BENCHMARK REPORT          ',
      '==============================================================',
      ` Model Tested     : ${card.modelName}`,
      ` Overall Score    : ${card.overallScore}% [Grade: ${card.grade}]`,
      ...(card.status !== 'complete' ? [` Status           : ${card.status.toUpperCase()} - ${card.error ?? ''}`] : []),
      ` Decode Speed     : ${card.tokensPerSecSource === 'none' ? 'n/a (the backend reported no timings)' : `${card.decodeTokensPerSec} tokens/sec`}`,
      ` Average Latency  : ${card.avgLatencyMs} ms (${card.avgWarmLatencyMs} ms without model load)`,
      ` Average Load     : ${card.avgLoadMs} ms`,
      ` Memory Headroom  : ${card.systemSpecs.freeMemoryGB} GB free / ${card.systemSpecs.totalMemoryGB} GB total`,
      '--------------------------------------------------------------',
      ' Category Breakdown:',
    ];

    for (const c of Object.values(card.categories)) {
      const bar = '█'.repeat(Math.round(c.percentage / 10)) + '░'.repeat(10 - Math.round(c.percentage / 10));
      lines.push(`  - ${c.category.padEnd(14)}: [${bar}] ${c.percentage.toString().padStart(3)}% (${c.passed}/${c.total}) - ${c.avgLatencyMs}ms`);
    }

    lines.push('--------------------------------------------------------------');
    lines.push(` Recommended Assignment : ${card.recommendedLanes.join(', ').toUpperCase() || 'NONE'}`);
    lines.push('==============================================================');

    return lines.join('\n');
  }
}
