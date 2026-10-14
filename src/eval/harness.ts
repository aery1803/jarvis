import type { LLMProvider } from '../services/provider.js';

export interface EvalTestCase {
  id: string;
  category: 'retrieval' | 'reasoning' | 'tool_calling' | 'headroom';
  prompt: string;
  expectedPattern: RegExp | string;
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
}

export interface EvalReport {
  totalTests: number;
  passedTests: number;
  accuracyRate: number; // e.g. 0.95
  meetsTarget: boolean; // >= 0.90 per Section 16
  avgLatencyMs: number;
  results: EvalCaseResult[];
}

export class EvaluationHarness {
  private testCases: EvalTestCase[] = [];

  constructor(private provider: LLMProvider) {
    this.initDefaultCases();
  }

  private initDefaultCases(): void {
    this.addCase({
      id: 'eval-reasoning-01',
      category: 'reasoning',
      prompt: 'If a train leaves at 2:00 PM and travels 120 miles at 60 mph, what time does it arrive?',
      expectedPattern: /4:00|4 PM/i,
      maxLatencyMs: 8000,
    });

    this.addCase({
      id: 'eval-tool-01',
      category: 'tool_calling',
      prompt: 'Check current system stats and memory.',
      expectedPattern: /system|stats|memory/i,
      maxLatencyMs: 5000,
    });

    this.addCase({
      id: 'eval-retrieval-01',
      category: 'retrieval',
      prompt: 'What hardware runs Jarvis?',
      expectedPattern: /ASUS|ROG|Flow|Z13|Radeon|8060S|AMD/i,
      maxLatencyMs: 5000,
    });
  }

  addCase(testCase: EvalTestCase): void {
    this.testCases.push(testCase);
  }

  async runTest(testCase: EvalTestCase): Promise<EvalCaseResult> {
    const start = Date.now();
    try {
      const response = await this.provider.generate(testCase.prompt);
      const latencyMs = Date.now() - start;

      const output = typeof response === 'string' ? response : (response as any).text ?? String(response);
      let matched = false;
      if (typeof testCase.expectedPattern === 'string') {
        matched = output.toLowerCase().includes(testCase.expectedPattern.toLowerCase());
      } else {
        matched = testCase.expectedPattern.test(output);
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
        notes: !latencyOk ? 'Latency exceeded budget' : undefined,
      };
    } catch (err: any) {
      return {
        testId: testCase.id,
        category: testCase.category,
        passed: false,
        score: 0.0,
        latencyMs: Date.now() - start,
        output: '',
        notes: `Inference failed: ${err.message}`,
      };
    }
  }

  async runAll(): Promise<EvalReport> {
    const results: EvalCaseResult[] = [];
    let totalLatency = 0;

    for (const c of this.testCases) {
      const res = await this.runTest(c);
      results.push(res);
      totalLatency += res.latencyMs;
    }

    const passedCount = results.filter((r) => r.passed).length;
    const accuracyRate = results.length > 0 ? parseFloat((passedCount / results.length).toFixed(2)) : 0;

    return {
      totalTests: results.length,
      passedTests: passedCount,
      accuracyRate,
      meetsTarget: accuracyRate >= 0.9,
      avgLatencyMs: results.length > 0 ? parseFloat((totalLatency / results.length).toFixed(2)) : 0,
      results,
    };
  }
}
