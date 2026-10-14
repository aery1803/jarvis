import dns from 'node:dns/promises';
import net from 'node:net';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;
const ALLOWED_CONTENT_TYPES = ['text/html', 'application/xhtml+xml', 'text/plain'];
const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.home.arpa'];

export interface FetchedPage {
  url: string;
  html: string;
  status: number;
  contentType: string;
  truncated: boolean;
}

export interface FetchPageOptions {
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

function isPrivateIpv4(address: string): boolean {
  const [a, b] = address.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

/** True for loopback, private, link-local, CGNAT, multicast and unspecified addresses (v4, v6 and v4-mapped v6). */
export function isPrivateAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family !== 6) return true;
  const lower = address.toLowerCase();
  const mapped = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isPrivateIpv4(mapped[1]);
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return isPrivateIpv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return lower === '::' || lower === '::1' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith('ff');
}

async function assertPublicHost(hostname: string, resolveHost: (hostname: string) => Promise<string[]>): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new PageFetchError(`Blocked host '${host}': local and internal hostnames are not fetched.`);
  }
  const addresses = net.isIP(host) ? [host] : await resolveHost(host);
  if (addresses.length === 0) throw new PageFetchError(`Host '${host}' did not resolve.`);
  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      throw new PageFetchError(`Blocked host '${host}': resolves to a private or loopback address.`);
    }
  }
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
  const fetchImpl = options.fetchImpl ?? fetch;
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
    if (current.username || current.password) throw new PageFetchError('Blocked URL: embedded credentials are not allowed.');
    await assertPublicHost(current.hostname, resolveHost);

    let response: Response;
    try {
      response = await fetchImpl(current.href, {
        redirect: 'manual',
        signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) JarvisLocal/1.0', Accept: 'text/html,application/xhtml+xml,text/plain' },
      });
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
