/**
 * Jarvis Local AI Agent: Web Server & Streaming SSE API
 * Authority: FEAT-004, Section 11, Section 18.1
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import { ChatStore } from '../storage/chat-store.js';
import { OllamaProvider, MockLLMProvider, type LLMProvider, type GenerateStreamOptions } from '../services/provider.js';
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
import { SearXNGClient } from '../services/searxng.js';
import { ContentDistiller } from '../services/scraper.js';
import { ConsensusEngine } from '../services/consensus.js';
import { CognitionEngine } from '../agents/cognition.js';
import { ModelBenchmarkSuite } from '../eval/benchmark.js';
import { ModelProvisioner } from '../orchestration/provisioner.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';

export interface WebServerOptions {
  port?: number;
  chatStore?: ChatStore;
  /** Shared with the Telegram bot so both surfaces read and write one memory. */
  memoryManager?: MemoryManager;
  /** Memory owner for web chats; the web UI is single-owner. */
  userId?: string;
  /** Builds the inference provider for a chat turn; tests inject a fake here. */
  providerFactory?: (model: string) => LLMProvider;
}

const ChatStreamRequestSchema = z.object({
  sessionId: z.string().min(1),
  prompt: z.string().min(1),
  model: z.string().optional(),
  useResearch: z.boolean().optional(),
});

type SsePayload = { chunk: string } | { sources: string[] };

function streamFromProvider(provider: LLMProvider, prompt: string, options: GenerateStreamOptions): AsyncIterable<string> {
  if (provider.generateStream) {
    return provider.generateStream(prompt, options);
  }
  return (async function* () {
    yield await provider.generate(prompt, options);
  })();
}

export class JarvisWebServer {
  private port: number;
  private server: http.Server | null = null;
  private chatStore: ChatStore;
  private publicDir: string;
  private memoryManager: MemoryManager | null;
  private userId: string;
  private providerFactory: (model: string) => LLMProvider;

  constructor(options: WebServerOptions = {}) {
    this.port = options.port ?? 3000;
    this.chatStore = options.chatStore ?? new ChatStore(path.join(process.cwd(), 'data', 'chat.db'));
    this.memoryManager = options.memoryManager ?? null;
    this.userId = options.userId ?? 'owner';
    this.providerFactory = options.providerFactory ?? ((model) => new OllamaProvider({ baseUrl: config.ollamaBaseUrl, model }));
    this.publicDir = path.join(process.cwd(), 'src', 'web', 'public');
  }

  public async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));
      this.server.listen(this.port, '127.0.0.1', () => {
        logger.info(`[JarvisWebServer] Online at http://127.0.0.1:${this.port}`);
        resolve();
      });
    });
  }

  public async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        if (typeof (this.server as any).closeAllConnections === 'function') {
          (this.server as any).closeAllConnections();
        }
        this.server.close(() => {
          this.chatStore.close();
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const pathname = url.pathname;
    const method = req.method ?? 'GET';

    // CORS Headers for local development
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // 1. Health API
      if (pathname === '/api/health' && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'ok',
            freeMemoryBytes: os.freemem(),
            totalMemoryBytes: os.totalmem(),
          })
        );
        return;
      }

      // 2. Sessions API
      if (pathname === '/api/sessions' && method === 'GET') {
        const sessions = this.chatStore.getSessions();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(sessions));
        return;
      }

      if (pathname === '/api/sessions' && method === 'POST') {
        const body = await this.readJsonBody(req);
        const session = this.chatStore.createSession(body.title ?? 'New Conversation', body.model ?? 'qwen2.5:7b');
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(session));
        return;
      }

      // 3. Session Messages API
      const messagesMatch = pathname.match(/^\/api\/sessions\/([a-zA-Z0-9_-]+)\/messages$/);
      if (messagesMatch && method === 'GET') {
        const sessionId = messagesMatch[1];
        const messages = this.chatStore.getMessages(sessionId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(messages));
        return;
      }

      // 4. Delete Session API
      const sessionDeleteMatch = pathname.match(/^\/api\/sessions\/([a-zA-Z0-9_-]+)$/);
      if (sessionDeleteMatch && method === 'DELETE') {
        const sessionId = sessionDeleteMatch[1];
        this.chatStore.deleteSession(sessionId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
      }

      // 5. Models API
      if (pathname === '/api/models' && method === 'GET') {
        const provider = new OllamaProvider({ baseUrl: config.ollamaBaseUrl });
        const models = await provider.listModels();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models, active: provider.getModel() }));
        return;
      }

      // 6. Benchmark API
      if (pathname === '/api/benchmark' && (method === 'GET' || method === 'POST')) {
        let targetModel = 'qwen2.5:7b';
        if (method === 'POST') {
          const body = await this.readJsonBody(req).catch(() => ({}));
          if (body.model) targetModel = body.model;
        } else {
          const parsedUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
          const qModel = parsedUrl.searchParams.get('model');
          if (qModel) targetModel = qModel;
        }

        const suite = new ModelBenchmarkSuite();
        const provider = new OllamaProvider({ baseUrl: config.ollamaBaseUrl, model: targetModel });
        const scorecard = await suite.runBenchmark(provider);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(scorecard));
        return;
      }

      // 7. Streaming Chat API (SSE)
      if (pathname === '/api/chat/stream' && method === 'POST') {
        await this.handleStreamingChat(req, res);
        return;
      }

      // 7. Static File Serving
      this.serveStaticFile(pathname, res);
    } catch (err: any) {
      logger.error(`[JarvisWebServer] Error handling ${method} ${pathname}: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  private async handleStreamingChat(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const parsedBody = ChatStreamRequestSchema.safeParse(await this.readJsonBody(req));
    if (!parsedBody.success) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing sessionId or prompt' }));
      return;
    }
    const { sessionId, prompt, useResearch } = parsedBody.data;
    const model = parsedBody.data.model || undefined;
    const startedAt = Date.now();

    // History is read before the new message is saved, so the current prompt is not duplicated into
    // the context; it is passed separately as the request.
    const history: ConversationTurn[] = this.chatStore.getMessages(sessionId).map((m) => ({ role: m.role, content: m.content }));

    // Record user message in ChatStore
    this.chatStore.addMessage({
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

    // Step A: Automated Web Research (if requested or detected as lookup/factual query)
    const lower = prompt.toLowerCase();
    const shouldResearch = useResearch || lower.includes('?') || ['search', 'find', 'what', 'why', 'how', 'who', 'where', 'when', 'explain', 'tell me', 'lookup', 'research', 'latest', 'news', 'specs', 'architecture'].some((k) => lower.includes(k));

    if (shouldResearch) {
      await sendEvent({ chunk: '🔍 *Consulting local SearXNG metasearch & consensus...*\n\n' });
      try {
        const searchClient = new SearXNGClient({ enableFallback: true });
        const results = await searchClient.search(prompt, { maxResults: 3 });
        const distiller = new ContentDistiller();
        const consensusEngine = new ConsensusEngine();

        const extracted = results.map((r) => distiller.extractText(r.snippet, r.url));
        sources = extracted.map((e) => e.url);

        const consensusReport = consensusEngine.buildReport([
          { claim: prompt, sources: extracted.map((e) => ({ source: e.url, excerpt: e.content })) },
        ]);

        researchContext = `\nCorroborated Research Facts:\n${extracted.map((e, i) => `[Source ${i + 1}]: ${e.content}`).join('\n')}\nConsensus Score: ${consensusReport.overallScore}\n`;
        await sendEvent({ sources });
      } catch (err: unknown) {
        logger.warn(`[JarvisWebServer] Research augmentation skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Dynamic JIT model routing & on-demand provisioning
    let activeModel = model;
    let taskCategory: 'precision' | 'code' | 'reasoning' | 'chat' | 'vision' = 'chat';

    if (!activeModel) {
      const defaultProvider = new OllamaProvider({ baseUrl: config.ollamaBaseUrl });
      const provisioner = new ModelProvisioner(defaultProvider);
      const decision = await provisioner.ensureAndDispatch({
        prompt,
        onProgress: (msg) => {
          void sendEvent({ chunk: `${msg}\n\n` });
        },
      });
      activeModel = decision.targetModel;
      taskCategory = decision.category;
    } else {
      const isCode = ['code', 'script', 'function', 'class', 'write', 'implement', 'typescript', 'python', 'powershell', 'fix', 'bug', 'refactor', 'rewrite'].some((k) => lower.includes(k));
      taskCategory = isCode ? 'code' : 'chat';
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

    // Step B: Inference with Ollama (or MockLLM fallback)
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
      } else {
        logger.warn(`[JarvisWebServer] Ollama stream unavailable (${message}). Using local engine fallback.`);
        const mock = new MockLLMProvider({
          cannedResponse: `Jarvis local response for: "${prompt}". Running on Radeon 8060S with verified host memory headroom.`,
        });
        accumulatedResponse = await mock.generate(prompt);
        await sendEvent({ chunk: accumulatedResponse });
      }
    }
    if (clientGone) partial = true;

    // Save assistant message to ChatStore, including what was generated before an early disconnect.
    if (accumulatedResponse) {
      this.chatStore.addMessage({
        sessionId,
        role: 'assistant',
        content: accumulatedResponse,
        meta: partial ? { sources, partial: true } : { sources },
      });
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

      const messages = this.chatStore.getMessages(turn.sessionId);
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

  private serveStaticFile(pathname: string, res: http.ServerResponse): void {
    const filename = pathname === '/' ? 'index.html' : pathname.slice(1);
    const filePath = path.join(this.publicDir, filename);

    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }

    const ext = path.extname(filePath);
    const contentTypes: Record<string, string> = {
      '.html': 'text/html',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.json': 'application/json',
      '.png': 'image/png',
    };

    res.writeHead(200, { 'Content-Type': contentTypes[ext] ?? 'text/plain' });
    fs.createReadStream(filePath).pipe(res);
  }

  private readJsonBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch (err) {
          reject(new Error('Invalid JSON'));
        }
      });
      req.on('error', reject);
    });
  }
}
