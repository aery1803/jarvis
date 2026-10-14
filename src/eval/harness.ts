import type { LLMProvider } from '../services/provider.js';
import { resolveThink, type ThinkingMode } from '../services/thinking-control.js';
import { findToolCall, isPromptEcho, isRefusal, stripThinking } from './answer-check.js';

export interface EvalTestCase {
  id: string;
  category: 'retrieval' | 'reasoning' | 'tool_calling' | 'headroom';
  prompt: string;
  /** Anchor it to the answer: a pattern that also matches the prompt's own words passes on an echo. */
  expectedPattern: RegExp | string;
  /** An extra check on the answer (parse the emitted JSON); both must hold. */
  verify?: (output: string) => boolean;
  maxLatencyMs?: number;
}

export interface EvalCaseResult {
  testId: string;
  category: string;
  passed: boolean;
  score: number; // 0.0 to 1.0
  latencyMs: number;
  output: string;
  notes?: string;
  /** True when the provider could not be queried; distinct from a wrong answer. */
  errored?: boolean;
}

export interface EvalRunOptions {
  signal?: AbortSignal;
  /** Per-case request timeout (default 120000). */
  timeoutMs?: number;
}

export interface EvalReport {
  totalTests: number;
  passedTests: number;
  accuracyRate: number; // e.g. 0.95
  meetsTarget: boolean; // >= 0.90 per Section 16
  avgLatencyMs: number;
  /** Cases that could not be run at all (provider error); counted as failures in `accuracyRate`. */
  erroredTests: number;
  /** True when the caller aborted before every case ran. */
  aborted: boolean;
  results: EvalCaseResult[];
}

export interface EvaluationHarnessOptions {
  /** Default `off`: qwen3 would otherwise spend its token budget on a hidden reasoning block and score the budget, not the model. */
  thinkingMode?: ThinkingMode;
}

export class EvaluationHarness {
  private testCases: EvalTestCase[] = [];
  private thinkingMode: ThinkingMode;

  constructor(private provider: LLMProvider, options: EvaluationHarnessOptions = {}) {
    this.thinkingMode = options.thinkingMode ?? 'off';
    this.initDefaultCases();
  }

  private initDefaultCases(): void {
    this.addCase({
      id: 'eval-reasoning-01',
      category: 'reasoning',
      prompt: 'If a train leaves at 2:00 PM and travels 120 miles at 60 mph, what time does it arrive?',
      expectedPattern: /(?<![\d:.])(?:4:00\s*(?:pm|p\.m\.)?|4\s*pm|16:00)(?![\d])/i,
      maxLatencyMs: 8000,
    });

    // A plain `generate` call cannot run a tool, so the case checks that the model emits a well-formed call.
    this.addCase({
      id: 'eval-tool-01',
      category: 'tool_calling',
      prompt: 'Check the current system stats and memory. Reply with only a JSON tool call of the form {"tool": "<name>", "parameters": {}}, using the tool name system_stats.',
      expectedPattern: /"tool"\s*:\s*"system_stats"/i,
      verify: (output) => findToolCall(output, 'system_stats') !== null,
      maxLatencyMs: 5000,
    });

    // The provider gets no hidden context, so the facts are in the prompt and the answer is a value read from them.
    this.addCase({
      id: 'eval-retrieval-01',
      category: 'retrieval',
      prompt:
        'Hardware profile: Jarvis runs on an ASUS ROG Flow Z13 with a Radeon 8060S GPU and 31.65 GB of host RAM.\n' +
        'Question: how many GB of host RAM does the Jarvis workstation have? Answer with the number.',
      expectedPattern: /(?<![\d.])31\.65(?![\d])/,
      maxLatencyMs: 5000,
    });
  }

  addCase(testCase: EvalTestCase): void {
    this.testCases.push(testCase);
  }

  async runTest(testCase: EvalTestCase, options: EvalRunOptions = {}): Promise<EvalCaseResult> {
    const start = Date.now();
    try {
      const response: unknown = await this.provider.generate(testCase.prompt, {
        think: resolveThink(this.thinkingMode, this.provider.getModel()),
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? 120_000,
      });
      const latencyMs = Date.now() - start;

      const raw =
        typeof response === 'string'
          ? response
          : typeof (response as { text?: unknown } | null)?.text === 'string'
            ? (response as { text: string }).text
            : String(response);
      // A pattern must not match the model's scratch work, a refusal, or the question repeated back.
      const output = stripThinking(raw);
      let answerNote: string | undefined;
      let matched = false;
      if (output === '') answerNote = 'empty answer';
      else if (isRefusal(output)) answerNote = 'the model declined or did not know';
      else if (isPromptEcho(output, testCase.prompt)) answerNote = 'the output repeats the question';
      else {
        matched = typeof testCase.expectedPattern === 'string' ? output.toLowerCase().includes(testCase.expectedPattern.toLowerCase()) : testCase.expectedPattern.test(output);
        if (matched && testCase.verify && !testCase.verify(output)) {
          matched = false;
          answerNote = 'the answer failed its structural check';
        }
      }

      const latencyOk = !testCase.maxLatencyMs || latencyMs <= testCase.maxLatencyMs;
      const passed = matched && latencyOk;
      const score = passed ? 1.0 : matched ? 0.8 : 0.0;

      return {
        testId: testCase.id,
        category: testCase.category,
        passed,
        score,
        latencyMs,
        output,
        notes: !latencyOk ? 'Latency exceeded budget' : answerNote,
      };
    } catch (err: unknown) {
      return {
        testId: testCase.id,
        category: testCase.category,
        passed: false,
        errored: true,
        score: 0.0,
        latencyMs: Date.now() - start,
        output: '',
        notes: `Inference failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  async runAll(options: EvalRunOptions = {}): Promise<EvalReport> {
    const results: EvalCaseResult[] = [];
    let totalLatency = 0;
    let aborted = false;

    for (const c of this.testCases) {
      if (options.signal?.aborted) {
        aborted = true;
        break;
      }
      const res = await this.runTest(c, options);
      results.push(res);
      totalLatency += res.latencyMs;
    }

    const passedCount = results.filter((r) => r.passed).length;
    const accuracyRate = results.length > 0 ? parseFloat((passedCount / results.length).toFixed(2)) : 0;
    const erroredTests = results.filter((r) => r.errored).length;

    return {
      totalTests: results.length,
      passedTests: passedCount,
      accuracyRate,
      meetsTarget: !aborted && results.length === this.testCases.length && accuracyRate >= 0.9,
      avgLatencyMs: results.length > 0 ? parseFloat((totalLatency / results.length).toFixed(2)) : 0,
      erroredTests,
      aborted,
      results,
    };
  }
}
