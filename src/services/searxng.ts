/**
 * Jarvis Local AI Agent: SearXNG Search Service
 * Authority: Section 10, Section 18.1
 */

import { logger } from '../utils/logger.js';
import { config } from '../config.js';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  engine?: string;
}

export type SearchSource = 'searxng' | 'duckduckgo-live' | 'none';

/** Typed outcome of a search: `results` is empty with `source: 'none'` and an `unavailableReason` when no engine could be reached. */
export interface SearchOutcome {
  results: SearchResult[];
  source: SearchSource;
  searxngError?: string;
  liveError?: string;
  unavailableReason?: string;
}

export interface SearXNGClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  /** When false, a SearXNG failure throws instead of trying the live fallback. */
  enableFallback?: boolean;
  /**
   * Allows the live DuckDuckGo fallback, which sends the query text to html.duckduckgo.com.
   * Defaults to the owner's `config.searchLiveFallback` (`JARVIS_SEARCH_LIVE_FALLBACK`, off unless set).
   */
  enableLiveFallback?: boolean;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

const LIVE_FALLBACK_ENGINE = 'duckduckgo-live';
const MAX_QUERY_CHARS = 300;

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

function asHttpUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export class SearXNGClient {
  private baseUrl: string;
  private timeoutMs: number;
  private enableFallback: boolean;
  private enableLiveFallback: boolean;
  private fetchImpl: typeof fetch;

  constructor(options: SearXNGClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? 'http://127.0.0.1:8080';
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.enableFallback = options.enableFallback ?? true;
    this.enableLiveFallback = options.enableLiveFallback ?? config.searchLiveFallback;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  public parseResults(raw: any): SearchResult[] {
    if (!raw || !Array.isArray(raw.results)) {
      return [];
    }

    const parsed: SearchResult[] = [];
    for (const item of raw.results) {
      const url = typeof item?.url === 'string' ? asHttpUrl(item.url) : null;
      if (!url) continue;
      parsed.push({
        title: typeof item.title === 'string' && item.title ? item.title : 'Untitled',
        url,
        snippet: item.content ?? item.snippet ?? '',
        engine: item.engine ?? undefined,
      });
    }
    return parsed;
  }

  /** Returns `[]` when no engine is reachable; use `searchDetailed` to learn why. Throws only when `enableFallback` is false. */
  public async search(query: string, options: { maxResults?: number } = {}): Promise<SearchResult[]> {
    return (await this.searchDetailed(query, options)).results;
  }

  public async searchDetailed(query: string, options: { maxResults?: number } = {}): Promise<SearchOutcome> {
    const max = options.maxResults ?? 5;

    try {
      const results = await this.searchSearxng(query, max);
      return { results, source: 'searxng' };
    } catch (err: unknown) {
      const searxngError = errMessage(err);
      logger.warn(`[SearXNGClient] Search request failed (${searxngError}).`);

      if (!this.enableFallback) {
        throw err;
      }

      if (!this.enableLiveFallback) {
        return {
          results: [],
          source: 'none',
          searxngError,
          unavailableReason: `SearXNG is unreachable (${searxngError}) and the live web fallback is disabled.`,
        };
      }

      try {
        const live = await this.searchLiveWeb(query, max);
        if (live.length > 0) {
          logger.info(`[SearXNGClient] SearXNG unavailable; using ${live.length} live DuckDuckGo results.`);
          return { results: live, source: 'duckduckgo-live', searxngError };
        }
        return {
          results: [],
          source: 'none',
          searxngError,
          unavailableReason: `SearXNG is unreachable (${searxngError}) and the live fallback returned no results.`,
        };
      } catch (liveErr: unknown) {
        const liveError = errMessage(liveErr);
        logger.warn(`[SearXNGClient] Live web search failed (${liveError}).`);
        return {
          results: [],
          source: 'none',
          searxngError,
          liveError,
          unavailableReason: `No search engine reachable: SearXNG (${searxngError}); live fallback (${liveError}).`,
        };
      }
    }
  }

  private async searchSearxng(query: string, max: number): Promise<SearchResult[]> {
    const searchUrl = `${this.baseUrl}/search?q=${encodeURIComponent(query)}&format=json`;
    const response = await this.fetchImpl(searchUrl, {
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`SearXNG returned HTTP ${response.status}: ${response.statusText}`);
    }

    return this.parseResults(await response.json()).slice(0, max);
  }

  /**
   * Live DuckDuckGo HTML search. Sends only the query string (whitespace-collapsed and length-capped), no cookies and
   * no spoofed browser identity. Every result is labelled `duckduckgo-live`.
   */
  public async searchLiveWeb(query: string, max = 5): Promise<SearchResult[]> {
    const q = query.replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY_CHARS);
    if (!q) return [];

    const response = await this.fetchImpl(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, {
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: { 'User-Agent': 'JarvisLocal/1.0', Accept: 'text/html' },
      credentials: 'omit',
    });

    if (!response.ok) {
      throw new Error(`Live web returned HTTP ${response.status}`);
    }

    const html = await response.text();
    const results: SearchResult[] = [];

    for (const block of html.split('<div class="result results_links').slice(1)) {
      if (block.includes('result--ad')) continue;

      const titleMatch = block.match(/<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
      const snippetMatch = block.match(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
      if (!titleMatch || !snippetMatch) continue;

      const href = decodeEntities(titleMatch[1]);
      let target = href;
      try {
        const redirect = new URL(href, 'https://duckduckgo.com');
        const uddg = redirect.searchParams.get('uddg');
        if (uddg) target = uddg;
        else target = redirect.toString();
      } catch {
        continue;
      }
      const url = asHttpUrl(target);
      if (!url) continue;

      results.push({
        title: stripTags(titleMatch[2]),
        url,
        snippet: stripTags(snippetMatch[1]),
        engine: LIVE_FALLBACK_ENGINE,
      });
      if (results.length >= max) break;
    }

    return results;
  }
}
