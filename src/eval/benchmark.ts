/**
 * Jarvis Local AI Agent: Comprehensive Model Benchmark Suite
 * Evaluates local and remote LLMs across Reasoning, Coding, Tool Calling, and Retrieval.
 */

import type { LLMProvider } from '../services/provider.js';
import { resolveThink, type ThinkingMode } from '../services/thinking-control.js';
import { MIN_COMPLETION_TOKENS, executeCase } from './case-runner.js';
import { buildStandardCases, type CaseDefinition } from './cases.js';
import type { EvalToolbox } from './graders.js';
import os from 'node:os';

export type BenchmarkCase = CaseDefinition;

export interface BenchmarkCaseResult {
  id: string;
  category: string;
  title: string;
  passed: boolean;
  /** True when the model could not be queried at all (HTTP error, network, timeout). Not a wrong answer. */
  errored?: boolean;
  score: number; // 1 for a pass, otherwise 0
  /** Why the case passed, failed or errored. Reported for every case. */
  reason: string;
  /** Same text as `reason`, set only when the case did not pass. */
  notes?: string;
  /** Reported, never graded: a correct answer is correct however long it took. */
  latencyMs: number;
  outputPreview: string;
  promptTokens?: number;
  completionTokens?: number;
  /** completion tokens / `eval_duration` for this case; absent when the backend reported no decode time. */
  decodeTokensPerSec?: number;
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
  /** Passed / answered cases, 0 to 100 (every case counts the same). Meaningless when status is `error`; check `status` / `grade` first. */
  overallScore: number;
  grade: BenchmarkGrade;
  answeredCases: number;
  erroredCases: number;
  /** The thinking mode every case ran with: `off` (think:false sent), `on`, or the model's own default. */
  thinking: 'off' | 'on' | 'model default';
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
  /**
   * The registry and parser the chat pipeline uses. The tool-calling cases offer its real schemas and grade the reply
   * with its real parser and validator, so without it those cases are left out instead of being faked.
   */
  toolbox?: EvalToolbox;
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
  private toolbox: EvalToolbox | undefined;

  constructor(options: ModelBenchmarkSuiteOptions = {}) {
    this.thinkingMode = options.thinkingMode ?? 'off';
    this.toolbox = options.toolbox;
    for (const testCase of buildStandardCases({ includeTools: this.toolbox !== undefined })) this.addCase(testCase);
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
      const run = await executeCase(tc, {
        provider,
        think,
        // A model left to think needs room to finish its reasoning before the visible answer starts.
        maxTokens: options.maxTokens ?? (think === false ? MIN_COMPLETION_TOKENS : 2048),
        contextTokens: options.contextTokens ?? 4096,
        timeoutMs: options.caseTimeoutMs ?? 120_000,
        signal: options.signal,
        toolbox: this.toolbox,
      });
      if (run.aborted) {
        aborted = true;
        break;
      }
      totalLatency += run.latencyMs;
      const result: BenchmarkCaseResult = {
        id: tc.id,
        category: tc.category,
        title: tc.title,
        passed: run.passed,
        ...(run.errored ? { errored: true } : {}),
        score: run.passed ? 1 : 0,
        reason: run.reason,
        ...(run.passed ? {} : { notes: run.reason }),
        latencyMs: run.latencyMs,
        outputPreview: run.output.slice(0, 100).replace(/\n/g, ' '),
        promptTokens: run.usage?.promptTokens,
        completionTokens: run.usage?.completionTokens,
        ...(run.decodeTokensPerSec !== undefined ? { decodeTokensPerSec: run.decodeTokensPerSec } : {}),
        evalDurationMs: run.usage?.evalDurationMs,
        loadMs: run.usage?.loadDurationMs,
        promptEvalMs: run.usage?.promptEvalDurationMs,
      };
      results.push(result);
      options.onProgress?.(results.length, this.testCases.length, result);
    }

    const answered = results.filter((r) => !r.errored);
    const errored = results.filter((r) => r.errored);

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

    // Latency never enters the score: a correct answer is correct however long the model took to write it.
    const overallScore = answered.length > 0 ? Math.round((answered.filter((r) => r.passed).length / answered.length) * 100) : 0;

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
      thinking: think === false ? 'off' : think === true ? 'on' : 'model default',
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
    lines.push(` Cases (latency and speed are reported, never graded; thinking: ${card.thinking}):`);
    for (const r of card.results) {
      const verdict = r.errored ? 'ERROR' : r.passed ? 'PASS ' : 'FAIL ';
      const speed = r.decodeTokensPerSec === undefined ? '' : `, ${r.decodeTokensPerSec} t/s`;
      lines.push(`  ${verdict} ${r.id} (${r.latencyMs} ms${r.completionTokens === undefined ? '' : `, ${r.completionTokens} tokens`}${speed}) - ${r.reason}`);
    }
    lines.push('--------------------------------------------------------------');
    lines.push(` Recommended Assignment : ${card.recommendedLanes.join(', ').toUpperCase() || 'NONE'}`);
    lines.push('==============================================================');

    return lines.join('\n');
  }
}
