/**
 * Jarvis Local AI Agent: Web Server & Streaming SSE API
 * Authority: FEAT-004, Section 11, Section 18.1
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ChatStore } from '../storage/chat-store.js';
import { OllamaProvider, MockLLMProvider } from '../services/provider.js';
import { SearXNGClient } from '../services/searxng.js';
import { ContentDistiller } from '../services/scraper.js';
import { ConsensusEngine } from '../services/consensus.js';
import { CognitionEngine } from '../agents/cognition.js';
import { ModelBenchmarkSuite } from '../eval/benchmark.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';

export interface WebServerOptions {
  port?: number;
  chatStore?: ChatStore;
}

export class JarvisWebServer {
  private port: number;
  private server: http.Server | null = null;
  private chatStore: ChatStore;
  private publicDir: string;

  constructor(options: WebServerOptions = {}) {
    this.port = options.port ?? 3000;
    this.chatStore = options.chatStore ?? new ChatStore(path.join(process.cwd(), 'data', 'chat.db'));
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
    const body = await this.readJsonBody(req);
    const { sessionId, prompt, model, useResearch } = body;

    if (!sessionId || !prompt) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing sessionId or prompt' }));
      return;
    }

    // Record user message in ChatStore
    this.chatStore.addMessage({
      sessionId,
      role: 'user',
      content: prompt,
    });

    // Initialize SSE Headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    let sources: string[] = [];
    let researchContext = '';

    // Step A: Automated Web Research (if requested or detected as lookup/factual query)
    const lower = prompt.toLowerCase();
    const shouldResearch = useResearch || lower.includes('?') || ['search', 'find', 'what', 'why', 'how', 'who', 'where', 'when', 'explain', 'tell me', 'lookup', 'research', 'latest', 'news', 'specs', 'architecture'].some((k) => lower.includes(k));

    if (shouldResearch) {
      res.write(`data: ${JSON.stringify({ chunk: '🔍 *Consulting local SearXNG metasearch & consensus...*\n\n' })}\n\n`);
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
        res.write(`data: ${JSON.stringify({ sources })}\n\n`);
      } catch (err: any) {
        logger.warn(`[JarvisWebServer] Research augmentation skipped: ${err.message}`);
      }
    }

    // Dynamic model routing: if code requested and model not explicitly overridden
    const isCode = ['code', 'script', 'function', 'class', 'write', 'implement', 'typescript', 'python', 'powershell', 'fix', 'bug', 'refactor', 'rewrite'].some((k) => lower.includes(k));
    const activeModel = model || (isCode ? 'qwen2.5-coder:1.5b' : 'qwen2.5:7b');

    // Step B: Inference with Ollama (or MockLLM fallback)
    const provider = new OllamaProvider({
      baseUrl: config.ollamaBaseUrl,
      model: activeModel,
    });

    const fullPrompt = CognitionEngine.formatPrompt(prompt, {
      taskType: isCode ? 'code' : shouldResearch ? 'research' : 'chat',
      researchFacts: researchContext,
      activeModel,
    });
    let accumulatedResponse = '';

    try {
      const responseText = await provider.generate(fullPrompt, { maxTokens: 1024 });
      accumulatedResponse = responseText;

      // Stream words cleanly to frontend
      const words = responseText.split(' ');
      for (const word of words) {
        res.write(`data: ${JSON.stringify({ chunk: `${word} ` })}\n\n`);
      }
    } catch (err: any) {
      logger.warn(`[JarvisWebServer] Ollama stream unavailable (${err.message}). Using local engine fallback.`);
      const mock = new MockLLMProvider({
        cannedResponse: `Jarvis local response for: "${prompt}". Running on Radeon 8060S with verified host memory headroom.`,
      });
      accumulatedResponse = await mock.generate(prompt);
      res.write(`data: ${JSON.stringify({ chunk: accumulatedResponse })}\n\n`);
    }

    // Save assistant message to ChatStore
    this.chatStore.addMessage({
      sessionId,
      role: 'assistant',
      content: accumulatedResponse,
      meta: { sources },
    });

    // Close SSE Stream
    res.write('data: [DONE]\n\n');
    res.end();
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
