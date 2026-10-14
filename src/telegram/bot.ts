import os from 'node:os';
import type {
  TelegramUpdate,
  TelegramMessage,
  SendMessageOptions,
  InlineKeyboardMarkup,
} from './types.js';
import { SessionManager } from '../sessions/manager.js';
import type { NewJarvisMessage } from '../sessions/types.js';
import { MemoryManager } from '../memory/manager.js';
import { KillSwitch } from '../security/kill-switch.js';
import { type LLMProvider, OllamaProvider } from '../services/provider.js';
import { SearXNGClient } from '../services/searxng.js';
import { ContentDistiller } from '../services/scraper.js';
import { ConsensusEngine } from '../services/consensus.js';
import { CognitionEngine } from '../agents/cognition.js';
import { ModelBenchmarkSuite } from '../eval/benchmark.js';
import { ModelProvisioner } from '../orchestration/provisioner.js';
import { MultiModelEnsemble } from '../orchestration/ensemble.js';
import {
  buildConversationContext,
  contextBudgetFor,
  parseRememberCommand,
  recordTaskEpisode,
  resolveSummarizer,
  shouldSummarize,
  summarizeAndStoreSession,
  type ConversationTurn,
} from '../memory/context-builder.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

/** Most recent stored turns offered to the context builder (T0); older ones are covered by T2 summaries. */
const MAX_CONTEXT_TURNS = 60;
/** `SessionManager` channel key for the active-session pointer, shared with no other surface. */
const TELEGRAM_CHANNEL = 'telegram';

export interface TelegramBotOptions {
  token: string;
  ownerId: string;
  baseUrl?: string;
  sessionManager?: SessionManager;
  memoryManager?: MemoryManager;
  killSwitch?: KillSwitch;
  llmProvider?: LLMProvider;
}

export class TelegramBotClient {
  private token: string;
  private ownerId: string;
  private baseUrl: string;
  private isPolling = false;
  private pollingOffset = 0;
  private searchClient: SearXNGClient;
  private distiller: ContentDistiller;
  private consensus: ConsensusEngine;
  private ensemble: MultiModelEnsemble;
  private ensembleMode = false;

  constructor(private options: TelegramBotOptions) {
    this.token = options.token;
    this.ownerId = options.ownerId;
    this.baseUrl = options.baseUrl ?? `https://api.telegram.org/bot${this.token}`;
    this.searchClient = new SearXNGClient({ enableFallback: true });
    this.distiller = new ContentDistiller();
    this.consensus = new ConsensusEngine();
    this.ensemble = new MultiModelEnsemble();
  }

  getOwnerId(): string {
    return this.ownerId;
  }

  /**
   * Runs an asynchronous operation while pulsing continuous 'typing' actions to Telegram.
   * Prevents the typing indicator from expiring during long searches, downloads, or inference.
   */
  async withTypingIndicator<T>(chatId: number | string, action: () => Promise<T>): Promise<T> {
    await this.sendAction(chatId, 'typing').catch(() => {});
    const interval = setInterval(() => {
      this.sendAction(chatId, 'typing').catch(() => {});
    }, 3500);

    try {
      return await action();
    } finally {
      clearInterval(interval);
    }
  }

  async apiCall<T>(method: string, body?: Record<string, unknown>): Promise<T> {
    const url = `${this.baseUrl}/${method}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });

    const data = (await res.json()) as { ok: boolean; result: T; description?: string };
    if (!data.ok) {
      throw new Error(`Telegram API error [${method}]: ${data.description ?? 'Unknown error'}`);
    }
    return data.result;
  }

  splitMessage(text: string, maxLen = 4000): string[] {
    if (text.length <= maxLen) {
      return [text];
    }
    const chunks: string[] = [];
    let current = '';

    const lines = text.split('\n');
    for (const line of lines) {
      if ((current + '\n' + line).length > maxLen) {
        if (current) {
          chunks.push(current);
          current = '';
        }
        if (line.length > maxLen) {
          // Hard split line if exceptionally long
          let start = 0;
          while (start < line.length) {
            chunks.push(line.slice(start, start + maxLen));
            start += maxLen;
          }
        } else {
          current = line;
        }
      } else {
        current = current ? current + '\n' + line : line;
      }
    }
    if (current) {
      chunks.push(current);
    }
    return chunks;
  }

  async sendMessage(
    chatId: number | string,
    text: string,
    options: SendMessageOptions = {}
  ): Promise<TelegramMessage[]> {
    const chunks = this.splitMessage(text);
    const results: TelegramMessage[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      // Attach reply_markup only to the last chunk
      const markup = i === chunks.length - 1 ? options.reply_markup : undefined;
      const msg = await this.callWithPlainTextFallback<TelegramMessage>('sendMessage', {
        chat_id: chatId,
        text: chunk,
        parse_mode: options.parse_mode,
        reply_markup: markup,
      });
      results.push(msg);
    }

    return results;
  }

  async editMessageText(
    chatId: number | string,
    messageId: number,
    text: string,
    options: SendMessageOptions = {}
  ): Promise<TelegramMessage> {
    return this.callWithPlainTextFallback<TelegramMessage>('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: options.parse_mode,
      reply_markup: options.reply_markup,
    });
  }

  /**
   * Telegram rejects the whole message with a 400 "can't parse entities" when Markdown in model output is
   * unbalanced (`_`, `*`, `[`, backticks). Resend once without `parse_mode`, so the text arrives as plain
   * text instead of being dropped; any other error still propagates.
   */
  private async callWithPlainTextFallback<T>(method: string, body: Record<string, unknown>): Promise<T> {
    try {
      return await this.apiCall<T>(method, body);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (!body.parse_mode || !/can't parse entities|Bad Request/i.test(message)) {
        throw err;
      }
      logger.warn(`[TelegramBot] ${method} rejected with parse_mode=${String(body.parse_mode)} (${message}); resending as plain text.`);
      const { parse_mode: _rejectedParseMode, ...plainBody } = body;
      return this.apiCall<T>(method, plainBody);
    }
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<boolean> {
    return this.apiCall<boolean>('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text,
    });
  }

  async sendAction(chatId: number | string, action = 'typing'): Promise<boolean> {
    return this.apiCall<boolean>('sendChatAction', {
      chat_id: chatId,
      action,
    });
  }

  async getUpdates(offset?: number, timeout = 30): Promise<TelegramUpdate[]> {
    return this.apiCall<TelegramUpdate[]>('getUpdates', {
      offset: offset ?? this.pollingOffset,
      timeout,
    });
  }

  // --- Update Dispatcher & Security Allow-list ---

  async handleUpdate(update: TelegramUpdate): Promise<void> {
    // 1. Handle Callback Queries (Tier 2 Approvals)
    if (update.callback_query) {
      await this.handleCallbackQuery(update.callback_query);
      return;
    }

    // 2. Handle Text Messages
    if (update.message && update.message.text) {
      await this.handleTextMessage(update.message);
    }
  }

  private isAuthorized(userId?: number): boolean {
    if (!userId) {
      return false;
    }
    // If ownerId is configured, enforce strict match
    if (this.ownerId && this.ownerId.trim().length > 0) {
      return userId.toString() === this.ownerId.trim();
    }
    // If no owner ID configured, default to true in standalone test environments
    return true;
  }

  private async handleCallbackQuery(cb: NonNullable<TelegramUpdate['callback_query']>): Promise<void> {
    const senderId = cb.from?.id;
    if (!this.isAuthorized(senderId)) {
      if (this.options.killSwitch) {
        await this.options.killSwitch.logAudit({
          eventType: 'AUTH_FAILURE',
          actor: `telegram:${senderId}`,
          details: { action: 'unauthorized_callback', data: cb.data },
        });
      }
      await this.answerCallbackQuery(cb.id, 'Unauthorized: Access restricted to Jarvis owner.');
      return;
    }

    const data = cb.data ?? '';
    const chatId = cb.message?.chat.id;
    const messageId = cb.message?.message_id;

    if (data.startsWith('approve:')) {
      const actionId = data.replace('approve:', '');
      if (this.options.killSwitch) {
        await this.options.killSwitch.logAudit({
          eventType: 'ACTION_APPROVED',
          actor: `telegram:${senderId}`,
          details: { actionId },
        });
      }
      await this.answerCallbackQuery(cb.id, 'Action Approved.');
      if (chatId && messageId) {
        await this.editMessageText(chatId, messageId, `[APPROVED] Action ${actionId} approved by owner.`);
      }
    } else if (data.startsWith('reject:')) {
      const actionId = data.replace('reject:', '');
      if (this.options.killSwitch) {
        await this.options.killSwitch.logAudit({
          eventType: 'ACTION_REJECTED',
          actor: `telegram:${senderId}`,
          details: { actionId },
        });
      }
      await this.answerCallbackQuery(cb.id, 'Action Rejected.');
      if (chatId && messageId) {
        await this.editMessageText(chatId, messageId, `[REJECTED] Action ${actionId} rejected by owner.`);
      }
    }
  }

  private async handleTextMessage(msg: TelegramMessage): Promise<void> {
    const senderId = msg.from?.id;
    const chatId = msg.chat.id;
    const text = (msg.text ?? '').trim();

    // Verify security allow-list
    if (!this.isAuthorized(senderId)) {
      if (this.options.killSwitch) {
        await this.options.killSwitch.logAudit({
          eventType: 'AUTH_FAILURE',
          actor: `telegram:${senderId}`,
          details: { text },
        });
      }
      await this.sendMessage(chatId, 'Access Denied: This Jarvis instance is configured for exclusive private use by its owner.');
      return;
    }

    const userId = senderId?.toString() ?? 'owner';

    if (!this.ownerId) {
      console.log(`[Jarvis Telegram Service] Incoming message from user ID ${senderId} (@${msg.from?.username ?? 'anonymous'}). Set TELEGRAM_OWNER_ID=${senderId} in settings.env to lock access.`);
    }

    // Route slash commands
    if (text.startsWith('/')) {
      await this.handleCommand(chatId, userId, text);
      return;
    }

    // Regular conversation message
    await this.handleChatMessage(chatId, userId, text);
  }

  private async handleCommand(chatId: number, userId: string, text: string): Promise<void> {
    const [command, ...args] = text.split(' ');
    const cmd = command.toLowerCase();

    switch (cmd) {
      case '/start':
      case '/help':
        await this.sendMessage(
          chatId,
          `*Jarvis Local AI Assistant (Phase 2 & 3)*\n\n` +
            `*Available Commands:*\n` +
            `- \`/status\` - Workstation specs, free memory & state\n` +
            `- \`/id\` - Show your numeric Telegram User ID\n` +
            `- \`/models\` - List available local models\n` +
            `- \`/model <name>\` - Switch active model (e.g. qwen2.5-coder:7b)\n` +
            `- \`/ensemble [on|off|<query>]\` - Query multiple models simultaneously\n` +
            `- \`/benchmark [model]\` - Run intelligence benchmark & report score\n` +
            `- \`/research <query>\` - Run multi-source research on any topic\n` +
            `- \`/new <name>\` - Start a new isolated workspace session\n` +
            `- \`/sessions\` - List recent conversation sessions\n` +
            `- \`/switch <id>\` - Switch active session\n` +
            `- \`/tasks\` - List active task queue & statuses\n` +
            `- \`/memory\` - View owner profile and preferences\n` +
            `- \`/kill\` - Emergency kill switch: cancel all active tasks\n` +
            `- \`/help\` - Show this manual\n\n` +
            `Send any question or task to chat directly.`
        );
        break;

      case '/models': {
        const models = this.options.llmProvider?.listModels ? await this.options.llmProvider.listModels() : ['qwen2.5:7b', 'qwen2.5-coder:7b'];
        const current = this.options.llmProvider?.getModel?.() ?? 'qwen2.5:7b';
        const modelList = models.map((m) => `- \`${m}\`${m === current ? ' *(active)*' : ''}`).join('\n');
        await this.sendMessage(
          chatId,
          `*Installed Local Models:*\n\n${modelList}\n\nSwitch models using: \`/model <name>\``
        );
        break;
      }

      case '/model': {
        const targetModel = args[0]?.trim();
        if (!targetModel) {
          await this.sendMessage(chatId, `Please specify a model: \`/model <name>\`\nRun \`/models\` to see available models.`);
          break;
        }
        if (this.options.llmProvider?.setModel) {
          this.options.llmProvider.setModel(targetModel);
          await this.sendMessage(chatId, `Switched active model to: *${targetModel}*`);
        } else {
          await this.sendMessage(chatId, `Active LLM provider does not support dynamic switching.`);
        }
        break;
      }

      case '/ensemble': {
        const sub = args[0]?.toLowerCase().trim();
        if (sub === 'on') {
          this.ensembleMode = true;
          await this.sendMessage(chatId, `✅ *Ensemble Mode Enabled:* Jarvis will now query multiple local models simultaneously for every prompt.`);
          break;
        }
        if (sub === 'off') {
          this.ensembleMode = false;
          await this.sendMessage(chatId, `ℹ️ *Ensemble Mode Disabled:* Jarvis will route prompts to single optimal specialized models.`);
          break;
        }
        const query = args.join(' ').trim();
        if (!query) {
          const status = this.ensembleMode ? 'ENABLED (Always Active)' : 'DISABLED (Single Model)';
          await this.sendMessage(chatId, `*Multi-Model Ensemble Status:* ${status}\n\n*Usage:*\n- \`/ensemble on\` - Enable simultaneous multi-model execution\n- \`/ensemble off\` - Disable ensemble mode\n- \`/ensemble <query>\` - Query multiple models simultaneously right now`);
          break;
        }

        await this.withTypingIndicator(chatId, async () => {
          try {
            const result = await this.ensemble.generateSimultaneous(query);
            const formatted = MultiModelEnsemble.formatEnsembleResponse(result, true);
            await this.sendMessage(chatId, formatted);
          } catch (err: any) {
            await this.sendMessage(chatId, `Ensemble execution error: ${err.message}`);
          }
        });
        break;
      }

      case '/benchmark': {
        const targetModel = args[0]?.trim() || this.options.llmProvider?.getModel?.() || 'qwen2.5:7b';
        await this.sendMessage(
          chatId,
          `⏳ *Starting Intelligence Benchmark for:* \`${targetModel}\`...\nEvaluating Reasoning, Coding, Tool Calling, and Retrieval. Please wait 10-20 seconds.`
        );
        await this.withTypingIndicator(chatId, async () => {
          try {
            const suite = new ModelBenchmarkSuite();
            let benchProvider = this.options.llmProvider;
            if (!benchProvider || benchProvider.getModel() !== targetModel) {
              benchProvider = new OllamaProvider({ baseUrl: config.ollamaBaseUrl, model: targetModel });
            }
            const card = await suite.runBenchmark(benchProvider);
            const reportMd = ModelBenchmarkSuite.formatMarkdownReport(card);
            await this.sendMessage(chatId, reportMd);
          } catch (err: any) {
            await this.sendMessage(chatId, `Benchmark failed: ${err.message}`);
          }
        });
        break;
      }

      case '/research': {
        const query = args.join(' ').trim();
        if (!query) {
          await this.sendMessage(chatId, `Please provide a query: \`/research <topic>\``);
          break;
        }
        await this.withTypingIndicator(chatId, async () => {
          try {
            const results = await this.searchClient.search(query, { maxResults: 3 });
            const extracted = results.map((r) => this.distiller.extractText(r.snippet, r.url));
            const report = this.consensus.buildReport([
              {
                claim: query,
                sources: extracted.map((e) => ({ source: e.url, excerpt: e.content })),
              },
            ]);
            const sources = extracted.map((e) => `- ${e.url}`).join('\n');
            await this.sendMessage(
              chatId,
              `*Deep Research: ${query}*\n\n` +
                `*Consensus Confidence:* ${(report.overallScore * 100).toFixed(0)}%\n\n` +
                `*Synthesized Findings:*\n${extracted.map((e) => e.content).join('\n\n')}\n\n` +
                `📚 *Sources:*\n${sources}`
            );
          } catch (err: any) {
            await this.sendMessage(chatId, `Research error: ${err.message}`);
          }
        });
        break;
      }

      case '/id':
      case '/myid': {
        await this.sendMessage(
          chatId,
          `*Your Telegram User ID:* \`${userId}\`\n\n` +
            `To restrict Jarvis strictly to your account, add this line to \`%USERPROFILE%\\.jarvis\\settings.env\`:\n` +
            `\`TELEGRAM_OWNER_ID=${userId}\``
        );
        break;
      }

      case '/status': {
        const freeRamGb = (os.freemem() / (1024 * 1024 * 1024)).toFixed(2);
        const totalRamGb = (os.totalmem() / (1024 * 1024 * 1024)).toFixed(2);
        const isKilled = this.options.killSwitch?.isKilled() ?? false;
        await this.sendMessage(
          chatId,
          `*Jarvis System Status*\n\n` +
            `- *Host:* ${os.hostname()} (${os.platform()} ${os.arch()})\n` +
            `- *Memory:* ${freeRamGb} GB free / ${totalRamGb} GB total\n` +
            `- *Headroom Check:* ${parseFloat(freeRamGb) >= 14 ? 'PASS (>= 14 GB)' : 'WARN (< 14 GB)'}\n` +
            `- *Kill Switch:* ${isKilled ? 'TRIGGERED (System halted)' : 'ARMED (Normal operation)'}\n` +
            `- *Inference:* Local Ollama / Vulkan Radeon 8060S`
        );
        break;
      }

      case '/new': {
        const title = args.join(' ').trim() || 'New Workspace';
        if (this.options.sessionManager) {
          const sess = await this.options.sessionManager.createSession(userId, title);
          await this.options.sessionManager.setActiveSession(userId, TELEGRAM_CHANNEL, sess.id);
          await this.sendMessage(chatId, `Created and switched to session: *${sess.title}* (\`${sess.id}\`)`);
        } else {
          await this.sendMessage(chatId, `Session manager not configured.`);
        }
        break;
      }

      case '/sessions': {
        if (this.options.sessionManager) {
          const sessions = await this.options.sessionManager.listSessions(userId);
          if (sessions.length === 0) {
            await this.sendMessage(chatId, `No sessions found. Create one with \`/new <name>\`.`);
          } else {
            const current = (await this.options.sessionManager.getActiveSession(userId, TELEGRAM_CHANNEL))?.id;
            const lines = sessions.slice(0, 8).map((s) => {
              const activeMarker = s.id === current ? ' *(active)*' : '';
              return `- *${s.title}*${activeMarker}\n  ID: \`${s.id}\``;
            });
            await this.sendMessage(chatId, `*Recent Sessions:*\n\n${lines.join('\n\n')}`);
          }
        }
        break;
      }

      case '/switch': {
        const targetId = args[0]?.trim();
        if (!targetId) {
          await this.sendMessage(chatId, `Usage: \`/switch <sessionId>\``);
          return;
        }
        if (this.options.sessionManager) {
          const sess = await this.options.sessionManager.getSession(userId, targetId);
          if (sess) {
            await this.options.sessionManager.setActiveSession(userId, TELEGRAM_CHANNEL, sess.id);
            await this.sendMessage(chatId, `Switched to session: *${sess.title}*`);
          } else {
            await this.sendMessage(chatId, `Session not found: \`${targetId}\``);
          }
        }
        break;
      }

      case '/tasks': {
        if (this.options.sessionManager) {
          const tasks = await this.options.sessionManager.listTasks({ userId });
          if (tasks.length === 0) {
            await this.sendMessage(chatId, `No tasks in queue.`);
          } else {
            const lines = tasks.slice(0, 10).map((t) => {
              return `- ${this.options.sessionManager!.formatTaskTag(t)} [${t.status.toUpperCase()}]`;
            });
            await this.sendMessage(chatId, `*Active Tasks:*\n\n${lines.join('\n')}`);
          }
        }
        break;
      }

      case '/memory': {
        if (this.options.memoryManager) {
          const facts = await this.options.memoryManager.getProfileFacts(userId);
          if (facts.length === 0) {
            await this.sendMessage(chatId, `No profile facts saved yet.`);
          } else {
            const lines = facts.map((f) => `- *${f.key}*: ${f.value} (${f.category})`);
            await this.sendMessage(chatId, `*Owner Profile Facts:*\n\n${lines.join('\n')}`);
          }
        }
        break;
      }

      case '/kill': {
        if (this.options.killSwitch) {
          const res = await this.options.killSwitch.trigger(`telegram:${userId}`, 'Emergency stop command (/kill)');
          await this.sendMessage(
            chatId,
            `*EMERGENCY STOP TRIGGERED*\n\nAll background tasks aborted (${res.tasksAborted} cancelled).\nSystem execution halted.`
          );
        }
        break;
      }

      default:
        await this.sendMessage(chatId, `Unknown command: \`${cmd}\`. Use \`/help\` for available commands.`);
        break;
    }
  }

  private async handleChatMessage(chatId: number, userId: string, text: string): Promise<void> {
    // Check kill switch
    if (this.options.killSwitch?.isKilled()) {
      await this.sendMessage(
        chatId,
        `*System Halted*: Jarvis is currently stopped via Emergency Kill Switch (${this.options.killSwitch.getKillReason()}).`
      );
      return;
    }

    // Ensure session exists. The active session is persisted, so after a restart the conversation continues.
    let sessionId = (await this.options.sessionManager?.getActiveSession(userId, TELEGRAM_CHANNEL))?.id;
    if (!sessionId && this.options.sessionManager) {
      const sess = await this.options.sessionManager.createSession(userId, 'Default Session');
      sessionId = sess.id;
      await this.options.sessionManager.setActiveSession(userId, TELEGRAM_CHANNEL, sessionId);
    }

    // Create task
    let taskTag = '';
    if (this.options.sessionManager && sessionId) {
      const task = await this.options.sessionManager.createTask({
        userId,
        sessionId,
        title: text.slice(0, 30),
        priority: 10, // interactive priority
      });
      taskTag = this.options.sessionManager.formatTaskTag(task);
    }

    const startedAt = Date.now();
    const memorySessionId = sessionId ?? 'default';
    // History is read before this message is stored, so the prompt is not duplicated into its own context.
    // It includes turns written by the web chat when the session was started or continued there.
    const history: ConversationTurn[] =
      this.options.sessionManager && sessionId
        ? (await this.options.sessionManager.getMessages(userId, sessionId)).map((m) => ({ role: m.role, content: m.content }))
        : [];
    const priorTurns = history.slice(-MAX_CONTEXT_TURNS);
    await this.saveTurn(userId, sessionId, { role: 'user', content: text });

    // Explicit memory writes happen before the context is built, so the fact is usable in this same reply.
    const rememberedFact = parseRememberCommand(text);
    if (rememberedFact && this.options.memoryManager) {
      try {
        await this.options.memoryManager.setProfileFact(userId, rememberedFact.key, rememberedFact.value, 'preference');
      } catch (err: unknown) {
        logger.warn(`[TelegramBot] Could not store profile fact: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const turn = await this.withTypingIndicator(chatId, async () => {
      // Assemble memory prompt context (T1 profile, T2 other sessions, T4 knowledge, T0 this conversation)
      const ctx = await buildConversationContext({
        memory: this.options.memoryManager,
        userId,
        sessionId: memorySessionId,
        prompt: text,
        turns: priorTurns,
        maxTokens: contextBudgetFor([text]),
      });
      const contextPrompt = ctx.text;

      // Dynamic JIT model routing & on-demand provisioning
      let activeTaskType: 'chat' | 'code' | 'reasoning' = 'chat';
      const previousModel = this.options.llmProvider?.getModel?.();
      if (this.options.llmProvider) {
        const provisioner = new ModelProvisioner(this.options.llmProvider);
        const decision = await provisioner.ensureAndDispatch({
          prompt: text,
          onProgress: async (msg) => {
            await this.sendMessage(chatId, msg);
            await this.sendAction(chatId, 'typing');
          },
        });
        activeTaskType = decision.category === 'code' ? 'code' : decision.category === 'reasoning' ? 'reasoning' : 'chat';
      }

      // Automated research augmentation for questions & factual lookups
      let researchFacts = '';
      let sourcesFooter = '';
      let sources: string[] = [];
      const lower = text.toLowerCase();
      const isQuestion = lower.includes('?') || ['search', 'find', 'what', 'why', 'how', 'who', 'where', 'when', 'explain', 'tell me', 'lookup', 'research', 'latest', 'news', 'specs', 'architecture'].some((k) => lower.includes(k));

      if (isQuestion) {
        try {
          const searchResults = await this.searchClient.search(text, { maxResults: 3 });
          if (searchResults.length > 0) {
            const extracted = searchResults.map((r) => this.distiller.extractText(r.snippet, r.url));
            const report = this.consensus.buildReport([
              {
                claim: text,
                sources: extracted.map((e) => ({ source: e.url, excerpt: e.content })),
              },
            ]);
            researchFacts = `\n[Verified Research Facts]:\n${extracted.map((e, idx) => `[Source ${idx + 1}]: ${e.content}`).join('\n')}\nConsensus Score: ${(report.overallScore * 100).toFixed(0)}%\n`;
            sourcesFooter = `\n\n📚 *Sources:*\n${extracted.map((e) => `- ${e.url}`).join('\n')}`;
            sources = extracted.map((e) => e.url);
          }
        } catch {
          // Fallback silently if network/SearXNG offline
        }
      }

      // Simultaneous Multi-Model Ensemble Generation (if enabled or requested)
      const wantsEnsemble = this.ensembleMode || lower.includes('ensemble') || lower.includes('both models') || lower.includes('compare models');
      let responseText = '';

      if (wantsEnsemble) {
        try {
          const ensembleResult = await this.ensemble.generateSimultaneous(text, {
            taskType: activeTaskType === 'code' ? 'code' : activeTaskType === 'reasoning' ? 'reasoning' : isQuestion ? 'research' : 'chat',
            memoryContext: contextPrompt,
            researchFacts,
          });
          responseText = MultiModelEnsemble.formatEnsembleResponse(ensembleResult, lower.includes('compare'));
        } catch (err: any) {
          // Fallback to single model if ensemble failed
          logger.warn(`[TelegramBot] Ensemble failed, falling back to single model: ${err.message}`);
        }
      }

      // Standard single-model inference fallback
      let completed = Boolean(responseText);
      if (!responseText) {
        if (this.options.llmProvider) {
          try {
            const fullPrompt = CognitionEngine.formatPrompt(text, {
              taskType: activeTaskType === 'code' ? 'code' : activeTaskType === 'reasoning' ? 'reasoning' : isQuestion ? 'research' : 'chat',
              memoryContext: contextPrompt,
              researchFacts,
              activeModel: this.options.llmProvider.getModel(),
            });
            const res = await this.options.llmProvider.generate(fullPrompt);
            responseText = typeof res === 'string' ? res : (res as any)?.text ?? String(res);
            completed = true;
          } catch (err: any) {
            responseText = `Inference failed: ${err.message}`;
          } finally {
            if (previousModel && this.options.llmProvider?.setModel) {
              this.options.llmProvider.setModel(previousModel);
            }
          }
        } else {
          responseText = `Jarvis received your request in ${taskTag || 'session'}.\n\n"${text}"`;
        }
      }

      const finalMessage = taskTag ? `${taskTag}\n\n${responseText}${sourcesFooter}` : `${responseText}${sourcesFooter}`;
      await this.sendMessage(chatId, finalMessage);
      return { responseText, completed, sources };
    });

    // Post-turn writes run after the reply is sent, so they never delay it.
    await this.saveTurn(userId, sessionId, {
      role: 'assistant',
      content: turn.responseText,
      meta: turn.sources.length > 0 ? { sources: turn.sources } : undefined,
    });
    const turns: ConversationTurn[] = [...history, { role: 'user', content: text }, { role: 'assistant', content: turn.responseText }];
    if (turn.completed) {
      await recordTaskEpisode(this.options.memoryManager, {
        userId,
        sessionId: memorySessionId,
        goal: text,
        outcome: turn.responseText,
        executionTimeMs: Date.now() - startedAt,
      });
    }
    if (this.options.llmProvider && this.options.memoryManager && shouldSummarize(turns.length)) {
      const summarizer = await resolveSummarizer(this.options.llmProvider);
      await summarizeAndStoreSession({
        memory: this.options.memoryManager,
        summarizer,
        userId,
        sessionId: memorySessionId,
        turns,
      });
    }
  }

  /**
   * Stores a turn in the session. The session can be deleted from the web while a reply is being
   * generated; the reply still goes out, so a failed write is logged instead of thrown.
   */
  private async saveTurn(userId: string, sessionId: string | undefined, message: NewJarvisMessage): Promise<void> {
    if (!this.options.sessionManager || !sessionId) {
      return;
    }
    try {
      await this.options.sessionManager.addMessage(userId, sessionId, message);
    } catch (err: unknown) {
      logger.warn(`[TelegramBot] ${message.role} turn not saved: ${err instanceof Error ? err.message : String(err)}`, { sessionId });
    }
  }

  /**
   * Helper to send an interactive Tier 2 Action Approval keyboard
   */
  async sendApprovalRequest(
    chatId: number | string,
    actionId: string,
    actionDescription: string
  ): Promise<TelegramMessage[]> {
    const keyboard: InlineKeyboardMarkup = {
      inline_keyboard: [
        [
          { text: 'Approve', callback_data: `approve:${actionId}` },
          { text: 'Reject', callback_data: `reject:${actionId}` },
        ],
      ],
    };

    return this.sendMessage(
      chatId,
      `*Action Approval Required (Tier 2)*\n\n` +
        `*Action ID:* \`${actionId}\`\n` +
        `*Details:* ${actionDescription}\n\n` +
        `Please confirm execution:`,
      { reply_markup: keyboard }
    );
  }

  // --- Long Polling Runner ---

  async startPolling(pollIntervalMs = 1000): Promise<void> {
    this.isPolling = true;

    while (this.isPolling) {
      try {
        const updates = await this.getUpdates(this.pollingOffset, 20);
        for (const update of updates) {
          if (update.update_id >= this.pollingOffset) {
            this.pollingOffset = update.update_id + 1;
          }
          await this.handleUpdate(update);
        }
      } catch (err: unknown) {
        logger.warn(`[TelegramBot] Polling or update handling failed: ${err instanceof Error ? err.message : String(err)}`);
        // Pacing delay on network error
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  stopPolling(): void {
    this.isPolling = false;
  }
}
