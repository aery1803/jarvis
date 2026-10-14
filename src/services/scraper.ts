/**
 * Jarvis Local AI Agent: Web Scraper & Taint-Tracking Content Distiller
 * Authority: Principle 2 (Taint Tracking), Section 10, Section 18.1
 */

import dns from 'node:dns';
import net from 'node:net';
import { logger } from '../utils/logger.js';
import type { SearchResult } from './searxng.js';

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
const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.lan', '.home.arpa', '.intranet', '.corp'];

export type HostResolver = (hostname: string) => Promise<string[]>;

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

function parseIpv4(address: string): number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return octets.every((o) => o >= 0 && o <= 255) ? octets : null;
}

function isBlockedIpv4(octets: number[]): boolean {
  const [a, b, c] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  return a >= 224;
}

function expandIpv6(address: string): number[] | null {
  let text = address.toLowerCase();
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);
  const v4Tail = text.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4Tail) {
    const octets = parseIpv4(v4Tail[1]);
    if (!octets) return null;
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    text = text.slice(0, text.length - v4Tail[1].length) + `${hi}:${lo}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 0) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  const words = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return words.length === 8 && words.every((w) => !Number.isNaN(w)) ? words : null;
}

/** True for loopback, private, link-local (incl. cloud metadata 169.254.169.254), CGNAT, multicast and unspecified addresses. */
export function isBlockedAddress(address: string): boolean {
  const kind = net.isIP(address);
  if (kind === 4) {
    const octets = parseIpv4(address);
    return octets === null || isBlockedIpv4(octets);
  }
  if (kind === 6) {
    const words = expandIpv6(address);
    if (!words) return true;
    const embedsV4 = (): number[] => [words[6] >> 8, words[6] & 0xff, words[7] >> 8, words[7] & 0xff];
    if (words.slice(0, 5).every((w) => w === 0) && (words[5] === 0xffff || words[5] === 0)) {
      // ::, ::1, IPv4-mapped (::ffff:a.b.c.d) and deprecated IPv4-compatible forms
      return words.slice(0, 7).every((w) => w === 0) || isBlockedIpv4(embedsV4());
    }
    if (words[0] === 0x64 && words[1] === 0xff9b) return isBlockedIpv4(embedsV4());
    if ((words[0] & 0xffc0) === 0xfe80) return true;
    if ((words[0] & 0xfe00) === 0xfc00) return true;
    if ((words[0] & 0xff00) === 0xff00) return true;
    return false;
  }
  return true;
}

export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return true;
  if (net.isIP(host)) return isBlockedAddress(host);
  if (host === 'localhost' || !host.includes('.')) return true;
  return BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

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
  private fetchImpl: typeof fetch;
  private resolveHost: HostResolver;
  private maxBytes: number;
  private maxChars: number;
  private maxRedirects: number;

  constructor(options: ContentDistillerOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
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

  private async assertPublicDestination(target: URL): Promise<void> {
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      throw new Error(`blocked scheme ${target.protocol}`);
    }
    if (target.username || target.password) {
      throw new Error('blocked url with embedded credentials');
    }
    if (isBlockedHostname(target.hostname)) {
      throw new Error(`blocked non-public host ${target.hostname}`);
    }
    const host = target.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host)) return;
    const addresses = await this.resolveHost(host);
    if (addresses.length === 0) throw new Error(`host ${host} did not resolve`);
    const blocked = addresses.find((a) => isBlockedAddress(a));
    if (blocked) throw new Error(`blocked: ${host} resolves to non-public address ${blocked}`);
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
      await this.assertPublicDestination(current);
      const response = await this.fetchImpl(current.toString(), {
        signal,
        redirect: 'manual',
        credentials: 'omit',
        headers: { 'User-Agent': 'JarvisLocal/1.0', Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9' },
      });

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
