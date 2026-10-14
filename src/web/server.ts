/**
 * Jarvis Local AI Agent: Web Server & Streaming SSE API
 * Authority: FEAT-004, Section 11, Section 18.1
 *
 * A thin HTTP adapter over the shared runtime: chat goes through `runChatTurn` (the one chat pipeline the Telegram
 * bot also uses), and every other capability is a JSON route in `routes/*` answering from the runtime's own
 * subsystems. Nothing here constructs a model client, a memory or a kill switch of its own.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import { ChatStore } from '../storage/chat-store.js';
import { DocumentStore } from '../storage/collection.js';
import type { SessionManager } from '../sessions/manager.js';
import type { LLMProvider } from '../services/provider.js';
import type { MemoryManager } from '../memory/manager.js';
import { createRuntime, type JarvisRuntime, type RuntimeOptions } from '../runtime/runtime.js';
import { runChatTurn, shouldResearchPrompt, type TurnEvent } from '../chat/pipeline.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import { assertSafeBinding, isClientAllowed, isHostHeaderAllowed, isLoopbackAddress, isOriginAllowed } from './access.js';
import { probeGpu, collectDiagnostics, type Diagnostics } from './diagnostics.js';
import { HttpError, errorMessage, type Route, type RouteContext } from './routes/types.js';
import { createSystemRoutes } from './routes/system.js';
import { createOpsRoutes } from './routes/ops.js';
import { createSkillRoutes } from './routes/skills.js';
import { createEmailRoutes } from './routes/email.js';
import { createApprovalFlow } from './routes/approval-flow.js';

export { HttpError, shouldResearchPrompt };

export interface WebServerOptions {
  port?: number;
  /** Bind address; defaults to `JARVIS_WEB_HOST` or 127.0.0.1. */
  host?: string;
  /** LAN client IPs and IPv4 CIDR ranges allowed in addition to loopback; defaults to `JARVIS_WEB_ALLOWED_IPS`. */
  allowedIps?: string[];
  /** Extra browser origins allowed to make state-changing requests; defaults to `JARVIS_WEB_ALLOWED_ORIGINS`. */
  allowedOrigins?: string[];
  /** The composition root shared with the Telegram bot. The server never closes a runtime it was given. */
  runtime?: JarvisRuntime;
  /**
   * Without a `runtime`, the server builds a private one from the options below and closes it on `stop()`.
   * These exist so tests and one-off scripts need no launcher.
   */
  runtimeOptions?: Partial<RuntimeOptions>;
  chatStore?: ChatStore;
  /** Shared with the Telegram bot so both surfaces read and write one set of sessions and turns. */
  sessionManager?: SessionManager;
  /** Shared with the Telegram bot so both surfaces read and write one memory. */
  memoryManager?: MemoryManager;
  /** Session and memory owner for web chats; defaults to the runtime's owner. */
  userId?: string;
  /** Builds the inference provider for a model tag; used only when the server builds its own runtime. */
  providerFactory?: (model: string) => LLMProvider;
  /** Used only when the server builds its own runtime. Defaults to `JARVIS_OLLAMA_URL`. */
  ollamaBaseUrl?: string;
  /** Resident baseline model reported as `active` and used when a request names none; defaults to `JARVIS_DEFAULT_MODEL`. */
  defaultModel?: string;
  /** Overrides the runtime's kill switch as the read-only view that refuses chat with 503. */
  killSwitch?: { isKilled(): boolean; getKillReason(): string };
  /** How long a chat stream may wait for a client that stopped reading before the turn is aborted; defaults to 60 s. */
  sseDrainTimeoutMs?: number;
  /** Replaceable system probes; tests inject fakes so no Ollama or GPU is needed. */
  probes?: {
    ollama?: (baseUrl: string) => Promise<Diagnostics['ollama']>;
    gpu?: () => Promise<Diagnostics['gpu']>;
  };
}

const DIAGNOSTICS_CACHE_MS = 15_000;

const AttachmentSchema = z.object({
  kind: z.literal('image'),
  description: z.string().optional(),
});
const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_DESCRIPTION_CHARS = 8000;

const ChatStreamRequestSchema = z.object({
  sessionId: z.string().min(1),
  prompt: z.string().min(1),
  model: z.string().optional(),
  useResearch: z.boolean().optional(),
  attachments: z.array(AttachmentSchema).optional(),
});

const CreateSessionRequestSchema = z.object({
  title: z.string().optional(),
  model: z.string().optional(),
});

type SsePayload =
  | { chunk: string }
  | { sources: string[] }
  | { status: string }
  | { model: { model: string; lane: string; rationale: string } }
  | { tool: { name: string; tier: 1 | 2 | 3; state: string; detail?: string } }
  | { error: string; code?: string }
  | { partial: true }
  | { truncated: true };

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const MODEL_NAME_PATTERN = /^[\w.:/@+-]{1,200}$/;
const GPU_PROBE_TTL_MS = 15_000;
const SHUTDOWN_TURN_WAIT_MS = 5_000;
/** A client that has not drained its socket for this long is treated as gone. */
export const DEFAULT_SSE_DRAIN_TIMEOUT_MS = 60_000;
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

/**
 * Splits `req.url` into a pathname and query without letting the request choose the host: the URL is always
 * appended to a fixed base, because `new URL('//x', base)` would parse `x` as the authority.
 * Returns null for anything that is not an origin-form target.
 */
export function parseRequestTarget(rawUrl: string | undefined): { pathname: string; searchParams: URLSearchParams } | null {
  if (!rawUrl || !rawUrl.startsWith('/')) return null;
  try {
    const url = new URL(`http://jarvis.invalid${rawUrl}`);
    return { pathname: url.pathname, searchParams: url.searchParams };
  } catch {
    return null;
  }
}

let processGuardInstalled = false;

/** Keeps one bad request or stray rejection from exiting the whole launcher; call once from a CLI entry point. */
export function installProcessGuard(): void {
  if (processGuardInstalled) return;
  processGuardInstalled = true;
  process.on('uncaughtException', (err) => {
    logger.error(`[Process] Uncaught exception kept the process alive: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error(`[Process] Unhandled rejection kept the process alive: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
  });
}

function describeListenError(err: NodeJS.ErrnoException, host: string, port: number): string {
  if (err.code === 'EADDRINUSE') {
    return `Port ${port} on ${host} is already in use. Stop the other Jarvis instance or set PORT to a free port.`;
  }
  if (err.code === 'EACCES') {
    return `No permission to listen on ${host}:${port}.`;
  }
  if (err.code === 'EADDRNOTAVAIL') {
    return `${host} is not an address of this machine (JARVIS_WEB_HOST).`;
  }
  return `Web server failed to start on ${host}:${port}: ${err.message}`;
}

/**
 * `ChatStore` keeps its `SessionManager` private. A caller that hands the server a bare `chatStore` (tests, older
 * launchers) still needs the pipeline to write to the same sessions, so the manager is read back out of it.
 */
function sessionsOf(chatStore: ChatStore): SessionManager {
  return (chatStore as unknown as { sessions: SessionManager }).sessions;
}

/** A view of `base` whose `sessions` and `memory` are the caller's own, so the pipeline reads and writes them. */
function overlayRuntime(base: JarvisRuntime, overrides: { sessions?: SessionManager; memory?: MemoryManager }): JarvisRuntime {
  const properties: PropertyDescriptorMap = {};
  if (overrides.sessions) properties.sessions = { value: overrides.sessions, enumerable: true };
  if (overrides.memory) properties.memory = { value: overrides.memory, enumerable: true };
  return Object.keys(properties).length > 0 ? (Object.create(base, properties) as JarvisRuntime) : base;
}

export class JarvisWebServer {
  private port: number;
  private host: string;
  private allowedIps: string[];
  private allowedOrigins: string[];
  private server: http.Server | null = null;
  private publicDir: string;
  private userId: string;
  private defaultModel: string;
  private rt: JarvisRuntime | null;
  private ownedRuntime: JarvisRuntime | null = null;
  private chatStore: ChatStore | null;
  private ownsChatStore: boolean;
  private routes: Route[] = [];
  private probeGpuFn: () => Promise<Diagnostics['gpu']>;
  private inFlightTurns = new Set<Promise<unknown>>();
  private vram: { totalBytes: number; freeBytes: number } | null = null;
  private vramProbeStartedAt = 0;
  private vramProbeInFlight = false;
  private diagnosticsCache: { at: number; value: Diagnostics } | null = null;
  private diagnosticsInFlight: Promise<Diagnostics> | null = null;

  constructor(private readonly options: WebServerOptions = {}) {
    this.port = options.port ?? 3000;
    this.host = options.host ?? config.webHost;
    this.allowedIps = options.allowedIps ?? config.webAllowedIps;
    this.allowedOrigins = options.allowedOrigins ?? config.webAllowedOrigins;
    this.rt = options.runtime ?? null;
    this.userId = options.userId ?? options.runtime?.ownerUserId ?? 'owner';
    this.defaultModel = options.defaultModel ?? options.runtime?.config.defaultModel ?? config.defaultModel;
    this.chatStore = options.chatStore ?? null;
    this.ownsChatStore = options.chatStore !== undefined;
    this.probeGpuFn = options.probes?.gpu ?? (() => probeGpu());
    this.publicDir = path.join(process.cwd(), 'src', 'web', 'public');
  }

  /** Diagnostics spawn `llama-cli` and query Ollama, so one probe is shared by concurrent GETs and reused for a short while. */
  private getDiagnostics(): Promise<Diagnostics> {
    const cached = this.diagnosticsCache;
    if (cached && Date.now() - cached.at < DIAGNOSTICS_CACHE_MS) return Promise.resolve(cached.value);
    if (this.diagnosticsInFlight) return this.diagnosticsInFlight;
    const probe = collectDiagnostics(this.requireRuntime().config.ollamaBaseUrl, this.options.probes)
      .then((value) => {
        this.diagnosticsCache = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        this.diagnosticsInFlight = null;
      });
    this.diagnosticsInFlight = probe;
    return probe;
  }

  /** The port actually bound; differs from the requested one only when that was 0. */
  public getPort(): number {
    return this.port;
  }

  /** The runtime the server answers from (the shared one, or the private one built for it). Null before `start()`. */
  public getRuntime(): JarvisRuntime | null {
    return this.rt;
  }

  private async prepareRuntime(): Promise<JarvisRuntime> {
    if (this.rt) return this.rt;
    const { options } = this;
    const probes = options.probes;
    const gpuProbe = probes?.gpu;
    const bringYourOwnStorage = options.chatStore !== undefined || options.sessionManager !== undefined || options.memoryManager !== undefined;
    const sessionsOverride = options.sessionManager ?? (options.chatStore ? sessionsOf(options.chatStore) : undefined);
    const base = await createRuntime({
      ...(bringYourOwnStorage ? { store: new DocumentStore(':memory:') } : {}),
      ...(options.userId ? { ownerUserId: options.userId } : {}),
      ...(options.ollamaBaseUrl ? { ollamaBaseUrl: options.ollamaBaseUrl } : {}),
      ...(options.providerFactory ? { providerFactory: options.providerFactory } : {}),
      ...(probes?.ollama ? { fetchInventory: probes.ollama } : {}),
      ...(gpuProbe
        ? {
            probeVram: async () => {
              const free = (await gpuProbe()).devices.map((device) => device.freeBytes).filter((bytes): bytes is number => bytes !== null);
              return free.length > 0 ? Math.max(...free) : null;
            },
          }
        : {}),
      ...options.runtimeOptions,
    });
    // A runtime built on a private in-memory store is closed with the server; its store goes with it.
    this.ownedRuntime = base;
    return overlayRuntime(base, { sessions: sessionsOverride, memory: options.memoryManager });
  }

  public async start(): Promise<void> {
    assertSafeBinding(this.host, this.allowedIps);
    const rt = await this.prepareRuntime();
    this.rt = rt;
    this.chatStore ??= new ChatStore(rt.sessions, this.userId);

    // Pending approvals are listed by `GET /api/approvals` and decided from the web UI, so the broker's notifier has
    // nothing to push; a notifier another surface registered (Telegram) is left alone.
    if (!rt.approvals.hasNotifier()) rt.approvals.setNotifier(async () => undefined);

    const flow = createApprovalFlow();
    this.routes = [...createSystemRoutes(), ...createOpsRoutes(), ...createSkillRoutes(flow), ...createEmailRoutes(flow)];

    await new Promise<void>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        void this.handleRequestSafely(req, res);
      });
      // `requestTimeout` only bounds receiving the request, so the long-lived SSE response is not affected.
      server.requestTimeout = 30_000;
      server.headersTimeout = 15_000;
      server.on('clientError', (_err, socket) => {
        if (socket.writable) {
          socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        } else {
          socket.destroy();
        }
      });

      const onStartupError = (err: NodeJS.ErrnoException): void => {
        reject(new Error(describeListenError(err, this.host, this.port)));
      };
      server.once('error', onStartupError);
      server.listen(this.port, this.host, () => {
        server.off('error', onStartupError);
        server.on('error', (err) => logger.error(`[JarvisWebServer] Server error: ${err.message}`));
        this.server = server;
        const address = server.address();
        if (address && typeof address === 'object') this.port = address.port;
        logger.info(`[JarvisWebServer] Online at http://${this.host}:${this.port}`);
        if (!isLoopbackAddress(this.host)) {
          logger.warn(`[JarvisWebServer] LAN access enabled for: ${this.allowedIps.join(', ')} (plus loopback).`);
        }
        resolve();
      });
    }).catch(async (err: unknown) => {
      await this.releaseOwnedResources();
      throw err;
    });
    this.refreshVram();
  }

  public async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (this.server) {
        this.server.closeAllConnections();
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
    // Closing the connections aborted every streaming turn; give them a moment to save what they have before the
    // store they write to can be closed.
    if (this.inFlightTurns.size > 0) {
      await Promise.race([Promise.allSettled([...this.inFlightTurns]), new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TURN_WAIT_MS).unref())]);
    }
    await this.releaseOwnedResources();
  }

  private async releaseOwnedResources(): Promise<void> {
    if (this.ownsChatStore) this.chatStore?.close();
    const owned = this.ownedRuntime;
    this.ownedRuntime = null;
    if (owned) await owned.close();
  }

  private sendJson(res: http.ServerResponse, status: number, body: unknown, extraHeaders: http.OutgoingHttpHeaders = {}): void {
    if (res.headersSent) {
      if (!res.writableEnded) res.end();
      return;
    }
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders });
    res.end(JSON.stringify(body));
  }

  /** Outermost guard: nothing thrown while handling a request can escape into the process. */
  private async handleRequestSafely(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      await this.handleRequest(req, res);
    } catch (err: unknown) {
      const status = err instanceof HttpError ? err.status : 500;
      const message = errorMessage(err);
      if (status >= 500 && !(err instanceof HttpError)) logger.error(`[JarvisWebServer] Error handling ${req.method ?? '?'} request: ${message}`);
      try {
        if (res.headersSent) {
          res.destroy();
        } else {
          // An `HttpError` carries a message written for the owner (for example "Ollama is unreachable ..."); anything
          // else is an unexpected failure whose detail stays in the log.
          this.sendJson(res, status, { error: err instanceof HttpError || status < 500 ? message : 'Internal server error' });
        }
      } catch {
        res.destroy();
      }
    }
  }

  private killedReason(): string | null {
    const view = this.options.killSwitch ?? this.rt?.killSwitch;
    return view?.isKilled() ? view.getKillReason() : null;
  }

  private requireRuntime(): JarvisRuntime {
    if (!this.rt) throw new HttpError(503, 'Jarvis is still starting.');
    return this.rt;
  }

  private makeContext(req: http.IncomingMessage, res: http.ServerResponse, pathname: string, query: URLSearchParams, params: string[]): RouteContext {
    return {
      rt: this.requireRuntime(),
      userId: this.userId,
      defaultModel: this.defaultModel,
      req,
      res,
      pathname,
      query,
      params,
      json: (status, body, headers) => this.sendJson(res, status, body, headers),
      readBody: (maxBytes) => this.readJsonBody(req, maxBytes),
      sameOriginBrowser: typeof req.headers.origin === 'string' && isOriginAllowed(req.headers.origin, req.headers.host, this.allowedOrigins),
      killedReason: () => this.killedReason(),
      disconnectSignal: () => {
        // Disconnects are detected on `res`: `IncomingMessage` emits `close` once the body has been read.
        const controller = new AbortController();
        const onClose = (): void => {
          if (!res.writableEnded) controller.abort('Client disconnected');
        };
        res.on('close', onClose);
        return { signal: controller.signal, dispose: () => res.off('close', onClose) };
      },
    };
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // The allowlist runs before anything else touches the request, including URL parsing.
    if (!isClientAllowed(req.socket.remoteAddress, this.allowedIps)) {
      logger.warn(`[JarvisWebServer] Refused ${req.socket.remoteAddress ?? 'unknown client'}: not loopback or in JARVIS_WEB_ALLOWED_IPS`);
      this.sendJson(res, 403, { error: 'Forbidden' });
      return;
    }

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);

    const target = parseRequestTarget(req.url);
    if (!target) {
      this.sendJson(res, 400, { error: 'Bad request target' });
      return;
    }
    const { pathname } = target;
    const method = req.method ?? 'GET';

    if (!isHostHeaderAllowed(req.headers.host, this.host, this.allowedOrigins)) {
      this.sendJson(res, 403, { error: 'Unrecognised Host header' });
      return;
    }

    // No CORS headers are ever sent, so a browser blocks cross-origin reads; the checks below also stop
    // cross-origin writes from being executed at all.
    if (method === 'OPTIONS') {
      this.sendJson(res, 405, { error: 'Cross-origin requests are not supported' }, { Allow: 'GET, HEAD, POST, DELETE' });
      return;
    }

    if (MUTATING_METHODS.has(method)) {
      const origin = req.headers.origin;
      const fetchSite = req.headers['sec-fetch-site'];
      if (
        req.headers['x-jarvis-client'] !== 'web' ||
        (origin !== undefined && !isOriginAllowed(origin, req.headers.host, this.allowedOrigins)) ||
        fetchSite === 'cross-site' ||
        fetchSite === 'same-site'
      ) {
        logger.warn(`[JarvisWebServer] Refused cross-origin ${method} ${pathname}`);
        this.sendJson(res, 403, { error: 'Cross-origin or missing X-Jarvis-Client header' });
        return;
      }
    }

    // 1. Health API
    if (pathname === '/api/health' && method === 'GET') {
      this.refreshVram();
      this.requireRuntime();
      const killedReason = this.killedReason();
      this.sendJson(res, 200, {
        status: 'ok',
        freeMemoryBytes: os.freemem(),
        totalMemoryBytes: os.totalmem(),
        ...(this.vram ? { vramFreeBytes: this.vram.freeBytes, vramTotalBytes: this.vram.totalBytes } : {}),
        defaultModel: this.defaultModel,
        killSwitch: { engaged: killedReason !== null, reason: killedReason ?? '' },
      });
      return;
    }

    // 1b. Diagnostics API: both memory pools, GPU devices, and what Ollama has installed and resident.
    // `/api/health` reports `os.freemem()`, which on this box only covers the ~31.65 GB Windows partition;
    // model weights live in the separate Vulkan pool that Node cannot see (see web/diagnostics.ts).
    if (pathname === '/api/diagnostics' && method === 'GET') {
      // Read-only, so it stays available while the kill switch is engaged (like the other read-only endpoints).
      this.sendJson(res, 200, await this.getDiagnostics());
      return;
    }

    const chatStore = this.requireChatStore();

    // 2. Sessions API
    if (pathname === '/api/sessions' && method === 'GET') {
      this.sendJson(res, 200, await chatStore.getSessions());
      return;
    }

    if (pathname === '/api/sessions' && method === 'POST') {
      const body = CreateSessionRequestSchema.safeParse(await this.readJsonBody(req));
      if (!body.success) {
        this.sendJson(res, 400, { error: 'Invalid session request' });
        return;
      }
      const session = await chatStore.createSession(body.data.title || 'New Conversation', body.data.model || this.defaultModel);
      this.sendJson(res, 201, session);
      return;
    }

    // 3. Session Messages API
    const messagesMatch = pathname.match(/^\/api\/sessions\/([a-zA-Z0-9_-]+)\/messages$/);
    if (messagesMatch && method === 'GET') {
      this.sendJson(res, 200, await chatStore.getMessages(messagesMatch[1]));
      return;
    }

    // 4. Delete Session API
    const sessionDeleteMatch = pathname.match(/^\/api\/sessions\/([a-zA-Z0-9_-]+)$/);
    if (sessionDeleteMatch && method === 'DELETE') {
      await chatStore.deleteSession(sessionDeleteMatch[1]);
      this.sendJson(res, 200, { success: true });
      return;
    }

    // 5. Streaming Chat API (SSE)
    if (pathname === '/api/chat/stream' && method === 'POST') {
      await this.handleStreamingChat(req, res);
      return;
    }

    // 6. Runtime, dashboard and capability routes
    if (pathname.startsWith('/api/')) {
      if (await this.dispatchRoute(req, res, pathname, target.searchParams, method)) return;
      this.sendJson(res, 404, { error: 'Not found' });
      return;
    }

    // 7. Static File Serving
    if (method !== 'GET' && method !== 'HEAD') {
      this.sendJson(res, 405, { error: 'Method not allowed' }, { Allow: 'GET, HEAD' });
      return;
    }
    await this.serveStaticFile(pathname, method === 'HEAD', res);
  }

  private requireChatStore(): ChatStore {
    if (!this.chatStore) throw new HttpError(503, 'Jarvis is still starting.');
    return this.chatStore;
  }

  /** Returns true when a route owned the request (including a 405 for a known path with the wrong method). */
  private async dispatchRoute(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
    query: URLSearchParams,
    method: string
  ): Promise<boolean> {
    const allowed = new Set<string>();
    for (const route of this.routes) {
      const match = route.pattern.exec(pathname);
      if (!match) continue;
      allowed.add(route.method);
      if (route.method !== method) continue;
      let params: string[];
      try {
        params = match.slice(1).map((value) => decodeURIComponent(value));
      } catch {
        this.sendJson(res, 400, { error: 'Malformed path' });
        return true;
      }
      await route.handler(this.makeContext(req, res, pathname, query, params));
      return true;
    }
    if (allowed.size > 0) {
      this.sendJson(res, 405, { error: `Use ${[...allowed].join(' or ')} for this endpoint` }, { Allow: [...allowed].join(', ') });
      return true;
    }
    return false;
  }

  /** Probes the GPU at most every 15 s and never blocks the caller; the result lands in `this.vram`. */
  private refreshVram(): void {
    if (this.vramProbeInFlight || Date.now() - this.vramProbeStartedAt < GPU_PROBE_TTL_MS) return;
    this.vramProbeInFlight = true;
    this.vramProbeStartedAt = Date.now();
    this.probeGpuFn()
      .then((gpu) => {
        const device = gpu.devices.find((d) => d.totalBytes !== null && d.freeBytes !== null);
        this.vram = device ? { totalBytes: device.totalBytes as number, freeBytes: device.freeBytes as number } : null;
      })
      .catch((err: unknown) => {
        this.vram = null;
        logger.debug(`[JarvisWebServer] GPU probe failed: ${errorMessage(err)}`);
      })
      .finally(() => {
        this.vramProbeInFlight = false;
      });
  }

  private async handleStreamingChat(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const rt = this.requireRuntime();
    const chatStore = this.requireChatStore();
    const killedReason = this.killedReason();
    if (killedReason !== null) {
      this.sendJson(res, 503, { error: `Kill switch engaged: ${killedReason || 'emergency stop'}. Nothing runs until the owner resets it.` });
      return;
    }
    const parsedBody = ChatStreamRequestSchema.safeParse(await this.readJsonBody(req));
    if (!parsedBody.success) {
      this.sendJson(res, 400, { error: 'Missing sessionId or prompt' });
      return;
    }
    const { sessionId, prompt, useResearch, attachments } = parsedBody.data;
    if (attachments && (attachments.length > MAX_ATTACHMENTS || attachments.some((a) => (a.description?.length ?? 0) > MAX_ATTACHMENT_DESCRIPTION_CHARS))) {
      this.sendJson(res, 400, { error: `At most ${MAX_ATTACHMENTS} attachments, each description up to ${MAX_ATTACHMENT_DESCRIPTION_CHARS} characters.` });
      return;
    }
    const model = parsedBody.data.model || undefined;
    if (model !== undefined && !MODEL_NAME_PATTERN.test(model)) {
      this.sendJson(res, 400, { error: 'Invalid model name' });
      return;
    }

    // Checked before the SSE headers go out, so an unknown (or another user's) session is a plain 404
    // rather than a stream that fails when the pipeline cannot save the message.
    if (!(await chatStore.getSession(sessionId))) {
      this.sendJson(res, 404, { error: 'Session not found' });
      return;
    }

    // `X-Accel-Buffering` and `no-transform` stop proxies from buffering frames.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    // Disconnects are detected on `res`, not `req`: since Node 16, `IncomingMessage` emits `close` as soon
    // as the request body has been consumed, which has already happened in `readJsonBody`. `res` emits `close`
    // when the socket goes away, and `writableEnded` separates that from a normal end. Once the pipeline has sent
    // `done` the reply is complete, so a client that stops reading at `[DONE]` must not abort the post-turn work
    // (episode, summary) that is still running on the same signal.
    const abortController = new AbortController();
    let finished = false;
    const onClose = (): void => {
      if (!res.writableEnded && !finished) abortController.abort('Client disconnected');
    };
    res.on('close', onClose);

    const drainTimeoutMs = this.options.sseDrainTimeoutMs ?? DEFAULT_SSE_DRAIN_TIMEOUT_MS;
    const sendEvent = async (payload: SsePayload | '[DONE]'): Promise<void> => {
      if (res.destroyed || res.writableEnded) return;
      const frame = payload === '[DONE]' ? 'data: [DONE]\n\n' : `data: ${JSON.stringify(payload)}\n\n`;
      if (!res.write(frame)) {
        // Waits on `close` as well as `drain`: a client that disconnects under backpressure never drains. A client
        // that stays connected but never reads would hold the turn (and the model lease) open, so the wait is bounded;
        // destroying the response fires `close`, which aborts the turn through `onClose`.
        await new Promise<void>((resolve) => {
          const stalled = setTimeout(() => {
            logger.warn(`[JarvisWebServer] A chat client stopped reading for ${drainTimeoutMs} ms; ending its stream and aborting the turn.`);
            res.destroy();
          }, drainTimeoutMs);
          const done = (): void => {
            clearTimeout(stalled);
            res.off('drain', done);
            res.off('close', done);
            resolve();
          };
          res.once('drain', done);
          res.once('close', done);
        });
      }
    };

    const onEvent = async (event: TurnEvent): Promise<void> => {
      switch (event.type) {
        case 'chunk':
          await sendEvent({ chunk: event.text });
          break;
        case 'sources':
          await sendEvent({ sources: event.urls });
          break;
        case 'status':
          await sendEvent({ status: event.text });
          break;
        case 'model':
          await sendEvent({ model: { model: event.model, lane: event.lane, rationale: event.rationale } });
          break;
        case 'tool':
          await sendEvent({ tool: { name: event.name, tier: event.tier, state: event.state, ...(event.detail ? { detail: event.detail } : {}) } });
          break;
        case 'error':
          await sendEvent({ error: event.message, ...(event.code ? { code: event.code } : {}) });
          break;
        case 'done':
          finished = true;
          if (event.partial) await sendEvent({ partial: true });
          if (event.truncated) await sendEvent({ truncated: true });
          await sendEvent('[DONE]');
          break;
      }
    };

    const turn = runChatTurn(
      rt,
      {
        surface: 'web',
        userId: this.userId,
        sessionId,
        prompt,
        explicitModel: model,
        useResearch,
        signal: abortController.signal,
        ...(attachments ? { attachments } : {}),
      },
      onEvent
    );
    this.inFlightTurns.add(turn);
    try {
      await turn;
    } finally {
      this.inFlightTurns.delete(turn);
      res.off('close', onClose);
      if (!res.writableEnded) res.end();
    }
  }

  private async serveStaticFile(pathname: string, headOnly: boolean, res: http.ServerResponse): Promise<void> {
    const notFound = (): void => this.sendJson(res, 404, { error: 'Not found' });

    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      this.sendJson(res, 400, { error: 'Malformed path' });
      return;
    }
    if (decoded.includes('\0')) {
      this.sendJson(res, 400, { error: 'Malformed path' });
      return;
    }

    const relativeName = pathname === '/' ? 'index.html' : decoded.replace(/^[/\\]+/, '');
    const filePath = path.resolve(this.publicDir, relativeName);
    const isInside = (base: string, target: string): boolean => {
      const rel = path.relative(base, target);
      return rel !== '' && rel.split(path.sep)[0] !== '..' && !path.isAbsolute(rel);
    };
    if (!isInside(this.publicDir, filePath)) {
      notFound();
      return;
    }

    let realPath: string;
    try {
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) {
        notFound();
        return;
      }
      realPath = await fs.promises.realpath(filePath);
      if (!isInside(await fs.promises.realpath(this.publicDir), realPath)) {
        notFound();
        return;
      }
    } catch {
      notFound();
      return;
    }

    const ext = path.extname(realPath).toLowerCase();
    const cacheControl = ext === '.html' || ext === '.js' || ext === '.mjs' || ext === '.css' ? 'no-store' : 'no-cache';
    const headers = { 'Content-Type': CONTENT_TYPES[ext] ?? 'application/octet-stream', 'Cache-Control': cacheControl };
    if (headOnly) {
      res.writeHead(200, headers);
      res.end();
      return;
    }

    await new Promise<void>((resolve) => {
      const stream = fs.createReadStream(realPath);
      stream.once('open', () => {
        res.writeHead(200, headers);
        stream.pipe(res);
      });
      stream.once('error', (err) => {
        logger.warn(`[JarvisWebServer] Static file read failed: ${err.message}`);
        if (res.headersSent) {
          res.destroy();
        } else {
          this.sendJson(res, 500, { error: 'Could not read file' });
        }
        resolve();
      });
      res.once('close', () => {
        stream.destroy();
        resolve();
      });
    });
  }

  private readJsonBody(req: http.IncomingMessage, maxBytes: number = DEFAULT_MAX_BODY_BYTES): Promise<unknown> {
    const declaredLength = Number.parseInt(req.headers['content-length'] ?? '', 10);
    const hasBody = declaredLength > 0 || req.headers['transfer-encoding'] !== undefined;
    if (hasBody && !/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) {
      return Promise.reject(new HttpError(415, 'Content-Type must be application/json'));
    }
    if (declaredLength > maxBytes) {
      return Promise.reject(new HttpError(413, 'Request body too large'));
    }

    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let received = 0;
      let settled = false;
      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        reject(err);
      };
      req.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > maxBytes) {
          chunks.length = 0;
          fail(new HttpError(413, 'Request body too large'));
          req.resume();
          return;
        }
        if (!settled) chunks.push(chunk);
      });
      req.on('end', () => {
        if (settled) return;
        settled = true;
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          resolve(text ? JSON.parse(text) : {});
        } catch {
          reject(new HttpError(400, 'Invalid JSON'));
        }
      });
      req.on('error', (err) => fail(err));
    });
  }
}
