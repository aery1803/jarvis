/**
 * Jarvis Local AI Agent: Web Scraper & Taint-Tracking Content Distiller
 * Authority: Principle 2 (Taint Tracking), Section 10, Section 18.1
 */

import dns from 'node:dns';
import { logger } from '../utils/logger.js';
import type { SearchResult } from './searxng.js';
import { assertPublicDestination, isBlockedAddress, isBlockedHostname, pinnedRequest, type HostResolver } from '../security/ssrf.js';

export { isBlockedAddress, isBlockedHostname, type HostResolver };

export type ContentOrigin = 'page' | 'snippet' | 'unavailable';

export interface ExtractedContent {
  content: string;
  url: string;
  isUntrusted: true;
  extractedAt: string;
  /** `page` = fetched and extracted, `snippet` = search-engine snippet used as plain text, `unavailable` = nothing retrievable. */
  origin?: ContentOrigin;
  title?: string;
  truncated?: boolean;
  /** Why the page could not be fetched (set on `snippet` fallbacks and `unavailable`). */
  error?: string;
}

// Patterns commonly used in prompt injection payloads
const PROMPT_INJECTION_PATTERNS = [
  /system\s+override\s*:/gi,
  /ignore\s+(all\s+)?(the\s+)?(previous|prior|above)\s+(instructions|prompts?)/gi,
  /disregard\s+(all\s+)?(the\s+)?(previous|prior|above)\s+(instructions|prompts?)/gi,
  /you\s+are\s+now\s+an?\s+unrestricted/gi,
  /jailbreak\s+mode/gi,
  /output\s+your\s+(api\s+)?(token|key|secret)/gi,
  /<\/?\s*untrusted_data\s*>/gi,
];

const DEFAULT_MAX_BYTES = 512 * 1024;
const DEFAULT_MAX_CHARS = 12_000;
const DEFAULT_MAX_REDIRECTS = 4;
const DEFAULT_TIMEOUT_MS = 7_000;
const ALLOWED_CONTENT_TYPES = ['text/html', 'application/xhtml+xml', 'text/plain'];

export interface ContentDistillerOptions {
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Injectable DNS resolver returning every address a hostname maps to. */
  resolveHost?: HostResolver;
  maxBytes?: number;
  maxChars?: number;
  maxRedirects?: number;
}

export interface FetchTopResultsOptions {
  /** How many of the leading results to fetch (default 3). */
  limit?: number;
  /** Concurrent page fetches (default 3). */
  concurrency?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const defaultResolveHost: HostResolver = async (hostname) => {
  const records = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => r.address);
};

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&mdash;/g, '-')
    .replace(/&ndash;/g, '-')
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&');
}

function safeCodePoint(code: number): string {
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : ' ';
}

function normalizeWhitespace(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v ]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

function cap(text: string, maxChars: number): { text: string; truncated: boolean } {
  return text.length > maxChars ? { text: text.slice(0, maxChars), truncated: true } : { text, truncated: false };
}

function stripBlocks(html: string, tags: string[]): string {
  let out = html;
  for (const tag of tags) {
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), ' ');
  }
  return out;
}

function firstBlock(html: string, tag: string): string | null {
  const match = html.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, 'i'));
  return match ? match[1] : null;
}

export class ContentDistiller {
  /** Null in production: requests then go through `pinnedRequest`, which connects to the checked address. */
  private injectedFetch: typeof fetch | null;
  private resolveHost: HostResolver;
  private maxBytes: number;
  private maxChars: number;
  private maxRedirects: number;

  constructor(options: ContentDistillerOptions = {}) {
    this.injectedFetch = options.fetchImpl ?? null;
    this.resolveHost = options.resolveHost ?? defaultResolveHost;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
    this.maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  }

  /**
   * Sanitizes text to neutralize potential prompt injection vectors.
   */
  public sanitizeForContext(rawText: string): string {
    let sanitized = rawText;
    for (const pattern of PROMPT_INJECTION_PATTERNS) {
      sanitized = sanitized.replace(pattern, '[FLAGGED_INJECTION_PATTERN]');
    }
    return sanitized;
  }

  /**
   * Extracts clean, readable text from raw HTML: drops scripts/styles/comments and page chrome (nav, header, footer,
   * aside, forms), prefers the `<article>` or `<main>` body when there is one, and decodes entities.
   * Principle 2: Marks result with isUntrusted: true (Taint Tracking).
   */
  public extractText(html: string, url: string): ExtractedContent {
    const title = firstBlock(html, 'title');
    let body = html.replace(/<!--[\s\S]*?-->/g, ' ');
    body = stripBlocks(body, ['script', 'style', 'noscript', 'iframe', 'template', 'svg', 'head', 'object', 'embed']);
    const chromeStripped = stripBlocks(body, ['nav', 'header', 'footer', 'aside', 'form']);

    const main = firstBlock(chromeStripped, 'article') ?? firstBlock(chromeStripped, 'main');
    const mainText = main ? this.htmlToText(main) : '';
    let text = mainText.length >= 200 ? mainText : this.htmlToText(chromeStripped);
    if (text.length === 0) text = this.htmlToText(body);

    const capped = cap(this.sanitizeForContext(text), this.maxChars);
    return {
      content: capped.text,
      url,
      isUntrusted: true, // Principle 2 Law
      extractedAt: new Date().toISOString(),
      origin: 'page',
      title: title ? this.sanitizeForContext(normalizeWhitespace(decodeEntities(title.replace(/<[^>]+>/g, ' ')))).slice(0, 300) : undefined,
      truncated: capped.truncated || undefined,
    };
  }

  /**
   * Treats `text` as plain text (a search snippet, a `text/plain` body): no tag stripping, so `a < b` survives.
   */
  public extractPlainText(text: string, url: string): ExtractedContent {
    const capped = cap(this.sanitizeForContext(normalizeWhitespace(text.replace(/\r\n?/g, '\n'))), this.maxChars);
    return {
      content: capped.text,
      url,
      isUntrusted: true,
      extractedAt: new Date().toISOString(),
      origin: 'snippet',
      truncated: capped.truncated || undefined,
    };
  }

  private htmlToText(html: string): string {
    const withBreaks = html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li|tr|section|article|blockquote|pre|table|ul|ol|dd|dt)\s*>/gi, '\n')
      .replace(/<(td|th)\b[^>]*>/gi, ' ');
    return normalizeWhitespace(decodeEntities(withBreaks.replace(/<[^>]+>/g, ' ')));
  }

  /**
   * Fetches an external webpage and distills readable text. Never throws: failure yields `origin: 'unavailable'`
   * with empty content and an `error`. Only http(s) is allowed; loopback, private, link-local and cloud-metadata
   * destinations (by literal address or DNS resolution, re-checked on every redirect hop) are refused.
   */
  public async fetchAndExtract(url: string, timeoutMs: number = DEFAULT_TIMEOUT_MS, signal?: AbortSignal): Promise<ExtractedContent> {
    const deadline = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      const { text, finalUrl, contentType, truncated } = await this.fetchText(url, combined);
      const extracted = /text\/plain/i.test(contentType) ? this.extractPlainText(text, finalUrl) : this.extractText(text, finalUrl);
      extracted.origin = 'page';
      if (truncated) extracted.truncated = true;
      if (extracted.content.length === 0) {
        return this.unavailable(url, 'page contained no readable text');
      }
      return extracted;
    } catch (err: unknown) {
      const reason = errMessage(err);
      logger.warn(`[ContentDistiller] Failed to fetch ${url}: ${reason}`);
      return this.unavailable(url, reason);
    }
  }

  /**
   * Fetches the pages behind the top search results (default 3, concurrency 3). A result whose page cannot be
   * fetched falls back to its snippet, treated as plain text. Output order matches input order; every item is untrusted.
   */
  public async fetchTopResults(results: SearchResult[], options: FetchTopResultsOptions = {}): Promise<ExtractedContent[]> {
    const selected = results.slice(0, options.limit ?? 3);
    const concurrency = Math.max(1, Math.min(options.concurrency ?? 3, selected.length || 1));
    const output: ExtractedContent[] = new Array(selected.length);
    let next = 0;

    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next++;
        if (index >= selected.length) return;
        const result = selected[index];
        const page = await this.fetchAndExtract(result.url, options.timeoutMs ?? DEFAULT_TIMEOUT_MS, options.signal);
        if (page.origin === 'page') {
          output[index] = { ...page, title: page.title ?? result.title };
          continue;
        }
        const snippet = this.extractPlainText(result.snippet ?? '', result.url);
        snippet.title = result.title;
        snippet.error = page.error;
        if (snippet.content.length === 0) snippet.origin = 'unavailable';
        output[index] = snippet;
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return output;
  }

  private unavailable(url: string, error: string): ExtractedContent {
    return { content: '', url, isUntrusted: true, extractedAt: new Date().toISOString(), origin: 'unavailable', error };
  }

  private async fetchText(
    startUrl: string,
    signal: AbortSignal
  ): Promise<{ text: string; finalUrl: string; contentType: string; truncated: boolean }> {
    let current: URL;
    try {
      current = new URL(startUrl);
    } catch {
      throw new Error('invalid url');
    }

    for (let hop = 0; hop <= this.maxRedirects; hop++) {
      // Resolved and validated once per hop (redirects included); the request below may only connect to these.
      const addresses = await assertPublicDestination(current, this.resolveHost);
      const headers = { 'User-Agent': 'JarvisLocal/1.0', Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9' };
      const response = this.injectedFetch
        ? await this.injectedFetch(current.toString(), { signal, redirect: 'manual', credentials: 'omit', headers })
        : await pinnedRequest(current, { signal, headers }, addresses);

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => undefined);
        if (!location) throw new Error(`HTTP ${response.status} redirect without a Location header`);
        current = new URL(location, current);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const contentType = response.headers.get('content-type') ?? '';
      const mime = contentType.split(';')[0].trim().toLowerCase();
      if (!ALLOWED_CONTENT_TYPES.includes(mime)) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`unsupported content-type '${mime || 'unknown'}'`);
      }

      const { bytes, truncated } = await this.readCapped(response);
      return { text: this.decode(bytes, contentType), finalUrl: current.toString(), contentType: mime, truncated };
    }
    throw new Error(`too many redirects (more than ${this.maxRedirects})`);
  }

  private async readCapped(response: Response): Promise<{ bytes: Uint8Array; truncated: boolean }> {
    if (!response.body) {
      const all = new Uint8Array(await response.arrayBuffer());
      return all.length > this.maxBytes ? { bytes: all.subarray(0, this.maxBytes), truncated: true } : { bytes: all, truncated: false };
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const room = this.maxBytes - total;
        if (value.length > room) {
          chunks.push(value.subarray(0, room));
          total += room;
          truncated = true;
          break;
        }
        chunks.push(value);
        total += value.length;
        if (total >= this.maxBytes) {
          truncated = true;
          break;
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return { bytes, truncated };
  }

  private decode(bytes: Uint8Array, contentType: string): string {
    const charset = contentType.match(/charset=["']?([\w-]+)/i)?.[1] ?? 'utf-8';
    try {
      return new TextDecoder(charset).decode(bytes);
    } catch {
      return new TextDecoder('utf-8').decode(bytes);
    }
  }
}
