/**
 * Jarvis Local AI Agent: Web UI network access policy
 * Authority: FEAT-004, Principle 1 (private & local)
 *
 * The web UI has no login, and chat history and owner memory are readable through its API. It therefore
 * binds to loopback by default; binding to a LAN address is opt-in and requires an explicit allowlist of
 * client IPs or IPv4 CIDR ranges (for example the owner's second machine on the same network).
 */

import net from 'node:net';

/** Smallest IPv4 prefix accepted: anything broader than a /8 is almost certainly a typo for "everyone". */
const MIN_CIDR_PREFIX = 8;

export function normalizeAddress(address: string | undefined): string {
  if (!address) return '';
  const trimmed = address.trim().toLowerCase();
  return trimmed.startsWith('::ffff:') ? trimmed.slice('::ffff:'.length) : trimmed;
}

export function isLoopbackAddress(address: string | undefined): boolean {
  const normalized = normalizeAddress(address);
  return normalized === '::1' || normalized === 'localhost' || normalized.startsWith('127.');
}

function ipv4ToInt(address: string): number {
  return address.split('.').reduce((acc, octet) => acc * 256 + Number.parseInt(octet, 10), 0);
}

/** Returns an error message for an allowlist entry that can never match, or null when it is valid. */
export function validateAllowedEntry(entry: string): string | null {
  const slash = entry.indexOf('/');
  if (slash === -1) {
    return net.isIP(entry) !== 0 ? null : `"${entry}" is not an IP address`;
  }
  const base = entry.slice(0, slash);
  const prefixText = entry.slice(slash + 1);
  if (!net.isIPv4(base)) {
    return `"${entry}": only IPv4 CIDR ranges are supported`;
  }
  if (!/^\d{1,2}$/.test(prefixText)) {
    return `"${entry}": the prefix length must be a number`;
  }
  const prefix = Number.parseInt(prefixText, 10);
  if (prefix < MIN_CIDR_PREFIX || prefix > 32) {
    return `"${entry}": the prefix length must be between ${MIN_CIDR_PREFIX} and 32`;
  }
  return null;
}

/**
 * Parses a comma or space separated allowlist of IPs and IPv4 CIDR ranges.
 * Throws on an entry that could never match, so a typo fails at startup instead of silently locking the LAN out.
 */
export function parseAllowedIps(value: string | undefined): string[] {
  const entries = (value ?? '')
    .split(/[,\s]+/)
    .map(normalizeAddress)
    .filter((entry) => entry.length > 0);
  const problems = entries.map(validateAllowedEntry).filter((problem): problem is string => problem !== null);
  if (problems.length > 0) {
    throw new Error(`Invalid JARVIS_WEB_ALLOWED_IPS entries: ${problems.join('; ')}`);
  }
  return entries;
}

function matchesEntry(client: string, entry: string): boolean {
  const slash = entry.indexOf('/');
  if (slash === -1) return client === entry;
  if (validateAllowedEntry(entry) !== null || !net.isIPv4(client)) return false;
  const prefix = Number.parseInt(entry.slice(slash + 1), 10);
  const size = 2 ** (32 - prefix);
  const network = Math.floor(ipv4ToInt(entry.slice(0, slash)) / size);
  return Math.floor(ipv4ToInt(client) / size) === network;
}

export function isClientAllowed(remoteAddress: string | undefined, allowedIps: string[]): boolean {
  const normalized = normalizeAddress(remoteAddress);
  if (!normalized) return false;
  return isLoopbackAddress(normalized) || allowedIps.some((entry) => matchesEntry(normalized, normalizeAddress(entry)));
}

export function assertSafeBinding(host: string, allowedIps: string[]): void {
  const problems = allowedIps.map((entry) => validateAllowedEntry(normalizeAddress(entry))).filter((problem): problem is string => problem !== null);
  if (problems.length > 0) {
    throw new Error(`Invalid JARVIS_WEB_ALLOWED_IPS entries: ${problems.join('; ')}`);
  }
  if (!isLoopbackAddress(host) && allowedIps.length === 0) {
    throw new Error(
      `Refusing to bind the web UI to ${host} without an allowlist. Set JARVIS_WEB_ALLOWED_IPS to the LAN IPs ` +
        'or CIDR ranges that may connect (comma separated), or leave JARVIS_WEB_HOST unset to stay on 127.0.0.1.'
    );
  }
}

/** Splits a `Host` header into hostname and optional port; the hostname keeps no IPv6 brackets. */
function splitHostHeader(hostHeader: string): { hostname: string; port: string } | null {
  const match = hostHeader.trim().toLowerCase().match(/^(?:\[([^\]]+)\]|([^:/\s]+))(?::(\d{1,5}))?$/);
  if (!match) return null;
  return { hostname: match[1] ?? match[2], port: match[3] ?? '' };
}

/**
 * DNS-rebinding guard: a page on `evil.example` that re-points its name at the owner's LAN address still
 * sends `Host: evil.example`, so only loopback names, IP literals, the bind host and explicitly
 * configured origins are accepted as the server's own name.
 */
export function isHostHeaderAllowed(hostHeader: string | undefined, bindHost: string, allowedOrigins: string[]): boolean {
  if (!hostHeader) return false;
  const parsed = splitHostHeader(hostHeader);
  if (!parsed) return false;
  const { hostname } = parsed;
  if (hostname === 'localhost' || net.isIP(hostname) !== 0 || hostname === bindHost.toLowerCase()) return true;
  return allowedOrigins.some((origin) => {
    try {
      return new URL(origin).hostname.toLowerCase() === hostname;
    } catch {
      return false;
    }
  });
}

/** An `Origin` is the server's own when it names the same host:port as the request's `Host`, or is configured. */
export function isOriginAllowed(origin: string, hostHeader: string | undefined, allowedOrigins: string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (allowedOrigins.includes(parsed.origin)) return true;
  return hostHeader !== undefined && parsed.host.toLowerCase() === hostHeader.trim().toLowerCase();
}
