/**
 * Jarvis Local AI Agent: Comprehensive Model Benchmark Suite
 * Evaluates local and remote LLMs across Reasoning, Coding, Tool Calling, and Retrieval.
 */

import type { LLMProvider } from '../services/provider.js';
import { CognitionEngine } from '../agents/cognition.js';
import os from 'node:os';

export interface BenchmarkCase {
  id: string;
  category: 'reasoning' | 'coding' | 'tool_calling' | 'retrieval';
  title: string;
  prompt: string;
  expectedPattern: RegExp | string;
  weight: number; // 1 to 5
}

export interface BenchmarkCaseResult {
  id: string;
  category: string;
  title: string;
  passed: boolean;
  score: number; // 0.0 to 1.0
  latencyMs: number;
  outputPreview: string;
  notes?: string;
}

export interface CategorySummary {
  category: string;
  passed: number;
  total: number;
  percentage: number;
  avgLatencyMs: number;
}

export interface ModelBenchmarkScorecard {
  modelName: string;
  overallScore: number; // 0 to 100
  grade: 'A+' | 'A' | 'B+' | 'B' | 'C' | 'F';
  totalLatencyMs: number;
  avgLatencyMs: number;
  estimatedTokensPerSec: number;
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

export class ModelBenchmarkSuite {
  private testCases: BenchmarkCase[] = [];

  constructor() {
    this.initStandardCases();
  }

  private initStandardCases(): void {
    // 1. REASONING & LOGIC
    this.addCase({
      id: 'reasoning-01-temporal',
      category: 'reasoning',
      title: 'Time & Distance Calculation',
      prompt: 'If a train departs at 10:30 AM and travels 180 miles at 60 mph without stopping, what time does it arrive?',
      expectedPattern: /1:30|1:30 PM/i,
      weight: 3,
    });

    this.addCase({
      id: 'reasoning-02-deduction',
      category: 'reasoning',
      title: 'Syllogistic Logical Deduction',
      prompt: 'Premise 1: All high-memory APUs use unified memory. Premise 2: The AMD Strix Halo is a high-memory APU. Does the Strix Halo use unified memory? Answer directly with Yes or No, and state why.',
      expectedPattern: /\byes\b/i,
      weight: 3,
    });

    this.addCase({
      id: 'reasoning-03-sequencing',
      category: 'reasoning',
      title: 'Task Sequencing & Dependencies',
      prompt: 'Task A takes 1 hour. Task B depends on A and takes 2 hours. Task C depends on B and takes 1 hour. If we start Task A at 8:00 AM, at what time is Task C completed?',
      expectedPattern: /12:00|12 PM|12:00 PM|noon/i,
      weight: 4,
    });

    // 2. CODING & ALGORITHMS
    this.addCase({
      id: 'coding-01-algorithm',
      category: 'coding',
      title: 'TypeScript Memoized Algorithm',
      prompt: 'Write a TypeScript function fibonacci(n: number): number that uses memoization to compute the nth Fibonacci number efficiently.',
      expectedPattern: /function|const|fibonacci|memo/i,
      weight: 5,
    });

    this.addCase({
      id: 'coding-02-debugging',
      category: 'coding',
      title: 'Boundary Bug Identification',
      prompt: 'Find the bug in this function:\nfunction sum(arr: number[]): number {\n  let total = 0;\n  for (let i = 0; i <= arr.length; i++) {\n    total += arr[i];\n  }\n  return total;\n}\nWhat causes the bug and what is the fix?',
      expectedPattern: /i\s*<\s*arr\.length|off-by-one|out of bounds|undefined/i,
      weight: 4,
    });

    this.addCase({
      id: 'coding-03-self-improvement',
      category: 'coding',
      title: 'Security Rule Formulation',
      prompt: 'Write a clean security rule for an autonomous AI agent specifying that all sensitive API tokens must be stored in an AES-256 encrypted vault rather than plain text.',
      expectedPattern: /vault|encrypt|aes-256|token|secret/i,
      weight: 4,
    });

    // 3. TOOL CALLING & JSON SCHEMA
    this.addCase({
      id: 'tool-01-system-stats',
      category: 'tool_calling',
      title: 'System Stats Tool Invocation',
      prompt: 'You are Jarvis. To answer this request, emit a JSON tool call with format {"tool": "tool_name", "parameters": {}} to check the system host memory.',
      expectedPattern: /"tool"\s*:\s*"(system_stats|check_memory|host_memory)"/i,
      weight: 4,
    });

    this.addCase({
      id: 'tool-02-search',
      category: 'tool_calling',
      title: 'Search Tool Parameter Schema',
      prompt: 'You need to research "Radeon 8060S memory bandwidth". Output a JSON tool call with {"tool": "searxng_search", "parameters": {"query": "..."}}.',
      expectedPattern: /"tool"\s*:\s*"searxng_search"/i,
      weight: 4,
    });

    // 4. ARCHITECTURE & RETRIEVAL
    this.addCase({
      id: 'retrieval-01-hardware',
      category: 'retrieval',
      title: 'Workstation Hardware Profile',
      prompt: 'What hardware runs the Jarvis autonomous assistant?',
      expectedPattern: /ASUS|ROG|Flow|Z13|Radeon|8060S|Ryzen|AMD/i,
      weight: 3,
    });

    this.addCase({
      id: 'retrieval-02-security',
      category: 'retrieval',
      title: 'Three-Tier Safety Architecture',
      prompt: 'What are the three action execution tiers in Jarvis security?',
      expectedPattern: /Tier 1|Tier 2|Tier 3/i,
      weight: 3,
    });
  }

  addCase(testCase: BenchmarkCase): void {
    this.testCases.push(testCase);
  }

  async runBenchmark(provider: LLMProvider): Promise<ModelBenchmarkScorecard> {
    const results: BenchmarkCaseResult[] = [];
    const modelName = provider.getModel();
    let totalLatency = 0;
    let totalGeneratedTokensApprox = 0;

    for (const tc of this.testCases) {
      const start = Date.now();
      try {
        const promptToSend = CognitionEngine.formatPrompt(tc.prompt, {
          taskType: tc.category === 'coding' ? 'code' : 'chat',
          activeModel: modelName,
        });
        const response = await provider.generate(promptToSend, { temperature: 0.2, maxTokens: 512 });
        const latencyMs = Date.now() - start;
        totalLatency += latencyMs;

        const output = typeof response === 'string' ? response : (response as any).text ?? String(response);
        const words = output.trim().split(/\s+/).length;
        const estTokens = Math.round(words * 1.3);
        totalGeneratedTokensApprox += estTokens;

        let passed = false;
        if (typeof tc.expectedPattern === 'string') {
          passed = output.toLowerCase().includes(tc.expectedPattern.toLowerCase());
        } else {
          passed = tc.expectedPattern.test(output);
        }

        results.push({
          id: tc.id,
          category: tc.category,
          title: tc.title,
          passed,
          score: passed ? 1.0 : 0.0,
          latencyMs,
          outputPreview: output.slice(0, 100).replace(/\n/g, ' '),
        });
      } catch (err: any) {
        results.push({
          id: tc.id,
          category: tc.category,
          title: tc.title,
          passed: false,
          score: 0.0,
          latencyMs: Date.now() - start,
          outputPreview: '',
          notes: `Failed: ${err.message}`,
        });
      }
    }

    // Category Aggregations
    const categories: Record<string, CategorySummary> = {};
    const catGroups = ['reasoning', 'coding', 'tool_calling', 'retrieval'];

    for (const cat of catGroups) {
      const items = results.filter((r) => r.category === cat);
      const passed = items.filter((r) => r.passed).length;
      const total = items.length;
      const latencies = items.map((r) => r.latencyMs);
      const avgLat = latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;

      categories[cat] = {
        category: cat,
        passed,
        total,
        percentage: total > 0 ? Math.round((passed / total) * 100) : 0,
        avgLatencyMs: avgLat,
      };
    }

    // Weighted Overall Score
    const totalPassed = results.filter((r) => r.passed).length;
    const overallScore = results.length > 0 ? Math.round((totalPassed / results.length) * 100) : 0;

    let grade: 'A+' | 'A' | 'B+' | 'B' | 'C' | 'F' = 'F';
    if (overallScore >= 95) grade = 'A+';
    else if (overallScore >= 90) grade = 'A';
    else if (overallScore >= 80) grade = 'B+';
    else if (overallScore >= 70) grade = 'B';
    else if (overallScore >= 50) grade = 'C';

    const durationSec = totalLatency / 1000;
    const estimatedTokensPerSec = durationSec > 0 ? Math.round((totalGeneratedTokensApprox / durationSec) * 10) / 10 : 0;

    // Determine recommended lanes
    const recommendedLanes: string[] = [];
    if (categories.coding?.percentage >= 80) recommendedLanes.push('code');
    if (categories.reasoning?.percentage >= 80) recommendedLanes.push('balanced');
    if (overallScore >= 70 && estimatedTokensPerSec > 60) recommendedLanes.push('fast');
    if (recommendedLanes.length === 0) recommendedLanes.push('general');

    const freeRAM = Math.round((os.freemem() / (1024 * 1024 * 1024)) * 10) / 10;
    const totalRAM = Math.round((os.totalmem() / (1024 * 1024 * 1024)) * 10) / 10;

    return {
      modelName,
      overallScore,
      grade,
      totalLatencyMs: totalLatency,
      avgLatencyMs: results.length > 0 ? Math.round(totalLatency / results.length) : 0,
      estimatedTokensPerSec,
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
    const catLines = Object.values(card.categories)
      .map((c) => `- *${c.category.toUpperCase()}*: ${c.percentage}% (${c.passed}/${c.total}) | Avg: ${c.avgLatencyMs}ms`)
      .join('\n');

    return [
      `📊 *Jarvis Model Intelligence Benchmark*`,
      `══════════════════════════════════════`,
      `*Model:* \`${card.modelName}\``,
      `*Overall Intelligence Score:* **${card.overallScore}%** (Grade: **${card.grade}**)`,
      `*Throughput:* ~${card.estimatedTokensPerSec} tokens/sec | Avg Latency: ${card.avgLatencyMs}ms`,
      `*Host Memory:* ${card.systemSpecs.freeMemoryGB} GB free / ${card.systemSpecs.totalMemoryGB} GB total`,
      ``,
      `*Category Breakdown:*`,
      catLines,
      ``,
      `*Recommended Lane:* \`${card.recommendedLanes.join(', ')}\``,
    ].join('\n');
  }

  static formatTerminalReport(card: ModelBenchmarkScorecard): string {
    const lines = [
      '==============================================================',
      '           JARVIS MODEL INTELLIGENCE BENCHMARK REPORT          ',
      '==============================================================',
      ` Model Tested     : ${card.modelName}`,
      ` Overall Score    : ${card.overallScore}% [Grade: ${card.grade}]`,
      ` Throughput       : ~${card.estimatedTokensPerSec} tokens/sec`,
      ` Average Latency  : ${card.avgLatencyMs} ms`,
      ` Memory Headroom  : ${card.systemSpecs.freeMemoryGB} GB free / ${card.systemSpecs.totalMemoryGB} GB total`,
      '--------------------------------------------------------------',
      ' Category Breakdown:',
    ];

    for (const c of Object.values(card.categories)) {
      const bar = '█'.repeat(Math.round(c.percentage / 10)) + '░'.repeat(10 - Math.round(c.percentage / 10));
      lines.push(`  - ${c.category.padEnd(14)}: [${bar}] ${c.percentage.toString().padStart(3)}% (${c.passed}/${c.total}) - ${c.avgLatencyMs}ms`);
    }

    lines.push('--------------------------------------------------------------');
    lines.push(` Recommended Assignment : ${card.recommendedLanes.join(', ').toUpperCase()}`);
    lines.push('==============================================================');

    return lines.join('\n');
  }
}
