/**
 * Jarvis Local AI Agent: Benchmark CLI Runner
 * Run comprehensive intelligence benchmarks against installed local or remote models.
 * Usage: npx tsx src/eval/cli.ts [--model <name>] [--all]
 *
 * Without `--model` the configured default model (JARVIS_DEFAULT_MODEL, else the resident baseline) is used.
 */

import { ModelBenchmarkSuite, benchmarkGuard } from './benchmark.js';
import type { ModelBenchmarkScorecard } from './benchmark.js';
import { OllamaProvider } from '../services/provider.js';
import { config } from '../config.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const isAll = args.includes('--all');
  const modelIdx = args.indexOf('--model');
  const targetModel = modelIdx !== -1 ? args[modelIdx + 1] : undefined;
  if (modelIdx !== -1 && !targetModel) {
    throw new Error('--model needs a model name');
  }

  console.log('\n==============================================================');
  console.log('       JARVIS LOCAL AI AGENT - MODEL INTELLIGENCE BENCHMARK    ');
  console.log('==============================================================\n');

  const defaultProvider = new OllamaProvider({ baseUrl: config.ollamaBaseUrl });
  let installedModels: string[];
  try {
    installedModels = await defaultProvider.listModelsStrict();
  } catch (err: unknown) {
    throw new Error(`Ollama is not reachable at ${config.ollamaBaseUrl}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (installedModels.length === 0) {
    throw new Error('Ollama is reachable but has no installed models.');
  }

  const suite = new ModelBenchmarkSuite({ thinkingMode: config.thinkingMode });
  const abort = new AbortController();
  process.once('SIGINT', () => abort.abort());

  const release = benchmarkGuard.tryAcquire('cli');
  if (!release) throw new Error('A benchmark is already running.');

  try {
    if (isAll) {
      console.log(`Running benchmark across ${installedModels.length} installed models: ${installedModels.join(', ')}\n`);
      const scorecards: ModelBenchmarkScorecard[] = [];

      for (const [index, m] of installedModels.entries()) {
        if (abort.signal.aborted) break;
        console.log(`[${index + 1}/${installedModels.length}] Benchmarking model: ${m} ...`);
        const provider = new OllamaProvider({ baseUrl: config.ollamaBaseUrl, model: m });
        const card = await suite.runBenchmark(provider, { signal: abort.signal });
        scorecards.push(card);
        console.log(ModelBenchmarkSuite.formatTerminalReport(card));
        console.log('');
      }

      console.log('\n==============================================================');
      console.log('                   BENCHMARK LEADERBOARD                      ');
      console.log('==============================================================');
      const scored = scorecards.filter((c) => c.status === 'complete' || c.status === 'partial');
      scored.sort((a, b) => b.overallScore - a.overallScore);
      scored.forEach((c, i) => {
        console.log(` #${i + 1} | ${c.modelName.padEnd(20)} | Score: ${c.overallScore}% (${c.grade}) | ${c.tokensPerSecSource === 'none' ? 'n/a' : `${c.decodeTokensPerSec} decode t/s`} | Best for: ${c.recommendedLanes.join(', ') || 'none'}`);
      });
      for (const c of scorecards.filter((x) => x.status === 'error' || x.status === 'aborted')) {
        console.log(` --  | ${c.modelName.padEnd(20)} | ${c.status.toUpperCase()}: ${c.error ?? ''}`);
      }
      console.log('==============================================================\n');
      return;
    }

    const modelToTest = targetModel ?? (installedModels.includes(config.defaultModel) ? config.defaultModel : installedModels[0]);
    if (!installedModels.includes(modelToTest)) {
      console.warn(`Note: ${modelToTest} is not in Ollama's installed list; the benchmark will report an error if it cannot be loaded.`);
    }
    console.log(`Benchmarking target model: ${modelToTest} ...`);
    const provider = new OllamaProvider({ baseUrl: config.ollamaBaseUrl, model: modelToTest });
    const card = await suite.runBenchmark(provider, { signal: abort.signal });

    console.log(ModelBenchmarkSuite.formatTerminalReport(card));
    if (card.status === 'complete') {
      console.log('\nBenchmark completed.\n');
    } else {
      console.log(`\nBenchmark finished with status ${card.status.toUpperCase()}.\n`);
      process.exitCode = 1;
    }
  } finally {
    release();
  }
}

main().catch((err) => {
  console.error('[BenchmarkCLI] Execution error:', err);
  process.exit(1);
});
