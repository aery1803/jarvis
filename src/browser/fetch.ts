import dns from 'node:dns/promises';
import { BlockedDestinationError, assertPublicDestination, isBlockedAddress, pinnedRequest } from '../security/ssrf.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;
const ALLOWED_CONTENT_TYPES = ['text/html', 'application/xhtml+xml', 'text/plain'];

export interface FetchedPage {
  url: string;
  html: string;
  status: number;
  contentType: string;
  truncated: boolean;
}

export interface FetchPageOptions {
  /** Replaces the pinned transport; tests only. Production leaves it unset so connections go to the validated address. */
  fetchImpl?: typeof fetch;
  /** Resolves a hostname to its addresses; injectable so tests need no DNS. */
  resolveHost?: (hostname: string) => Promise<string[]>;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

export class PageFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PageFetchError';
  }
}

/** True for loopback, private, link-local, CGNAT, multicast and unspecified addresses in every v4 and v6 encoding. */
export function isPrivateAddress(address: string): boolean {
  return isBlockedAddress(address);
}

async function readCapped(response: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: await response.text(), truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (total + value.byteLength > maxBytes) {
        chunks.push(value.subarray(0, maxBytes - total));
        total = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

/**
 * Fetches a public web page: http(s) only, no embedded credentials, every hop (including redirects) must
 * resolve to a public address, HTML/text content types only, bounded time and size.
 */
export async function fetchPageGuarded(rawUrl: string, options: FetchPageOptions = {}): Promise<FetchedPage> {
  const resolveHost = options.resolveHost ?? (async (host: string) => (await dns.lookup(host, { all: true })).map((entry) => entry.address));
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const signal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let current: URL;
  try {
    current = new URL(rawUrl);
  } catch {
    throw new PageFetchError(`Invalid URL '${rawUrl}'.`);
  }

  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (current.protocol !== 'http:' && current.protocol !== 'https:') {
      throw new PageFetchError(`Blocked scheme '${current.protocol}': only http and https are fetched.`);
    }
    let addresses: string[];
    try {
      // Resolved once per hop with every address checked; the request below connects only to these.
      addresses = await assertPublicDestination(current, resolveHost);
    } catch (err: unknown) {
      if (err instanceof BlockedDestinationError) throw new PageFetchError(`Blocked: ${err.message}`);
      throw new PageFetchError(`Could not resolve '${current.hostname}': ${err instanceof Error ? err.message : String(err)}`);
    }

    let response: Response;
    try {
      const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) JarvisLocal/1.0', Accept: 'text/html,application/xhtml+xml,text/plain' };
      response = options.fetchImpl
        ? await options.fetchImpl(current.href, { redirect: 'manual', signal, headers })
        : await pinnedRequest(current, { signal, headers }, addresses);
    } catch (err: unknown) {
      throw new PageFetchError(`Fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => undefined);
      if (!location) throw new PageFetchError(`HTTP ${response.status} redirect without a Location header.`);
      try {
        current = new URL(location, current);
      } catch {
        throw new PageFetchError(`Invalid redirect target '${location}'.`);
      }
      continue;
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new PageFetchError(`HTTP ${response.status}: ${response.statusText}`);
    }
    const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!ALLOWED_CONTENT_TYPES.includes(contentType)) {
      await response.body?.cancel().catch(() => undefined);
      throw new PageFetchError(`Unsupported content type '${contentType || 'unknown'}'.`);
    }
    const { text, truncated } = await readCapped(response, maxBytes);
    return { url: current.href, html: text, status: response.status, contentType, truncated };
  }
  throw new PageFetchError(`Too many redirects (more than ${maxRedirects}).`);
}
