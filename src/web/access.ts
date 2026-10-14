/**
 * Jarvis Local AI Agent: Web UI network access policy
 * Authority: FEAT-004, Principle 1 (private & local)
 *
 * The web UI has no login, and chat history and owner memory are readable through its API. It therefore
 * binds to loopback by default; binding to a LAN address is opt-in and requires an explicit allowlist of
 * client IPs (for example the owner's second machine on the same network).
 */

export function normalizeAddress(address: string | undefined): string {
  if (!address) return '';
  const trimmed = address.trim().toLowerCase();
  return trimmed.startsWith('::ffff:') ? trimmed.slice('::ffff:'.length) : trimmed;
}

export function isLoopbackAddress(address: string | undefined): boolean {
  const normalized = normalizeAddress(address);
  return normalized === '::1' || normalized === 'localhost' || normalized.startsWith('127.');
}

export function parseAllowedIps(value: string | undefined): string[] {
  return (value ?? '')
    .split(/[,\s]+/)
    .map(normalizeAddress)
    .filter((ip) => ip.length > 0);
}

export function isClientAllowed(remoteAddress: string | undefined, allowedIps: string[]): boolean {
  const normalized = normalizeAddress(remoteAddress);
  if (!normalized) return false;
  return isLoopbackAddress(normalized) || allowedIps.includes(normalized);
}

export function assertSafeBinding(host: string, allowedIps: string[]): void {
  if (!isLoopbackAddress(host) && allowedIps.length === 0) {
    throw new Error(
      `Refusing to bind the web UI to ${host} without an allowlist. Set JARVIS_WEB_ALLOWED_IPS to the LAN IPs ` +
        'that may connect (comma separated), or leave JARVIS_WEB_HOST unset to stay on 127.0.0.1.'
    );
  }
}
