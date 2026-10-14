/**
 * Jarvis Local AI Agent: SSRF guard shared by the page scraper and the browser fetch
 * Authority: Principle 2 (Taint Tracking), Section 10, Section 18.1
 *
 * One implementation of "is this destination public" and of "connect only to the address that was checked".
 * Checking a name and then letting `fetch()` resolve it again lets a TTL-0 domain answer a public address the
 * first time and 127.0.0.1 the second (DNS rebinding), so the transport here connects to the validated IP and
 * leaves the hostname alone only for the `Host` header and TLS SNI.
 */

import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { Readable, pipeline } from 'node:stream';

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.lan', '.home.arpa', '.intranet', '.corp'];

export class BlockedDestinationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockedDestinationError';
  }
}

export function parseIpv4(address: string): number[] | null {
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
    // NAT64 (64:ff9b::/96) and 6to4 (2002::/16) carry an IPv4 address that the gateway will connect to.
    if (words[0] === 0x64 && words[1] === 0xff9b && words.slice(2, 6).every((w) => w === 0)) return isBlockedIpv4(embedsV4());
    if (words[0] === 0x64 && words[1] === 0xff9b) return true;
    if (words[0] === 0x2002) return isBlockedIpv4([words[1] >> 8, words[1] & 0xff, words[2] >> 8, words[2] & 0xff]);
    // Teredo (2001::/32) tunnels to an obfuscated IPv4; site-local (fec0::/10) and the discard prefix (100::/64) are never public.
    if (words[0] === 0x2001 && words[1] === 0) return true;
    if ((words[0] & 0xffc0) === 0xfec0) return true;
    if (words[0] === 0x100 && words[1] === 0 && words[2] === 0 && words[3] === 0) return true;
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


export type HostResolver = (hostname: string) => Promise<string[]>;

/**
 * Validates scheme, credentials and hostname, resolves the name ONCE and checks EVERY address it returned.
 * The returned addresses are the only ones a connection may use; for an IP literal that is the literal itself.
 */
export async function assertPublicDestination(target: URL, resolveHost: HostResolver): Promise<string[]> {
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new BlockedDestinationError(`blocked scheme ${target.protocol}`);
  }
  if (target.username || target.password) {
    throw new BlockedDestinationError('blocked url with embedded credentials');
  }
  if (isBlockedHostname(target.hostname)) {
    throw new BlockedDestinationError(`blocked non-public (private, loopback or internal) host ${target.hostname}`);
  }
  const host = target.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (net.isIP(host)) return [host];
  const addresses = await resolveHost(host);
  if (addresses.length === 0) throw new BlockedDestinationError(`host ${host} did not resolve`);
  const blocked = addresses.find((address) => isBlockedAddress(address));
  if (blocked) throw new BlockedDestinationError(`blocked: ${host} resolves to a private or loopback, non-public address ${blocked}`);
  return addresses;
}

/**
 * A `net.connect` `lookup` that ignores the hostname and answers only with the already validated addresses. Each
 * is checked again here, so no code path can hand the socket an address that was not vetted.
 */
export function createPinnedLookup(addresses: string[], isBlocked: (address: string) => boolean = isBlockedAddress): net.LookupFunction {
  return (_hostname, options, callback) => {
    const wanted = typeof options === 'object' && options !== null ? options : {};
    const usable = addresses.filter((address) => !isBlocked(address) && (!wanted.family || wanted.family === net.isIP(address)));
    if (usable.length === 0) {
      callback(new BlockedDestinationError('no validated public address is available for this connection'), '', 4);
      return;
    }
    if (wanted.all) {
      (callback as unknown as (err: Error | null, all: Array<{ address: string; family: number }>) => void)(
        null,
        usable.map((address) => ({ address, family: net.isIP(address) }))
      );
      return;
    }
    callback(null, usable[0], net.isIP(usable[0]));
  };
}

export interface PinnedRequestInit {
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export interface PinnedRequestOptions {
  /** Tests that must reach a loopback server pass `() => false`; production never does. */
  isBlocked?: (address: string) => boolean;
}

const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/**
 * GETs `url` over `node:http(s)`, connecting only to `addresses`. The URL keeps its hostname, so `Host` and TLS
 * server name are the original ones. No redirect is followed and no connection is pooled (`agent: false`), so a
 * second request can never reuse a socket opened to a different address.
 */
export function pinnedRequest(rawUrl: string | URL, init: PinnedRequestInit, addresses: string[], options: PinnedRequestOptions = {}): Promise<Response> {
  const url = typeof rawUrl === 'string' ? new URL(rawUrl) : rawUrl;
  const client = url.protocol === 'https:' ? https : http;
  return new Promise<Response>((resolve, reject) => {
    const request = client.request(
      url,
      {
        method: 'GET',
        agent: false,
        lookup: createPinnedLookup(addresses, options.isBlocked),
        signal: init.signal,
        headers: { ...init.headers, 'Accept-Encoding': 'gzip, deflate, br' },
      },
      (res) => {
        const status = res.statusCode ?? 502;
        const headers = new Headers();
        const encoding = String(res.headers['content-encoding'] ?? '').toLowerCase().trim();
        const decoder = encoding === 'gzip' || encoding === 'x-gzip' ? zlib.createGunzip() : encoding === 'deflate' ? zlib.createInflate() : encoding === 'br' ? zlib.createBrotliDecompress() : null;
        for (const [name, value] of Object.entries(res.headers)) {
          if (value === undefined || (decoder && (name === 'content-encoding' || name === 'content-length'))) continue;
          if (Array.isArray(value)) value.forEach((entry) => headers.append(name, entry));
          else headers.set(name, value);
        }
        if (NULL_BODY_STATUSES.has(status)) {
          res.destroy();
          resolve(new Response(null, { status, statusText: res.statusMessage, headers }));
          return;
        }
        let body: Readable = res;
        if (decoder) {
          pipeline(res, decoder, () => undefined);
          body = decoder;
        }
        resolve(new Response(Readable.toWeb(body) as unknown as ReadableStream<Uint8Array>, { status, statusText: res.statusMessage, headers }));
      }
    );
    request.on('error', reject);
    request.end();
  });
}
