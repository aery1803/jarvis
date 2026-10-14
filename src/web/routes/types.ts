/**
 * Jarvis Local AI Agent: Web route plumbing
 * Authority: FEAT-004
 *
 * The shapes every route module shares with `server.ts`. Route modules never touch the socket directly: they
 * answer through `ctx.json`, read bodies through `ctx.readBody` (size-capped, content-type checked) and watch
 * for a vanished client through `ctx.disconnectSignal`.
 */

import type http from 'node:http';
import type { JarvisRuntime } from '../../runtime/runtime.js';

/** A request failure that maps straight onto an HTTP status. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface RouteContext {
  rt: JarvisRuntime;
  userId: string;
  defaultModel: string;
  req: http.IncomingMessage;
  res: http.ServerResponse;
  pathname: string;
  query: URLSearchParams;
  /** Capture groups of the matched route pattern, in order. */
  params: string[];
  json(status: number, body: unknown, headers?: http.OutgoingHttpHeaders): void;
  readBody(maxBytes?: number): Promise<unknown>;
  /**
   * True when the request carried an `Origin` header naming this server (or a configured origin). Browsers always
   * send one on a `fetch` POST, so a bare `curl` or script that only copies `X-Jarvis-Client` does not have it.
   */
  sameOriginBrowser: boolean;
  /** The kill switch's reason while it is engaged, otherwise null. */
  killedReason(): string | null;
  /**
   * Aborts when the client goes away before the response ended. `dispose` removes the listener; call it in a
   * `finally`. The kill switch needs no hook here: `rt.registerAbort` is what halts long work.
   */
  disconnectSignal(): { signal: AbortSignal; dispose(): void };
}

export interface Route {
  method: 'GET' | 'POST' | 'DELETE';
  pattern: RegExp;
  handler: (ctx: RouteContext) => Promise<void>;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Bounds string fields after a schema parse and returns the first violation as a message, or null. Length limits
 * live here rather than in the zod schemas so the schemas stay within what the offline test double supports.
 */
export function lengthProblem(values: Record<string, string | undefined>, limits: Record<string, number>): string | null {
  for (const [field, max] of Object.entries(limits)) {
    const value = values[field];
    if (value !== undefined && value.length > max) return `${field} is longer than ${max} characters.`;
  }
  return null;
}

/** Answers 503 and returns true while the kill switch is engaged. */
export function refuseIfKilled(ctx: RouteContext): boolean {
  const reason = ctx.killedReason();
  if (reason === null) return false;
  ctx.json(503, { error: `Kill switch engaged: ${reason || 'emergency stop'}. Nothing runs until the owner resets it.` });
  return true;
}

/**
 * Answers 403 and returns true unless the request came from a same-origin browser page. Used by the routes that
 * decide approvals or engage and release the kill switch.
 *
 * RESIDUAL RISK: `Origin` is a browser-enforced header, not a credential. Any local process can set it by hand,
 * and a token served over HTTP would be just as readable to that process, so this stops cross-site pages and
 * naive scripts, not a hostile program running as the owner. Telegram (an out-of-band channel to the owner's
 * phone) remains the stronger place to approve Tier 2 actions.
 */
export function refuseUnlessSameOriginBrowser(ctx: RouteContext): boolean {
  if (ctx.sameOriginBrowser) return false;
  ctx.json(403, { error: 'This action must be made from the Jarvis web page itself (a same-origin browser request with an Origin header).' });
  return true;
}
