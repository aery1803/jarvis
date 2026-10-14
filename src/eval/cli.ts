/**
 * Jarvis Local AI Agent: Benchmark CLI Runner
 * Run comprehensive intelligence benchmarks against installed local or remote models.
 * Usage: npx tsx src/eval/cli.ts [--model <name>] [--all]
 */

import { ModelBenchmarkSuite } from './benchmark.js';
import { OllamaProvider } from '../services/provider.js';
import { config } from '../config.js';

async function main() {
  const args = process.argv.slice(2);
  const isAll = args.includes('--all');
  const modelIdx = args.indexOf('--model');
  const targetModel = modelIdx !== -1 ? args[modelIdx + 1] : undefined;

  console.log('\n==============================================================');
  console.log('       JARVIS LOCAL AI AGENT - MODEL INTELLIGENCE BENCHMARK    ');
  console.log('==============================================================\n');

  const defaultProvider = new OllamaProvider({ baseUrl: config.ollamaBaseUrl });
  const installedModels = await defaultProvider.listModels();

  const suite = new ModelBenchmarkSuite();

  if (isAll) {
    console.log(`Running benchmark across ${installedModels.length} installed models: ${installedModels.join(', ')}\n`);
    const scorecards = [];

    for (const m of installedModels) {
      console.log(`[1/1] Benchmarking model: ${m} ...`);
      const provider = new OllamaProvider({ baseUrl: config.ollamaBaseUrl, model: m });
      const card = await suite.runBenchmark(provider);
      scorecards.push(card);
      console.log(ModelBenchmarkSuite.formatTerminalReport(card));
      console.log('');
    }

    // Leaderboard Summary
    console.log('\n==============================================================');
    console.log('                   BENCHMARK LEADERBOARD                      ');
    console.log('==============================================================');
    scorecards.sort((a, b) => b.overallScore - a.overallScore);
    for (let i = 0; i < scorecards.length; i++) {
      const c = scorecards[i];
      console.log(` #${i + 1} | ${c.modelName.padEnd(20)} | Score: ${c.overallScore}% (${c.grade}) | ~${c.estimatedTokensPerSec} t/s | Best for: ${c.recommendedLanes.join(', ')}`);
    }
    console.log('==============================================================\n');
    return;
  }

  const modelToTest = targetModel || 'qwen2.5:7b';
  console.log(`Benchmarking target model: ${modelToTest} ...`);
  const provider = new OllamaProvider({ baseUrl: config.ollamaBaseUrl, model: modelToTest });
  const card = await suite.runBenchmark(provider);

  console.log(ModelBenchmarkSuite.formatTerminalReport(card));
  console.log('\nBenchmark completed successfully.\n');
}

main().catch((err) => {
  console.error('[BenchmarkCLI] Execution error:', err);
  process.exit(1);
});
