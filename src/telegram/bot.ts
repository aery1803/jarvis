import os from 'node:os';
import {
  TelegramUpdate,
  TelegramMessage,
  SendMessageOptions,
  InlineKeyboardMarkup,
} from './types.js';
import { SessionManager } from '../sessions/manager.js';
import { MemoryManager } from '../memory/manager.js';
import { KillSwitch } from '../security/kill-switch.js';
import { LLMProvider, OllamaProvider } from '../services/provider.js';
import { SearXNGClient } from '../services/searxng.js';
import { ContentDistiller } from '../services/scraper.js';
import { ConsensusEngine } from '../services/consensus.js';
import { CognitionEngine } from '../agents/cognition.js';
import { ModelBenchmarkSuite } from '../eval/benchmark.js';
import { ModelProvisioner } from '../orchestration/provisioner.js';
import { config } from '../config.js';

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
  private activeSessions = new Map<string, string>(); // userId -> sessionId
  private searchClient: SearXNGClient;
  private distiller: ContentDistiller;
  private consensus: ConsensusEngine;

  constructor(private options: TelegramBotOptions) {
    this.token = options.token;
    this.ownerId = options.ownerId;
    this.baseUrl = options.baseUrl ?? `https://api.telegram.org/bot${this.token}`;
    this.searchClient = new SearXNGClient({ enableFallback: true });
    this.distiller = new ContentDistiller();
    this.consensus = new ConsensusEngine();
  }

  getOwnerId(): string {
    return this.ownerId;
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
      const msg = await this.apiCall<TelegramMessage>('sendMessage', {
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
    return this.apiCall<TelegramMessage>('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: options.parse_mode,
      reply_markup: options.reply_markup,
    });
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
            `- \`/model <name>\` - Switch active model (e.g. qwen2.5-coder:1.5b)\n` +
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
        const models = this.options.llmProvider?.listModels ? await this.options.llmProvider.listModels() : ['qwen2.5:7b', 'qwen2.5-coder:1.5b'];
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

      case '/benchmark': {
        const targetModel = args[0]?.trim() || this.options.llmProvider?.getModel?.() || 'qwen2.5:7b';
        await this.sendMessage(
          chatId,
          `⏳ *Starting Intelligence Benchmark for:* \`${targetModel}\`...\nEvaluating Reasoning, Coding, Tool Calling, and Retrieval. Please wait 10-20 seconds.`
        );
        await this.sendAction(chatId, 'typing');
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
        break;
      }

      case '/research': {
        const query = args.join(' ').trim();
        if (!query) {
          await this.sendMessage(chatId, `Please provide a query: \`/research <topic>\``);
          break;
        }
        await this.sendAction(chatId, 'typing');
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
          this.activeSessions.set(userId, sess.id);
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
            const current = this.activeSessions.get(userId);
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
            this.activeSessions.set(userId, sess.id);
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

    // Ensure session exists
    let sessionId = this.activeSessions.get(userId);
    if (!sessionId && this.options.sessionManager) {
      const sess = await this.options.sessionManager.createSession(userId, 'Default Session');
      sessionId = sess.id;
      this.activeSessions.set(userId, sessionId);
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

    // Send typing action
    await this.sendAction(chatId, 'typing');

    // Assemble memory prompt context
    let contextPrompt = '';
    if (this.options.memoryManager && sessionId) {
      const ctx = await this.options.memoryManager.buildPromptContext({
        userId,
        sessionId,
        maxTokens: 1000,
        includeTiers: ['T1', 'T2'],
      });
      contextPrompt = ctx.systemPromptAdditions;
    }

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
        }
      } catch {
        // Fallback silently if network/SearXNG offline
      }
    }

    // Generate response using local LLM provider if configured
    let responseText = '';
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

    const finalMessage = taskTag ? `${taskTag}\n\n${responseText}${sourcesFooter}` : `${responseText}${sourcesFooter}`;
    await this.sendMessage(chatId, finalMessage);
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
      } catch {
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
