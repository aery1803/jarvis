/**
 * Jarvis Local AI Agent: Chat Research Step
 * Authority: Section 10 (Research & Fact-Check Skill), Principle 2 (taint tracking)
 *
 * Searches, fetches the real pages, scores source agreement, and saves good pages as T4 knowledge. Everything
 * it returns as `facts` is untrusted web text: the caller hands it to `CognitionEngine.formatPrompt` as
 * `researchFacts`, which fences it. When no search engine is reachable the result says so and carries no facts.
 */

import type { JarvisRuntime } from '../runtime/runtime.js';
import type { SearchOutcome } from '../services/searxng.js';
import { logger } from '../utils/logger.js';

const LOOKUP_PATTERN = /\b(search(?:\s+for)?|look\s?up|research|latest|news|current(?:ly)?|today'?s|release\s+date|price\s+of)\b/i;

/** Tells the owner where the query went; only the query text is sent to DuckDuckGo. */
export const LIVE_SEARCH_NOTICE = 'SearXNG unreachable; used DuckDuckGo live search (only your query was sent).';

const SEARCH_RESULTS = 5;
const PAGES_TO_FETCH = 3;

/**
 * Whether a prompt goes to the internet. An explicit toggle always wins; only when the client sent no
 * preference does a conservative word-boundary heuristic decide.
 */
export function shouldResearchPrompt(prompt: string, useResearch: boolean | undefined): boolean {
  if (useResearch !== undefined) return useResearch;
  return LOOKUP_PATTERN.test(prompt);
}

export interface ResearchOutcome {
  /** Raw untrusted page and snippet text with `[Source N]` labels; empty when nothing usable was found. */
  facts: string;
  /** Source agreement 0..1 from the consensus engine; undefined without usable sources or with nothing to compare (one source). */
  consensusScore?: number;
  /** URLs of the sources whose text is in `facts`. */
  sources: string[];
  /** Which engine answered, or `none` when none could. */
  engine: 'searxng' | 'duckduckgo-live' | 'none';
  unavailableReason?: string;
}

export type ResearchRuntime = Pick<JarvisRuntime, 'search' | 'distiller' | 'consensus' | 'memory'>;

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url.slice(0, 80);
  }
}

export async function gatherResearch(
  rt: ResearchRuntime,
  args: { userId: string; prompt: string; signal?: AbortSignal; status: (text: string) => Promise<void> }
): Promise<ResearchOutcome> {
  await args.status('Searching the web...');

  let outcome: SearchOutcome;
  try {
    outcome = await rt.search.searchDetailed(args.prompt, { maxResults: SEARCH_RESULTS });
  } catch (err: unknown) {
    const reason = `The search engine failed: ${err instanceof Error ? err.message : String(err)}`;
    await args.status(`Web search is unavailable (${reason}). Answering without web sources.`);
    return { facts: '', sources: [], engine: 'none', unavailableReason: reason };
  }

  if (outcome.source === 'none') {
    const reason = outcome.unavailableReason ?? 'no search engine could be reached';
    await args.status(`Web search is unavailable (${reason}). Answering without web sources.`);
    return { facts: '', sources: [], engine: 'none', unavailableReason: reason };
  }
  if (outcome.results.length === 0) {
    await args.status('The web search returned no results. Answering without web sources.');
    return { facts: '', sources: [], engine: outcome.source };
  }

  if (outcome.source === 'duckduckgo-live') {
    await args.status(LIVE_SEARCH_NOTICE);
  }

  const pages = await rt.distiller.fetchTopResults(outcome.results, { limit: PAGES_TO_FETCH, signal: args.signal });
  const usable = pages.filter((page) => page.content.trim() !== '' && page.origin !== 'unavailable');
  if (usable.length === 0) {
    const why = pages.find((page) => page.error)?.error ?? 'no readable text';
    await args.status(`Found ${outcome.results.length} results but none could be read (${why}). Answering without web sources.`);
    return { facts: '', sources: [], engine: outcome.source };
  }

  const facts = usable.map((page, index) => `[Source ${index + 1}] (${page.url}) [${page.origin ?? 'page'}]\n${page.content}`).join('\n\n');
  const evaluation = rt.consensus.evaluateClaim(
    args.prompt,
    usable.map((page) => ({ source: page.url, excerpt: page.content }))
  );

  const snippetOnly = usable.filter((page) => page.origin === 'snippet').length;
  // One source (or several from one origin) has nothing to agree with, so no percentage is shown or handed to the model.
  const corroboration =
    evaluation.insufficientSources === undefined
      ? `source agreement ${(evaluation.confidence * 100).toFixed(0)}% (${evaluation.status.toLowerCase()}, ${evaluation.independentSources ?? 0} independent).`
      : evaluation.insufficientSources === 'same_origin'
        ? 'all from one origin, so not corroborated.'
        : 'single source, not corroborated.';
  await args.status(
    `Read ${usable.length} source${usable.length === 1 ? '' : 's'}${snippetOnly > 0 ? ` (${snippetOnly} search snippet${snippetOnly === 1 ? '' : 's'} only)` : ''}; ${corroboration}`
  );

  // Only fully fetched pages are worth keeping; a snippet is too thin to answer from later.
  for (const page of usable) {
    if (page.origin !== 'page') continue;
    try {
      await rt.memory.saveResearchKnowledge({
        userId: args.userId,
        title: page.title ?? hostnameOf(page.url),
        content: page.content,
        sourceUrl: page.url,
        tags: ['research', hostnameOf(page.url)],
      });
    } catch (err: unknown) {
      logger.warn(`[ChatResearch] Could not save ${page.url} as knowledge: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    facts,
    ...(evaluation.insufficientSources === undefined ? { consensusScore: evaluation.confidence } : {}),
    sources: Array.from(new Set(usable.map((page) => page.url))),
    engine: outcome.source,
  };
}
