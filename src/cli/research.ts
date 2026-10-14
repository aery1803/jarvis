/**
 * Jarvis Local AI Agent: Interactive Research Synthesizer CLI
 * Authority: Section 10 (Research & Fact-Check Skill), Section 18.1
 */

import path from 'node:path';
import { SearXNGClient } from '../services/searxng.js';
import { ContentDistiller } from '../services/scraper.js';
import { ConsensusEngine } from '../services/consensus.js';
import { CognitionEngine } from '../agents/cognition.js';
import { OllamaProvider } from '../services/provider.js';
import { DocumentStore } from '../storage/collection.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import { resolveThink } from '../services/thinking-control.js';
import { LIVE_SEARCH_NOTICE } from '../chat/research.js';

interface ResearchSessionDoc {
  id?: string;
  query: string;
  synthesizedAnswer: string;
  /** Null when no two independent sources existed to agree with each other. */
  confidenceScore: number | null;
  sources: string[];
  createdAt: string;
}

export async function runResearch(query: string): Promise<ResearchSessionDoc> {
  logger.info(`[ResearchCLI] Starting deep research on: "${query}"`);

  // 1. Initialize Document Store (MongoDB-style Collection over SQLite)
  const dbPath = path.join(process.cwd(), 'data', 'research.db');
  const store = new DocumentStore(dbPath);
  const sessions = store.collection<ResearchSessionDoc>('sessions');

  // 2. Metasearch via SearXNG. `enableFallback: true` makes an unreachable engine come back as `source: 'none'`
  // with a reason instead of an exception; the live DuckDuckGo fallback follows `searchLiveFallback` (on unless JARVIS_SEARCH_LIVE_FALLBACK=0).
  const searchClient = new SearXNGClient({
    baseUrl: config.searxngBaseUrl,
    enableFallback: true,
    enableLiveFallback: config.searchLiveFallback,
  });

  const outcome = await searchClient.searchDetailed(query, { maxResults: 3 });
  if (outcome.source === 'none' || outcome.results.length === 0) {
    store.close();
    throw new Error(outcome.unavailableReason ?? 'The search engine returned no results, so there is nothing to synthesize from.');
  }
  logger.info(`[ResearchCLI] Found ${outcome.results.length} search results via ${outcome.source}`);
  if (outcome.source === 'duckduckgo-live') logger.warn(`[ResearchCLI] ${LIVE_SEARCH_NOTICE}`);

  // 3. Fetch & distill the real pages (snippet fallback per result), with taint tracking
  const distiller = new ContentDistiller();
  const pages = await distiller.fetchTopResults(outcome.results, { limit: 3 });
  const distilledSources = pages.filter((page) => page.content && page.origin !== 'unavailable');
  if (distilledSources.length === 0) {
    store.close();
    throw new Error(`None of the ${pages.length} result pages could be read: ${pages[0]?.error ?? 'no content'}`);
  }

  // 4. Corroborate Consensus & Score Confidence
  const consensusEngine = new ConsensusEngine();
  const claimsData = [
    {
      claim: `Verified facts regarding ${query}`,
      sources: distilledSources.map((s) => ({
        source: s.url,
        excerpt: s.content,
      })),
    },
  ];

  const consensusReport = consensusEngine.buildReport(claimsData);
  const corroborated = consensusReport.evaluations.some((evaluation) => evaluation.insufficientSources === undefined);
  logger.info(`[ResearchCLI] Consensus Score: ${consensusReport.overallScore} (${consensusReport.summary})`);

  // 5. Synthesize with Local LLM
  const provider = new OllamaProvider({
    baseUrl: config.ollamaBaseUrl,
    model: config.defaultModel,
  });

  let synthesis = '';
  const prompt = CognitionEngine.formatPrompt(query, {
    taskType: 'research',
    researchFacts: distilledSources.map((s, i) => `[Source ${i + 1}] (${s.url}) [${s.origin}]\n${s.content}`).join('\n\n'),
    consensusScore: corroborated ? consensusReport.overallScore : undefined,
    activeModel: config.defaultModel,
  });

  try {
    synthesis = await provider.generate(prompt, { maxTokens: 512, think: resolveThink(config.thinkingMode, config.defaultModel) });
  } catch (err: unknown) {
    store.close();
    throw new Error(`Local model ${config.defaultModel} could not synthesize an answer: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 6. Save in MongoDB-style Collection
  const sessionRecord: ResearchSessionDoc = {
    query,
    synthesizedAnswer: synthesis,
    confidenceScore: corroborated ? consensusReport.overallScore : null,
    sources: distilledSources.map((s) => s.url),
    createdAt: new Date().toISOString(),
  };

  const saved = sessions.insertUnique(sessionRecord);
  store.close();

  return saved;
}

// CLI entry point
if (process.argv[1] && process.argv[1].endsWith('research.ts')) {
  const query = process.argv.slice(2).join(' ') || 'AMD Radeon 8060S UMA memory architecture';

  console.log('\n======================================================');
  console.log('       JARVIS LOCAL AI AGENT - RESEARCH PIPELINE       ');
  console.log('======================================================\n');

  runResearch(query)
    .then((result) => {
      console.log(`\n📌 Query: "${result.query}"`);
      console.log(result.confidenceScore === null ? '🎯 Source agreement: single source, not corroborated.' : `🎯 Source agreement: ${Math.round(result.confidenceScore * 100)}%`);
      console.log(`\n📝 Synthesized Answer:\n${result.synthesizedAnswer}\n`);
      console.log(`📚 Cited Sources:`);
      for (const src of result.sources) {
        console.log(` - ${src}`);
      }
      console.log('\n✅ Research session saved to SQLite document store.');
    })
    .catch((err) => {
      console.error(`Fatal error: ${err.message}`);
      process.exit(1);
    });
}
