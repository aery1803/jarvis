import type { LLMProvider } from '../services/provider.js';
import { resolveThink, type ThinkingMode } from '../services/thinking-control.js';
import { MIN_COMPLETION_TOKENS, executeCase, type EvalCaseSpec } from './case-runner.js';
import {
  finalAnswerGrader,
  quantityAnswer,
  timeAnswer,
  toolCallGrader,
  withFinalAnswer,
  type EvalToolbox,
} from './graders.js';
import { HARDWARE_FACTS } from './cases.js';

export type EvalTestCase = EvalCaseSpec & { category: 'retrieval' | 'reasoning' | 'tool_calling' | 'headroom' };

export interface EvalCaseResult {
  testId: string;
  category: string;
  passed: boolean;
  score: number; // 1 for a pass, otherwise 0
  /** Reported, never graded: a correct answer is correct however long it took. */
  latencyMs: number;
  output: string;
  /** Why the case passed, failed or errored. */
  reason: string;
  /** Same text as `reason`, set only when the case did not pass. */
  notes?: string;
  /** True when the provider could not be queried; distinct from a wrong answer. */
  errored?: boolean;
  promptTokens?: number;
  completionTokens?: number;
  /** Backend-reported decode time (`eval_duration`). */
  evalDurationMs?: number;
  /** completion tokens / the backend's decode time; absent when the backend reported none. */
  decodeTokensPerSec?: number;
}

export interface EvalRunOptions {
  signal?: AbortSignal;
  /** Per-case request timeout (default 120000). */
  timeoutMs?: number;
}

export interface EvalCategorySummary {
  category: string;
  passed: number;
  total: number;
  errored: number;
}

export interface EvalReport {
  totalTests: number;
  passedTests: number;
  accuracyRate: number; // e.g. 0.95
  meetsTarget: boolean; // >= 0.90 per Section 16
  /** Mean latency over the cases that ran. Reported only: it never decides a pass. */
  avgLatencyMs: number;
  /** Total completion tokens / total decode time over the cases whose backend reported one; 0 when none did. */
  decodeTokensPerSec: number;
  /** Cases that could not be run at all (provider error); counted as failures in `accuracyRate`. */
  erroredTests: number;
  categories: Record<string, EvalCategorySummary>;
  /** True when the caller aborted before every case ran. */
  aborted: boolean;
  results: EvalCaseResult[];
}

export interface EvaluationHarnessOptions {
  /** Default `off`: qwen3 would otherwise spend its token budget on a hidden reasoning block and score the budget, not the model. */
  thinkingMode?: ThinkingMode;
  /** The pipeline's tool registry and parser. Without it the tool case is left out instead of being faked. */
  toolbox?: EvalToolbox;
}

export class EvaluationHarness {
  private testCases: EvalTestCase[] = [];
  private thinkingMode: ThinkingMode;
  private toolbox: EvalToolbox | undefined;

  constructor(private provider: LLMProvider, options: EvaluationHarnessOptions = {}) {
    this.thinkingMode = options.thinkingMode ?? 'off';
    this.toolbox = options.toolbox;
    this.initDefaultCases();
  }

  private initDefaultCases(): void {
    this.addCase({
      id: 'eval-reasoning-01',
      category: 'reasoning',
      prompt: withFinalAnswer('A train leaves at 2:00 PM and travels 120 miles at 60 mph. What time does it arrive? Show your working briefly.', '<a clock time such as 3:45 PM>'),
      grade: finalAnswerGrader(timeAnswer(16 * 60, '4:00 PM')),
    });

    if (this.toolbox) {
      this.addCase({
        id: 'eval-tool-01',
        category: 'tool_calling',
        prompt: 'Check the current system stats and memory of this machine.',
        offerTools: true,
        expectsOffered: 'system_stats',
        grade: toolCallGrader({ tool: 'system_stats' }),
      });
    }

    this.addCase({
      id: 'eval-retrieval-01',
      category: 'retrieval',
      facts: HARDWARE_FACTS,
      prompt: withFinalAnswer('According to the provided context, how many GB of host RAM does the Jarvis workstation report?', '<a number with its unit>'),
      grade: finalAnswerGrader(quantityAnswer(31.65, 'gb')),
    });
  }

  addCase(testCase: EvalTestCase): void {
    this.testCases.push(testCase);
  }

  async runTest(testCase: EvalTestCase, options: EvalRunOptions = {}): Promise<EvalCaseResult> {
    const run = await executeCase(testCase, {
      provider: this.provider,
      think: resolveThink(this.thinkingMode, this.provider.getModel()),
      maxTokens: MIN_COMPLETION_TOKENS,
      contextTokens: 4096,
      timeoutMs: options.timeoutMs ?? 120_000,
      signal: options.signal,
      toolbox: this.toolbox,
    });
    return {
      testId: testCase.id,
      category: testCase.category,
      passed: run.passed,
      ...(run.errored ? { errored: true } : {}),
      score: run.passed ? 1 : 0,
      latencyMs: run.latencyMs,
      output: run.output,
      reason: run.reason,
      ...(run.passed ? {} : { notes: run.reason }),
      promptTokens: run.usage?.promptTokens,
      completionTokens: run.usage?.completionTokens,
      ...(run.decodeTokensPerSec !== undefined ? { decodeTokensPerSec: run.decodeTokensPerSec } : {}),
      ...(run.usage?.evalDurationMs !== undefined ? { evalDurationMs: run.usage.evalDurationMs } : {}),
    };
  }

  async runAll(options: EvalRunOptions = {}): Promise<EvalReport> {
    const results: EvalCaseResult[] = [];
    let totalLatency = 0;
    let aborted = false;
    let decodeTokens = 0;
    let decodeMs = 0;

    for (const c of this.testCases) {
      if (options.signal?.aborted) {
        aborted = true;
        break;
      }
      const res = await this.runTest(c, options);
      if (res.errored && options.signal?.aborted) {
        aborted = true;
        break;
      }
      results.push(res);
      totalLatency += res.latencyMs;
      const evalMs = res.evalDurationMs;
      if (res.completionTokens !== undefined && evalMs !== undefined && evalMs > 0) {
        decodeTokens += res.completionTokens;
        decodeMs += evalMs;
      }
    }

    const passedCount = results.filter((r) => r.passed).length;
    const accuracyRate = results.length > 0 ? parseFloat((passedCount / results.length).toFixed(2)) : 0;
    const erroredTests = results.filter((r) => r.errored).length;
    const categories: Record<string, EvalCategorySummary> = {};
    for (const r of results) {
      const entry = (categories[r.category] ??= { category: r.category, passed: 0, total: 0, errored: 0 });
      entry.total += 1;
      if (r.passed) entry.passed += 1;
      if (r.errored) entry.errored += 1;
    }

    return {
      totalTests: results.length,
      passedTests: passedCount,
      accuracyRate,
      meetsTarget: !aborted && results.length === this.testCases.length && accuracyRate >= 0.9,
      avgLatencyMs: results.length > 0 ? parseFloat((totalLatency / results.length).toFixed(2)) : 0,
      decodeTokensPerSec: decodeMs > 0 ? Math.round((decodeTokens / (decodeMs / 1000)) * 10) / 10 : 0,
      erroredTests,
      categories,
      aborted,
      results,
    };
  }
}
