/**
 * Jarvis Local AI Agent: Web Server & Streaming SSE API
 * Authority: FEAT-004, Section 11, Section 18.1
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import { ChatStore, DEFAULT_CHAT_USER_ID } from '../storage/chat-store.js';
import type { SessionManager } from '../sessions/manager.js';
import { OllamaProvider, type LLMProvider, type GenerateOptions, type GenerateStreamOptions } from '../services/provider.js';
import type { MemoryManager } from '../memory/manager.js';
import {
  buildConversationContext,
  contextBudgetFor,
  estimateTokens,
  parseRememberCommand,
  recordTaskEpisode,
  resolveSummarizer,
  shouldSummarize,
  summarizeAndStoreSession,
  PROMPT_TOKEN_CAP,
  type ConversationTurn,
} from '../memory/context-builder.js';
import { SearXNGClient, type SearchResult } from '../services/searxng.js';
import { ContentDistiller } from '../services/scraper.js';
import { ConsensusEngine } from '../services/consensus.js';
import { CognitionEngine } from '../agents/cognition.js';
import { ModelBenchmarkSuite } from '../eval/benchmark.js';
import { ModelProvisioner } from '../orchestration/provisioner.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import { assertSafeBinding, isClientAllowed, isHostHeaderAllowed, isLoopbackAddress, isOriginAllowed } from './access.js';
import { probeGpu, probeOllama, collectDiagnostics, type Diagnostics } from './diagnostics.js';

export interface WebServerOptions {
  port?: number;
  /** Bind address; defaults to `JARVIS_WEB_HOST` or 127.0.0.1. */
  host?: string;
  /** LAN client IPs and IPv4 CIDR ranges allowed in addition to loopback; defaults to `JARVIS_WEB_ALLOWED_IPS`. */
  allowedIps?: string[];
  /** Extra browser origins allowed to make state-changing requests; defaults to `JARVIS_WEB_ALLOWED_ORIGINS`. */
  allowedOrigins?: string[];
  chatStore?: ChatStore;
  /** Shared with the Telegram bot so both surfaces read and write one set of sessions and turns. */
  sessionManager?: SessionManager;
  /** Shared with the Telegram bot so both surfaces read and write one memory. */
  memoryManager?: MemoryManager;
  /** Session and memory owner for web chats; the web UI is single-owner. */
  userId?: string;
  /** Builds the inference provider for a chat turn or benchmark; tests inject a fake here. */
  providerFactory?: (model: string) => LLMProvider;
  /** Defaults to `JARVIS_OLLAMA_URL`. */
  ollamaBaseUrl?: string;
  /** Resident baseline model reported as `active` and used when a request names none; defaults to `JARVIS_DEFAULT_MODEL`. */
  defaultModel?: string;
  /** Read-only view of the kill switch; while engaged, chat and benchmark requests are refused with 503. */
  killSwitch?: { isKilled(): boolean; getKillReason(): string };
  /** Builds the web-research client; tests inject a fake here. */
  searchClientFactory?: () => { search(query: string, options?: { maxResults?: number }): Promise<SearchResult[]> };
  /** Replaceable system probes; tests inject fakes so no Ollama or GPU is needed. */
  probes?: {
    ollama?: (baseUrl: string) => Promise<Diagnostics['ollama']>;
    gpu?: () => Promise<Diagnostics['gpu']>;
  };
}

const ChatStreamRequestSchema = z.object({
  sessionId: z.string().min(1),
  prompt: z.string().min(1),
  model: z.string().optional(),
  useResearch: z.boolean().optional(),
});

const CreateSessionRequestSchema = z.object({
  title: z.string().optional(),
  model: z.string().optional(),
});

const BenchmarkRequestSchema = z.object({
  model: z.string().optional(),
});

type SsePayload = { chunk: string } | { sources: string[] } | { error: string };

const MAX_BODY_BYTES = 1024 * 1024;
const MODEL_NAME_PATTERN = /^[\w.:/@+-]{1,200}$/;
const GPU_PROBE_TTL_MS = 15_000;
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

const LOOKUP_PATTERN = /\b(search(?:\s+for)?|look\s?up|research|latest|news|current(?:ly)?|today'?s|release\s+date|price\s+of)\b/i;

/**
 * Whether a prompt goes to the internet. An explicit toggle always wins; only when the client sent no
 * preference does a conservative word-boundary heuristic decide.
 */
export function shouldResearchPrompt(prompt: string, useResearch: boolean | undefined): boolean {
  if (useResearch !== undefined) return useResearch;
  return LOOKUP_PATTERN.test(prompt);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function streamFromProvider(provider: LLMProvider, prompt: string, options: GenerateStreamOptions): AsyncIterable<string> {
  if (provider.generateStream) {
    return provider.generateStream(prompt, options);
  }
  return (async function* () {
    yield await provider.generate(prompt, options);
  })();
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

export class JarvisWebServer {
  private port: number;
  private host: string;
  private allowedIps: string[];
  private allowedOrigins: string[];
  private server: http.Server | null = null;
  private chatStore: ChatStore;
  private publicDir: string;
  private memoryManager: MemoryManager | null;
  private userId: string;
  private providerFactory: (model: string) => LLMProvider;
  private ollamaBaseUrl: string;
  private defaultModel: string;
  private killSwitch: WebServerOptions['killSwitch'];
  private searchClientFactory: NonNullable<WebServerOptions['searchClientFactory']>;
  private probeOllamaFn: (baseUrl: string) => Promise<Diagnostics['ollama']>;
  private probeGpuFn: () => Promise<Diagnostics['gpu']>;
  private benchmarkInFlight = false;
  private vram: { totalBytes: number; freeBytes: number } | null = null;
  private vramProbeStartedAt = 0;
  private vramProbeInFlight = false;

  constructor(options: WebServerOptions = {}) {
    this.port = options.port ?? 3000;
    this.host = options.host ?? config.webHost;
    this.allowedIps = options.allowedIps ?? config.webAllowedIps;
    this.allowedOrigins = options.allowedOrigins ?? config.webAllowedOrigins;
    this.userId = options.userId ?? DEFAULT_CHAT_USER_ID;
    this.chatStore =
      options.chatStore ?? new ChatStore(options.sessionManager ?? path.join(process.cwd(), 'data', 'jarvis.db'), this.userId);
    this.memoryManager = options.memoryManager ?? null;
    this.ollamaBaseUrl = options.ollamaBaseUrl ?? config.ollamaBaseUrl;
    this.defaultModel = options.defaultModel ?? config.defaultModel;
    this.killSwitch = options.killSwitch;
    this.providerFactory = options.providerFactory ?? ((model) => new OllamaProvider({ baseUrl: this.ollamaBaseUrl, model }));
    this.searchClientFactory =
      options.searchClientFactory ??
      (() => new SearXNGClient({ baseUrl: config.searxngBaseUrl, enableFallback: config.searchLiveFallback, enableLiveFallback: config.searchLiveFallback }));
    this.probeOllamaFn = options.probes?.ollama ?? ((baseUrl) => probeOllama(baseUrl));
    this.probeGpuFn = options.probes?.gpu ?? (() => probeGpu());
    this.publicDir = path.join(process.cwd(), 'src', 'web', 'public');
  }

  /** The port actually bound; differs from the requested one only when that was 0. */
  public getPort(): number {
    return this.port;
  }

  public async start(): Promise<void> {
    assertSafeBinding(this.host, this.allowedIps);
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
    });
    this.refreshVram();
  }

  public async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.closeAllConnections();
        this.server.close(() => {
          this.chatStore.close();
          resolve();
        });
      } else {
        resolve();
      }
    });
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
      const message = err instanceof Error ? err.message : String(err);
      if (status >= 500) logger.error(`[JarvisWebServer] Error handling ${req.method ?? '?'} request: ${message}`);
      try {
        if (res.headersSent) {
          res.destroy();
        } else {
          this.sendJson(res, status, { error: status >= 500 ? 'Internal server error' : message });
        }
      } catch {
        res.destroy();
      }
    }
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
      const killed = this.killSwitch?.isKilled() ?? false;
      this.sendJson(res, 200, {
        status: 'ok',
        freeMemoryBytes: os.freemem(),
        totalMemoryBytes: os.totalmem(),
        ...(this.vram ? { vramFreeBytes: this.vram.freeBytes, vramTotalBytes: this.vram.totalBytes } : {}),
        defaultModel: this.defaultModel,
        ...(this.killSwitch ? { killSwitch: { engaged: killed, reason: killed ? this.killSwitch.getKillReason() : '' } } : {}),
      });
      return;
    }

    // 1b. Diagnostics API: both memory pools, GPU devices, and what Ollama has installed and resident.
    // `/api/health` reports `os.freemem()`, which on this box only covers the ~31.65 GB Windows partition;
    // model weights live in the separate Vulkan pool that Node cannot see (see web/diagnostics.ts).
    if (pathname === '/api/diagnostics' && method === 'GET') {
      this.sendJson(res, 200, await collectDiagnostics(this.ollamaBaseUrl));
      return;
    }

    // 2. Sessions API
    if (pathname === '/api/sessions' && method === 'GET') {
      this.sendJson(res, 200, await this.chatStore.getSessions());
      return;
    }

    if (pathname === '/api/sessions' && method === 'POST') {
      const body = CreateSessionRequestSchema.safeParse(await this.readJsonBody(req));
      if (!body.success) {
        this.sendJson(res, 400, { error: 'Invalid session request' });
        return;
      }
      const session = await this.chatStore.createSession(body.data.title || 'New Conversation', body.data.model || this.defaultModel);
      this.sendJson(res, 201, session);
      return;
    }

    // 3. Session Messages API
    const messagesMatch = pathname.match(/^\/api\/sessions\/([a-zA-Z0-9_-]+)\/messages$/);
    if (messagesMatch && method === 'GET') {
      this.sendJson(res, 200, await this.chatStore.getMessages(messagesMatch[1]));
      return;
    }

    // 4. Delete Session API
    const sessionDeleteMatch = pathname.match(/^\/api\/sessions\/([a-zA-Z0-9_-]+)$/);
    if (sessionDeleteMatch && method === 'DELETE') {
      await this.chatStore.deleteSession(sessionDeleteMatch[1]);
      this.sendJson(res, 200, { success: true });
      return;
    }

    // 5. Models API
    if (pathname === '/api/models' && method === 'GET') {
      await this.handleModels(res);
      return;
    }

    // 6. Benchmark API
    if (pathname === '/api/benchmark') {
      if (method !== 'POST') {
        this.sendJson(res, 405, { error: 'Use POST to run a benchmark' }, { Allow: 'POST' });
        return;
      }
      await this.handleBenchmark(req, res);
      return;
    }

    // 7. Streaming Chat API (SSE)
    if (pathname === '/api/chat/stream' && method === 'POST') {
      await this.handleStreamingChat(req, res);
      return;
    }

    if (pathname.startsWith('/api/')) {
      this.sendJson(res, 404, { error: 'Not found' });
      return;
    }

    // 8. Static File Serving
    if (method !== 'GET' && method !== 'HEAD') {
      this.sendJson(res, 405, { error: 'Method not allowed' }, { Allow: 'GET, HEAD' });
      return;
    }
    await this.serveStaticFile(pathname, method === 'HEAD', res);
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
        logger.debug(`[JarvisWebServer] GPU probe failed: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        this.vramProbeInFlight = false;
      });
  }

  private async handleModels(res: http.ServerResponse): Promise<void> {
    const ollama = await this.probeOllamaFn(this.ollamaBaseUrl);
    if (!ollama.reachable) {
      this.sendJson(res, 503, {
        error: `Ollama is unreachable at ${this.ollamaBaseUrl}${ollama.error ? `: ${ollama.error}` : ''}`,
        models: [],
        active: this.defaultModel,
      });
      return;
    }
    const names = ollama.installed.map((model) => model.name);
    this.sendJson(res, 200, {
      models: names,
      modelDetails: ollama.installed.map((model) => ({
        name: model.name,
        sizeBytes: model.sizeBytes,
        parameterSize: model.parameterSize,
        quantization: model.quantization,
      })),
      active: this.defaultModel,
      activeInstalled: names.includes(this.defaultModel),
    });
  }

  private async handleBenchmark(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (this.killSwitch?.isKilled()) {
      this.sendJson(res, 503, { error: `Kill switch engaged: ${this.killSwitch.getKillReason()}` });
      return;
    }
    const body = BenchmarkRequestSchema.safeParse(await this.readJsonBody(req));
    const requested = body.success ? body.data.model : undefined;
    if (!body.success || (requested !== undefined && requested !== '' && !MODEL_NAME_PATTERN.test(requested))) {
      this.sendJson(res, 400, { error: 'Invalid model name' });
      return;
    }
    if (this.benchmarkInFlight) {
      this.sendJson(res, 409, { error: 'A benchmark is already running' });
      return;
    }

    this.benchmarkInFlight = true;
    const abortController = new AbortController();
    const onClose = (): void => {
      if (!res.writableEnded) abortController.abort();
    };
    res.on('close', onClose);
    try {
      const inner = this.providerFactory(requested || this.defaultModel);
      const guarded: LLMProvider = {
        generate: async (prompt: string, options?: GenerateOptions) => {
          if (abortController.signal.aborted) throw new Error('Benchmark cancelled: client disconnected');
          return inner.generate(prompt, { ...options, signal: abortController.signal });
        },
        chat: (messages, options) => inner.chat(messages, options),
        getModel: () => inner.getModel(),
        getBaseUrl: () => inner.getBaseUrl(),
      };
      const scorecard = await new ModelBenchmarkSuite().runBenchmark(guarded);
      if (abortController.signal.aborted) return;
      if (scorecard.results.length > 0 && scorecard.results.every((r) => !r.passed && r.notes?.startsWith('Failed:'))) {
        this.sendJson(res, 502, { error: `Model ${scorecard.modelName} failed every benchmark case: ${scorecard.results[0].notes}` });
        return;
      }
      this.sendJson(res, 200, scorecard);
    } finally {
      res.off('close', onClose);
      this.benchmarkInFlight = false;
    }
  }

  private async handleStreamingChat(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (this.killSwitch?.isKilled()) {
      this.sendJson(res, 503, { error: `Kill switch engaged: ${this.killSwitch.getKillReason()}` });
      return;
    }
    const parsedBody = ChatStreamRequestSchema.safeParse(await this.readJsonBody(req));
    if (!parsedBody.success) {
      this.sendJson(res, 400, { error: 'Missing sessionId or prompt' });
      return;
    }
    const { sessionId, prompt, useResearch } = parsedBody.data;
    const model = parsedBody.data.model || undefined;
    if (model !== undefined && !MODEL_NAME_PATTERN.test(model)) {
      this.sendJson(res, 400, { error: 'Invalid model name' });
      return;
    }
    const startedAt = Date.now();

    // Checked before the SSE headers go out, so an unknown (or another user's) session is a plain 404
    // rather than a stream that fails when `addMessage` throws `SessionNotFoundError`.
    if (!(await this.chatStore.getSession(sessionId))) {
      this.sendJson(res, 404, { error: 'Session not found' });
      return;
    }

    // History is read before the new message is saved, so the current prompt is not duplicated into
    // the context; it is passed separately as the request.
    const history: ConversationTurn[] = (await this.chatStore.getMessages(sessionId)).map((m) => ({ role: m.role, content: m.content }));

    // Record user message in ChatStore
    await this.chatStore.addMessage({
      sessionId,
      role: 'user',
      content: prompt,
    });

    // Initialize SSE Headers. `X-Accel-Buffering` and `no-transform` stop proxies from buffering frames.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    // Disconnects are detected on `res`, not `req`: since Node 16, `IncomingMessage` emits `close` as soon
    // as the request body has been consumed, which has already happened in `readJsonBody`, so a `req`
    // listener would either never fire for a dropped socket or abort every generation immediately.
    // `res` emits `close` when the socket goes away, and `writableEnded` separates that from a normal end.
    const abortController = new AbortController();
    let clientGone = false;
    res.on('close', () => {
      if (!res.writableEnded) {
        clientGone = true;
        abortController.abort();
      }
    });

    const sendEvent = async (payload: SsePayload | '[DONE]'): Promise<void> => {
      if (clientGone || res.writableEnded) return;
      const frame = payload === '[DONE]' ? 'data: [DONE]\n\n' : `data: ${JSON.stringify(payload)}\n\n`;
      if (!res.write(frame)) {
        // Waits on `close` as well as `drain`: a client that disconnects under backpressure never drains.
        await new Promise<void>((resolve) => {
          const done = () => {
            res.off('drain', done);
            res.off('close', done);
            resolve();
          };
          res.once('drain', done);
          res.once('close', done);
        });
      }
    };

    let sources: string[] = [];
    let researchContext = '';

    // Step A: Automated Web Research, only when the toggle is on or (no toggle sent) the prompt is a lookup.
    const lower = prompt.toLowerCase();
    const shouldResearch = shouldResearchPrompt(prompt, useResearch);

    if (shouldResearch) {
      await sendEvent({ chunk: '🔍 *Consulting local SearXNG metasearch & consensus...*\n\n' });
      try {
        const searchClient = this.searchClientFactory();
        const results = await searchClient.search(prompt, { maxResults: 3 });
        const distiller = new ContentDistiller();
        const consensusEngine = new ConsensusEngine();

        const extracted = results.map((r) => distiller.extractText(r.snippet, r.url));
        sources = extracted.map((e) => e.url).filter(isHttpUrl);

        const consensusReport = consensusEngine.buildReport([
          { claim: prompt, sources: extracted.map((e) => ({ source: e.url, excerpt: e.content })) },
        ]);

        researchContext = `\nCorroborated Research Facts:\n${extracted.map((e, i) => `[Source ${i + 1}]: ${e.content}`).join('\n')}\nConsensus Score: ${consensusReport.overallScore}\n`;
        await sendEvent({ sources });
      } catch (err: unknown) {
        logger.warn(`[JarvisWebServer] Research augmentation skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Model routing. Provisioning can download a model (Tier 2), so it only runs when `JARVIS_ALLOW_MODEL_PULL` is on.
    let activeModel = model;
    let taskCategory: 'precision' | 'code' | 'reasoning' | 'chat' | 'vision' = 'chat';
    const isCode = /\b(code|script|function|class|implement|typescript|python|powershell|fix|bug|refactor|rewrite)\b/.test(lower);

    if (!activeModel && config.allowModelPull) {
      try {
        const provisioner = new ModelProvisioner(new OllamaProvider({ baseUrl: this.ollamaBaseUrl, model: this.defaultModel }));
        const decision = await provisioner.ensureAndDispatch({
          prompt,
          onProgress: (msg) => {
            void sendEvent({ chunk: `${msg}\n\n` });
          },
        });
        activeModel = decision.targetModel;
        taskCategory = decision.category;
      } catch (err: unknown) {
        logger.warn(`[JarvisWebServer] Model provisioning failed, using ${this.defaultModel}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (!activeModel) {
      activeModel = this.defaultModel;
      taskCategory = isCode ? 'code' : 'chat';
    } else if (taskCategory === 'chat' && isCode) {
      taskCategory = 'code';
    }

    // Explicit memory writes happen before the context is built, so the fact is usable in this same reply.
    const rememberedFact = parseRememberCommand(prompt);
    if (rememberedFact && this.memoryManager) {
      try {
        await this.memoryManager.setProfileFact(this.userId, rememberedFact.key, rememberedFact.value, 'preference');
        logger.info(`[JarvisWebServer] Stored profile fact "${rememberedFact.key}"`);
      } catch (err: unknown) {
        logger.warn(`[JarvisWebServer] Could not store profile fact: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const memoryContext = await buildConversationContext({
      memory: this.memoryManager,
      userId: this.userId,
      sessionId,
      prompt,
      turns: history,
      maxTokens: contextBudgetFor([prompt, researchContext]),
    });

    // Step B: Inference with Ollama
    const provider = this.providerFactory(activeModel);

    const fullPrompt = CognitionEngine.formatPrompt(prompt, {
      taskType: taskCategory === 'precision' || taskCategory === 'code' ? 'code' : taskCategory === 'reasoning' ? 'reasoning' : shouldResearch ? 'research' : 'chat',
      memoryContext: memoryContext.text,
      researchFacts: researchContext,
      activeModel,
    });
    const promptTokens = estimateTokens(fullPrompt);
    logger.debug('[JarvisWebServer] Prompt assembled', { sessionId, promptTokens, memoryTiers: memoryContext.includedTiers });
    if (promptTokens > PROMPT_TOKEN_CAP) {
      logger.warn(`[JarvisWebServer] Prompt is ~${promptTokens} tokens, above the ${PROMPT_TOKEN_CAP} cap; the request itself is too long to trim.`);
    }

    let accumulatedResponse = '';
    let partial = false;

    try {
      for await (const chunk of streamFromProvider(provider, fullPrompt, { maxTokens: 1024, signal: abortController.signal })) {
        accumulatedResponse += chunk;
        await sendEvent({ chunk });
        if (clientGone) break;
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (clientGone || abortController.signal.aborted) {
        logger.info(`[JarvisWebServer] Generation aborted after client disconnect (${sessionId}).`);
      } else if (accumulatedResponse) {
        partial = true;
        logger.warn(`[JarvisWebServer] Stream broke after partial output (${message}).`);
        await sendEvent({ error: `The response was interrupted: ${message}` });
      } else {
        // Nothing is saved or invented: the owner sees the failure and can retry.
        logger.warn(`[JarvisWebServer] Model ${activeModel} produced no output (${message}).`);
        await sendEvent({ error: `Model ${activeModel} could not answer: ${message}` });
      }
    }
    if (clientGone) partial = true;

    // Save assistant message to ChatStore, including what was generated before an early disconnect.
    // The session can be deleted mid-stream (another tab, or Telegram). The SSE headers are already sent,
    // so a throw here would reach `handleRequestSafely`, which can only destroy the socket; the reply is
    // dropped with a warning instead.
    if (accumulatedResponse) {
      try {
        await this.chatStore.addMessage({
          sessionId,
          role: 'assistant',
          content: accumulatedResponse,
          meta: partial ? { sources, partial: true } : { sources },
        });
      } catch (err: unknown) {
        logger.warn(`[JarvisWebServer] Assistant reply not saved: ${err instanceof Error ? err.message : String(err)}`, { sessionId });
      }
    }

    // [DONE] goes out before the memory writes, so the browser stops waiting; the response stays open
    // only until the summary (which can take a few seconds on the small model) has been stored.
    await sendEvent('[DONE]');
    await this.recordTurnMemory({ sessionId, prompt, response: accumulatedResponse, partial, provider, startedAt });
    if (!res.writableEnded) res.end();
  }

  private async recordTurnMemory(turn: {
    sessionId: string;
    prompt: string;
    response: string;
    partial: boolean;
    provider: LLMProvider;
    startedAt: number;
  }): Promise<void> {
    if (!this.memoryManager) return;
    try {
      if (turn.response && !turn.partial) {
        await recordTaskEpisode(this.memoryManager, {
          userId: this.userId,
          sessionId: turn.sessionId,
          goal: turn.prompt,
          outcome: turn.response,
          executionTimeMs: Date.now() - turn.startedAt,
        });
      }

      const messages = await this.chatStore.getMessages(turn.sessionId);
      if (shouldSummarize(messages.length)) {
        const summarizer = await resolveSummarizer(turn.provider);
        await summarizeAndStoreSession({
          memory: this.memoryManager,
          summarizer,
          userId: this.userId,
          sessionId: turn.sessionId,
          turns: messages.map((m) => ({ role: m.role, content: m.content })),
        });
      }
    } catch (err: unknown) {
      logger.warn(`[JarvisWebServer] Post-turn memory update skipped: ${err instanceof Error ? err.message : String(err)}`);
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

  private readJsonBody(req: http.IncomingMessage): Promise<unknown> {
    const declaredLength = Number.parseInt(req.headers['content-length'] ?? '', 10);
    const hasBody = declaredLength > 0 || req.headers['transfer-encoding'] !== undefined;
    if (hasBody && !/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) {
      return Promise.reject(new HttpError(415, 'Content-Type must be application/json'));
    }
    if (declaredLength > MAX_BODY_BYTES) {
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
        if (received > MAX_BODY_BYTES) {
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
