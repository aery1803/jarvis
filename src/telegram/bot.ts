/**
 * Jarvis Local AI Agent: Telegram Surface
 * Authority: FEAT-004, Section 6.2 (owner approval), CODING_RULES.md section 5
 *
 * A thin surface over the shared `JarvisRuntime`: chat goes through `runChatTurn` (the same pipeline the web UI
 * uses), commands live in `commands.ts`, and Tier 2 approvals are asked of the owner through the runtime's
 * `ApprovalBroker`. Authorization fails closed: with no `TELEGRAM_OWNER_ID` nobody is served unless the
 * development opt-in `JARVIS_TELEGRAM_OPEN=1` is set (and even then no approval can be granted from Telegram).
 */

import type {
  TelegramUpdate,
  TelegramMessage,
  TelegramFile,
  SendMessageOptions,
  InlineKeyboardMarkup,
  TelegramCallbackQuery,
} from './types.js';
import type { JarvisRuntime } from '../runtime/runtime.js';
import type { ApprovalNotifier, ApprovalRequest } from '../security/approvals.js';
import type { ApprovalArgMetadata } from '../security/approval-text.js';
import { runChatTurn, type TurnEvent, type TurnResult } from '../chat/pipeline.js';
import { buildConversationContext, contextBudgetFor, type ConversationTurn } from '../memory/context-builder.js';
import { MultiModelEnsemble, type EnsembleResult } from '../orchestration/ensemble.js';
import { installedFromDiagnostics } from '../orchestration/vram.js';
import type { ModelDefinition } from '../orchestration/registry.js';
import { MAX_IMAGE_BYTES } from '../media/service.js';
import { redactSensitive } from '../memory/sensitive.js';
import { readSetting } from '../config.js';
import { logger } from '../utils/logger.js';
import { findCommand, parseCommand, type CommandContext, type CommandSpec, type UserState, type WorkHandle } from './commands.js';
import { code, esc, oneLine, unescapeMarkdown } from './format.js';
import type { ParsedCommand } from './commands.js';

/** `SessionManager` channel key for the active-session pointer, shared with no other surface. */
const TELEGRAM_CHANNEL = 'telegram';
const POLL_STATE_COLLECTION = 'telegram_state';
const POLL_STATE_ID = 'poll';
const USER_STATE_COLLECTION = 'telegram_user_state';
const DEFAULT_POLL_TIMEOUT_SEC = 25;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const FILE_DOWNLOAD_TIMEOUT_MS = 60_000;
const MAX_STATUS_MESSAGES_PER_TURN = 6;
const MAX_PROGRESS_TOOL_MESSAGES_PER_TURN = 6;
const MAX_RETRY_AFTER_SEC = 30;
const STRANGER_REPLY_INTERVAL_MS = 60_000;
const MAX_ENSEMBLE_MODELS = 3;
const ENSEMBLE_LANES = new Set(['resident', 'fast', 'balanced', 'deep', 'code']);
const APPROVE_PREFIX = 'ap:1:';
const DENY_PREFIX = 'ap:0:';
/** Telegram rejects `callback_data` over 64 bytes. */
const MAX_CALLBACK_DATA_BYTES = 64;
/** How long `/sessions` numbers stay valid for `/switch` and `/delete`. */
const SHOWN_SESSIONS_TTL_MS = 30 * 60_000;
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** The bot's numeric id is the part of the token before the colon. */
function botIdFromToken(token: string): string | null {
  return /^(\d+):/.exec(token)?.[1] ?? null;
}

/**
 * Cuts one over-long line into pieces of at most `maxLen` UTF-16 units without splitting a grapheme cluster
 * (an emoji with a modifier or ZWJ sequence, a base letter with combining marks) or a surrogate pair. A single
 * cluster longer than `maxLen` falls back to code points, which still never split a surrogate pair.
 */
function splitLongLine(line: string, maxLen: number): string[] {
  const pieces: string[] = [];
  let current = '';
  const push = (unit: string): void => {
    if (current.length + unit.length > maxLen) {
      pieces.push(current);
      current = '';
    }
    current += unit;
  };
  for (const { segment } of GRAPHEME_SEGMENTER.segment(line)) {
    if (segment.length <= maxLen) push(segment);
    else for (const point of segment) push(point);
  }
  if (current) pieces.push(current);
  return pieces;
}

/** Whether the development opt-in that lets any Telegram user in (when no owner is configured) is set. */
export function isTelegramOpenDevEnabled(): boolean {
  const raw = readSetting('JARVIS_TELEGRAM_OPEN')?.toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

export interface TelegramBotOptions {
  token: string;
  /** The owner's numeric Telegram user id. Empty means unconfigured: nobody is served unless `allowOpenDev` is set. */
  ownerId: string;
  runtime: JarvisRuntime;
  /** Bot API base (`https://api.telegram.org/bot<token>`); tests point it elsewhere. */
  baseUrl?: string;
  /** File download base (`https://api.telegram.org/file/bot<token>`). */
  fileBaseUrl?: string;
  /** Development only: serve every Telegram user when `ownerId` is empty. Defaults to `isTelegramOpenDevEnabled()`. */
  allowOpenDev?: boolean;
  fetchImpl?: typeof fetch;
  /** Long-poll wait passed to `getUpdates`. */
  pollTimeoutSec?: number;
  requestTimeoutMs?: number;
}

export interface ApiCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class TelegramApiError extends Error {
  constructor(
    public readonly method: string,
    description: string,
    public readonly errorCode?: number,
    public readonly retryAfterSec?: number
  ) {
    super(`Telegram API error [${method}]: ${description}`);
    this.name = 'TelegramApiError';
  }
}

interface UserStateDoc {
  id: string;
  explicitModel?: string;
  ensemble: boolean;
}

interface PollStateDoc {
  id: string;
  offset: number;
  botId?: string;
}

interface PendingApprovalMessage {
  chatId: number | string;
  messageId: number;
  summary: string;
}

interface TurnProgress {
  statusSent: number;
  toolSent: number;
  lastStatus: string;
  model: string | null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Strips control characters except newline and tab, so untrusted multi-line text cannot break the layout. */
/** The structured argument list the executor and the approval routes put in `metadata.args`; anything malformed is ignored. */
function structuredApprovalArgs(metadata: Record<string, unknown> | undefined): ApprovalArgMetadata[] {
  const raw = metadata?.args;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is ApprovalArgMetadata =>
      typeof entry === 'object' && entry !== null && typeof (entry as ApprovalArgMetadata).name === 'string' && typeof (entry as ApprovalArgMetadata).omittedChars === 'number'
  );
}

function cleanMultiline(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
  });
}

export class TelegramBotClient {
  private readonly token: string;
  private readonly ownerId: string;
  private readonly baseUrl: string;
  private readonly fileBaseUrl: string;
  private readonly rt: JarvisRuntime;
  private readonly openDev: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly pollTimeoutSec: number;
  private readonly requestTimeoutMs: number;
  private isPolling = false;
  private pollingOffset = 0;
  private pollAbort: AbortController | null = null;
  private readonly chatQueues = new Map<string, Promise<void>>();
  private readonly inflight = new Set<Promise<void>>();
  private readonly userStates = new Map<string, UserState>();
  private readonly approvalMessages = new Map<string, PendingApprovalMessage>();
  private readonly strangerReplies = new Map<string, number>();
  private lastChatId: number | string | null = null;
  private botId: string | null;
  private botUsername: string | null = null;
  private identityVerified = false;
  private notifierDisabled = false;
  private readonly shownSessions = new Map<string, { ids: string[]; at: number }>();

  constructor(options: TelegramBotOptions) {
    this.token = options.token;
    this.botId = botIdFromToken(options.token);
    this.ownerId = (options.ownerId ?? '').trim();
    this.rt = options.runtime;
    this.baseUrl = options.baseUrl ?? `https://api.telegram.org/bot${this.token}`;
    this.fileBaseUrl = options.fileBaseUrl ?? `https://api.telegram.org/file/bot${this.token}`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.pollTimeoutSec = options.pollTimeoutSec ?? DEFAULT_POLL_TIMEOUT_SEC;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.openDev = this.ownerId === '' && (options.allowOpenDev ?? isTelegramOpenDevEnabled());

    if (this.ownerId === '' && this.openDev) {
      logger.warn('[TelegramBot] OPEN DEV MODE: TELEGRAM_OWNER_ID is empty and JARVIS_TELEGRAM_OPEN is set, so EVERY Telegram user can talk to this bot. Tier 2 approvals are disabled in this mode. Never use it outside development.');
    } else if (this.ownerId === '') {
      logger.warn('[TelegramBot] TELEGRAM_OWNER_ID is not set: every request except /id is refused. Send /id to the bot, set TELEGRAM_OWNER_ID, and restart.');
    }
  }

  /**
   * Makes this bot the approval channel. Called only once `getMe` accepted the token, and only with an owner to
   * ask: a bot that cannot deliver must not replace the notifier the web UI relies on, because a throwing
   * notifier makes the broker deny every request at once.
   */
  registerApprovalNotifier(): boolean {
    if (this.ownerId === '') return false;
    this.notifierDisabled = false;
    this.rt.approvals.setNotifier(this.approvalNotifier);
    return true;
  }

  private readonly approvalNotifier: ApprovalNotifier = (request) => {
    if (this.notifierDisabled) return Promise.reject(new Error('The Telegram bot was stopped, so it cannot ask the owner.'));
    return this.notifyApproval(request);
  };

  private unregisterApprovalNotifier(): void {
    this.notifierDisabled = true;
    this.rt.approvals.clearNotifier(this.approvalNotifier);
  }

  getOwnerId(): string {
    return this.ownerId;
  }

  /** True while the bot serves everyone because of the development opt-in. */
  isOpenDevMode(): boolean {
    return this.openDev;
  }

  // --- Telegram transport ---

  /**
   * Runs an asynchronous operation while pulsing continuous 'typing' actions to Telegram.
   * Prevents the typing indicator from expiring during long searches, downloads, or inference.
   */
  async withTypingIndicator<T>(chatId: number | string, action: () => Promise<T>): Promise<T> {
    await this.sendAction(chatId, 'typing').catch(() => {});
    const interval = setInterval(() => {
      this.sendAction(chatId, 'typing').catch(() => {});
    }, 3500);
    interval.unref();

    try {
      return await action();
    } finally {
      clearInterval(interval);
    }
  }

  async apiCall<T>(method: string, body?: Record<string, unknown>, options: ApiCallOptions = {}): Promise<T> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? this.requestTimeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const res = await this.fetchImpl(`${this.baseUrl}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });

    let data: { ok: boolean; result: T; description?: string; error_code?: number; parameters?: { retry_after?: number } };
    try {
      data = (await res.json()) as typeof data;
    } catch {
      throw new TelegramApiError(method, `HTTP ${res.status} with an unreadable response`, res.status);
    }
    if (!data.ok) {
      throw new TelegramApiError(method, data.description ?? 'Unknown error', data.error_code ?? res.status, data.parameters?.retry_after);
    }
    return data.result;
  }

  splitMessage(text: string, maxLen = 4000): string[] {
    if (text.length <= maxLen) {
      return [text];
    }
    const chunks: string[] = [];
    let current = '';

    for (const line of text.split('\n')) {
      if (current && (current + '\n' + line).length > maxLen) {
        chunks.push(current);
        current = '';
      }
      if (line.length > maxLen) {
        const pieces = splitLongLine(line, maxLen);
        current = pieces.pop() ?? '';
        chunks.push(...pieces);
      } else {
        current = current ? current + '\n' + line : line;
      }
    }
    if (current) {
      chunks.push(current);
    }
    return chunks;
  }

  /** Plain text by default (no `parse_mode`); bot-authored messages opt in with `sendMarkdown`. */
  async sendMessage(chatId: number | string, text: string, options: SendMessageOptions = {}): Promise<TelegramMessage[]> {
    const chunks = this.splitMessage(text);
    const results: TelegramMessage[] = [];

    for (let i = 0; i < chunks.length; i++) {
      // Attach reply_markup only to the last chunk
      const markup = i === chunks.length - 1 ? options.reply_markup : undefined;
      const msg = await this.callWithPlainTextFallback<TelegramMessage>('sendMessage', {
        chat_id: chatId,
        text: chunks[i],
        parse_mode: options.parse_mode,
        reply_markup: markup,
      });
      results.push(msg);
    }

    return results;
  }

  /** A bot-authored message: legacy Markdown, so every dynamic value in `markdown` must be escaped (`esc` / `code`). */
  sendMarkdown(chatId: number | string, markdown: string, options: Omit<SendMessageOptions, 'parse_mode'> = {}): Promise<TelegramMessage[]> {
    return this.sendMessage(chatId, markdown, { ...options, parse_mode: 'Markdown' });
  }

  sendPlain(chatId: number | string, text: string, options: Omit<SendMessageOptions, 'parse_mode'> = {}): Promise<TelegramMessage[]> {
    return this.sendMessage(chatId, text, options);
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
   * Telegram rejects the whole message with a 400 "can't parse entities" when Markdown is unbalanced. A
   * Markdown message is resent once as plain text (with the escapes removed) instead of being dropped; a 429
   * is retried once after the wait Telegram asks for; any other error propagates.
   */
  private async callWithPlainTextFallback<T>(method: string, body: Record<string, unknown>): Promise<T> {
    try {
      return await this.callWithRateLimitRetry<T>(method, body);
    } catch (err: unknown) {
      const message = errorMessage(err);
      if (!body.parse_mode || !/can't parse entities/i.test(message)) {
        throw err;
      }
      logger.warn(`[TelegramBot] ${method} rejected with parse_mode=${String(body.parse_mode)} (${message}); resending as plain text.`);
      const { parse_mode: _rejectedParseMode, ...plainBody } = body;
      const text = typeof plainBody.text === 'string' ? { text: unescapeMarkdown(plainBody.text) } : {};
      return this.callWithRateLimitRetry<T>(method, { ...plainBody, ...text });
    }
  }

  private async callWithRateLimitRetry<T>(method: string, body: Record<string, unknown>): Promise<T> {
    try {
      return await this.apiCall<T>(method, body);
    } catch (err: unknown) {
      if (err instanceof TelegramApiError && err.errorCode === 429 && err.retryAfterSec !== undefined && err.retryAfterSec <= MAX_RETRY_AFTER_SEC) {
        logger.warn(`[TelegramBot] ${method} rate limited; retrying in ${err.retryAfterSec}s.`);
        await sleep(err.retryAfterSec * 1000);
        return this.apiCall<T>(method, body);
      }
      throw err;
    }
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string, showAlert = false): Promise<boolean> {
    return this.apiCall<boolean>('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text,
      show_alert: showAlert || undefined,
    });
  }

  async sendAction(chatId: number | string, action = 'typing'): Promise<boolean> {
    return this.apiCall<boolean>('sendChatAction', {
      chat_id: chatId,
      action,
    });
  }

  async getUpdates(offset?: number, timeout = this.pollTimeoutSec, signal?: AbortSignal): Promise<TelegramUpdate[]> {
    return this.apiCall<TelegramUpdate[]>(
      'getUpdates',
      { offset: offset ?? this.pollingOffset, timeout, allowed_updates: ['message', 'callback_query'] },
      // The HTTP timeout must outlive the long poll, or every quiet poll would be reported as a failure.
      { signal, timeoutMs: (timeout + 10) * 1000 }
    );
  }

  /** Downloads a Bot API file, refusing anything over `maxBytes` before it is fully read. */
  async downloadFile(filePath: string, maxBytes: number): Promise<Buffer> {
    if (!/^[\w\-./]+$/.test(filePath) || filePath.includes('..')) {
      throw new Error('Telegram returned an unexpected file path.');
    }
    const res = await this.fetchImpl(`${this.fileBaseUrl}/${filePath}`, { signal: AbortSignal.timeout(FILE_DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok) {
      throw new Error(`Telegram file download failed: HTTP ${res.status}`);
    }
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new Error(`The file is ${declared} bytes, over the ${maxBytes}-byte limit.`);
    }
    if (!res.body) {
      const whole = Buffer.from(await res.arrayBuffer());
      if (whole.byteLength > maxBytes) throw new Error(`The file is over the ${maxBytes}-byte limit.`);
      return whole;
    }
    const parts: Buffer[] = [];
    let total = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`The file is over the ${maxBytes}-byte limit.`);
      }
      parts.push(Buffer.from(value));
    }
    return Buffer.concat(parts);
  }

  // --- Authorization ---

  private isAuthorized(userId?: number): boolean {
    if (userId === undefined || userId === null) {
      return false;
    }
    if (this.ownerId !== '') {
      return userId.toString() === this.ownerId;
    }
    return this.openDev;
  }

  private async auditAuthFailure(senderId: number | undefined, details: Record<string, unknown>): Promise<void> {
    try {
      await this.rt.killSwitch.logAudit({ eventType: 'AUTH_FAILURE', actor: `telegram:${senderId ?? 'unknown'}`, details });
    } catch (err: unknown) {
      logger.warn(`[TelegramBot] Could not write the auth-failure audit entry: ${errorMessage(err)}`);
    }
  }

  private async refuseStranger(msg: TelegramMessage): Promise<void> {
    const senderId = msg.from?.id;
    await this.auditAuthFailure(senderId, { action: 'unauthorized_message', configured: this.ownerId !== '', length: (msg.text ?? msg.caption ?? '').length });
    const key = String(senderId ?? msg.chat.id);
    const last = this.strangerReplies.get(key) ?? 0;
    if (Date.now() - last < STRANGER_REPLY_INTERVAL_MS) return;
    this.strangerReplies.set(key, Date.now());
    const text =
      this.ownerId === ''
        ? 'Jarvis has no owner configured, so it is not serving anyone. Send /id to see your Telegram user ID, set TELEGRAM_OWNER_ID to it, and restart Jarvis.'
        : 'Access Denied: This Jarvis instance is configured for exclusive private use by its owner.';
    await this.sendPlain(msg.chat.id, text);
  }

  // --- Update dispatch ---

  /**
   * Handles one update and resolves when it is fully handled. Never rejects: a failure is logged and the
   * owner is told. Control commands and approval callbacks run at once; everything else is serialised per chat,
   * so one slow turn cannot delay `/kill`, `/resume`, `/status` or a tap on an approval button.
   */
  async handleUpdate(update: TelegramUpdate): Promise<void> {
    const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
    try {
      if (update.callback_query) {
        await this.handleCallbackQuery(update.callback_query);
        return;
      }
      const msg = update.message;
      if (!msg) return;

      const { command, addressedElsewhere } = this.commandOf(msg);
      if (addressedElsewhere) return;
      const spec = command ? findCommand(command.name) : undefined;

      // /id is the one thing a stranger may use: it is how the owner learns the id to configure.
      const isIdCommand = spec?.name === 'id';
      if (!isIdCommand && !this.isAuthorized(msg.from?.id)) {
        await this.refuseStranger(msg);
        return;
      }
      if (this.ownerId === '' && this.openDev) {
        logger.warn(`[TelegramBot] Open dev mode: message from user ID ${msg.from?.id} (@${msg.from?.username ?? 'anonymous'}). Set TELEGRAM_OWNER_ID=${msg.from?.id} to lock access.`);
      }
      this.lastChatId = msg.chat.id;

      if (spec?.immediate) {
        await this.processMessage(msg);
        return;
      }
      const key = String(msg.chat.id);
      if (this.chatQueues.has(key)) {
        await this.sendPlain(msg.chat.id, 'Queued: I am still working on your previous request and will get to this next. /kill stops everything.').catch(() => undefined);
      }
      await this.enqueue(key, () => this.processMessage(msg).catch((err: unknown) => this.reportFailure(msg.chat.id, err)));
    } catch (err: unknown) {
      await this.reportFailure(chatId, err);
    }
  }

  /**
   * The command a message carries, or null. A forwarded message or one sent through an inline bot is content
   * from someone else even though `from` is the owner, so its text is never a command. A command with an
   * `@suffix` naming another bot is not ours either (in a group the owner meant the other bot); when our own
   * username is not known yet the suffix cannot be verified, so it is treated as not ours.
   */
  private commandOf(msg: TelegramMessage): { command: ParsedCommand | null; addressedElsewhere: boolean } {
    const text = msg.text?.trim() ?? '';
    const forwarded = Boolean(msg.forward_origin ?? msg.forward_date ?? msg.forward_from ?? msg.forward_from_chat ?? msg.forward_sender_name ?? msg.via_bot);
    const command = text && !forwarded ? parseCommand(text) : null;
    if (command?.target && command.target.toLowerCase() !== this.botUsername?.toLowerCase()) {
      return { command: null, addressedElsewhere: true };
    }
    return { command, addressedElsewhere: false };
  }

  private enqueue(key: string, job: () => Promise<void>): Promise<void> {
    const previous = this.chatQueues.get(key) ?? Promise.resolve();
    const next = previous.then(job, job);
    this.chatQueues.set(key, next);
    const cleanup = (): void => {
      if (this.chatQueues.get(key) === next) this.chatQueues.delete(key);
    };
    next.then(cleanup, cleanup);
    return next;
  }

  private async reportFailure(chatId: number | string | undefined, err: unknown): Promise<void> {
    logger.error(`[TelegramBot] Update handling failed: ${errorMessage(err)}`);
    if (chatId === undefined) return;
    try {
      await this.sendPlain(chatId, `Something went wrong while handling that: ${oneLine(redactSensitive(errorMessage(err)), 300)}\nNothing was made up to fill the gap; you can try again.`);
    } catch (sendErr: unknown) {
      logger.error(`[TelegramBot] Could not tell the owner about the failure either: ${errorMessage(sendErr)}`);
    }
  }

  private async processMessage(msg: TelegramMessage): Promise<void> {
    const chatId = msg.chat.id;
    const senderId = String(msg.from?.id ?? '');
    const text = (msg.text ?? '').trim();
    const { command } = this.commandOf(msg);
    const spec = command ? findCommand(command.name) : undefined;

    if (this.rt.killSwitch.isKilled() && !(spec?.allowedWhenKilled ?? false)) {
      await this.sendPlain(chatId, `System halted: the kill switch is engaged (${this.rt.killSwitch.getKillReason() || 'no reason recorded'}). Send /resume to re-arm Jarvis.`);
      return;
    }

    if (command) {
      if (!spec) {
        await this.sendPlain(chatId, `Unknown command: /${command.name}. Use /help for the commands that exist.`);
        return;
      }
      await this.runCommand(spec, msg, senderId, command.args, command.rawArgs);
      return;
    }
    if (msg.photo?.length || msg.document) {
      await this.handleMedia(msg, senderId);
      return;
    }
    if (text) {
      await this.runTurn(chatId, senderId, text);
      return;
    }
    await this.sendPlain(chatId, 'I can read text messages and photos. This kind of message is not supported.');
  }

  private async runCommand(spec: CommandSpec, msg: TelegramMessage, senderId: string, args: string[], rawArgs: string): Promise<void> {
    const chatId = msg.chat.id;
    const ctx = this.buildContext(chatId, senderId, args, rawArgs);
    try {
      await spec.run(ctx);
    } catch (err: unknown) {
      logger.error(`[TelegramBot] /${spec.name} failed: ${errorMessage(err)}`);
      await this.sendPlain(chatId, `/${spec.name} failed: ${oneLine(redactSensitive(errorMessage(err)), 300)}`);
    }
  }

  private buildContext(chatId: number | string, senderId: string, args: string[], rawArgs: string): CommandContext {
    return {
      rt: this.rt,
      chatId,
      senderId,
      storeUserId: this.rt.ownerUserId,
      args,
      rawArgs,
      state: this.getUserState(senderId),
      updateState: (patch) => this.updateUserState(senderId, patch),
      reply: async (markdown) => {
        await this.sendMarkdown(chatId, markdown);
      },
      replyPlain: async (text) => {
        await this.sendPlain(chatId, text);
      },
      withTyping: (action) => this.withTypingIndicator(chatId, action),
      beginWork: () => this.beginWork(),
      runChatTurn: (prompt, options) => this.runTurn(chatId, senderId, prompt, options),
      runEnsemble: (query) => this.runEnsembleTurn(chatId, query),
      getShownSessionIds: () => {
        const shown = this.shownSessions.get(String(chatId));
        return shown && Date.now() - shown.at <= SHOWN_SESSIONS_TTL_MS ? shown.ids : undefined;
      },
      setShownSessionIds: (ids) => {
        this.shownSessions.set(String(chatId), { ids, at: Date.now() });
      },
    };
  }

  /** Registers an abort controller with the runtime, so `/kill` halts the work. */
  private beginWork(): WorkHandle {
    const controller = new AbortController();
    this.rt.registerAbort(controller);
    return { signal: controller.signal, done: () => this.rt.unregisterAbort(controller) };
  }

  // --- Per-user settings ---

  private getUserState(userKey: string): UserState {
    const cached = this.userStates.get(userKey);
    if (cached) return cached;
    let state: UserState = { ensemble: false };
    try {
      const stored = this.rt.store.getCollection<UserStateDoc>(USER_STATE_COLLECTION).findOne({ id: userKey });
      if (stored) state = { ensemble: stored.ensemble === true, explicitModel: stored.explicitModel || undefined };
    } catch (err: unknown) {
      logger.warn(`[TelegramBot] Could not load saved settings: ${errorMessage(err)}`);
    }
    this.userStates.set(userKey, state);
    return state;
  }

  private async updateUserState(userKey: string, patch: Partial<UserState>): Promise<void> {
    // The same object is mutated so a command context built earlier sees the change.
    const state = this.getUserState(userKey);
    if ('explicitModel' in patch) {
      if (patch.explicitModel) state.explicitModel = patch.explicitModel;
      else delete state.explicitModel;
    }
    if (patch.ensemble !== undefined) state.ensemble = patch.ensemble;
    try {
      this.rt.store.getCollection<UserStateDoc>(USER_STATE_COLLECTION).insertOne({
        id: userKey,
        ensemble: state.ensemble,
        ...(state.explicitModel ? { explicitModel: state.explicitModel } : {}),
      });
    } catch (err: unknown) {
      logger.warn(`[TelegramBot] Could not save settings (they apply until restart): ${errorMessage(err)}`);
    }
  }

  // --- Chat turns ---

  private async runTurn(
    chatId: number | string,
    senderId: string,
    prompt: string,
    options: { useResearch?: boolean; attachments?: Array<{ kind: 'image'; description?: string }> } = {}
  ): Promise<void> {
    const state = this.getUserState(senderId);
    // Ensemble answers from the models' memory with no sources, so it must never stand in for forced research.
    if (state.ensemble && !options.attachments && !options.useResearch) {
      await this.runEnsembleTurn(chatId, prompt);
      return;
    }

    const rt = this.rt;
    const userId = rt.ownerUserId;
    const { session } = await rt.sessions.getOrCreateActiveSession(userId, TELEGRAM_CHANNEL, 'Telegram');
    const task = await rt.sessions.createTask({
      userId,
      sessionId: session.id,
      title: redactSensitive(oneLine(prompt, 60)),
      priority: 10, // interactive priority
    });
    const tag = rt.sessions.formatTaskTag(task);

    const progress: TurnProgress = { statusSent: 0, toolSent: 0, lastStatus: '', model: null };
    let result: TurnResult | null = null;
    const onEvent = async (event: TurnEvent): Promise<void> => {
      try {
        await this.showProgress(chatId, event, progress);
      } catch (err: unknown) {
        logger.warn(`[TelegramBot] Could not send a progress message: ${errorMessage(err)}`);
      }
    };

    const outcome = await this.withTypingIndicator(chatId, () =>
      rt.sessions.runTask(task.id, async (signal) => {
        const turn = await runChatTurn(
          rt,
          {
            surface: 'telegram',
            userId,
            sessionId: session.id,
            prompt,
            explicitModel: state.explicitModel,
            useResearch: options.useResearch,
            attachments: options.attachments,
            signal,
            taskId: task.id,
          },
          onEvent
        );
        result = turn;
        // A failed turn must end the task as failed, not done.
        if (!turn.ok && !(turn.partial && signal.aborted)) {
          throw new Error(turn.error?.message ?? 'The turn did not complete.');
        }
        return `answered with ${turn.model ?? 'no model'} (${turn.text.length} characters)`;
      })
    );

    const finished = result as TurnResult | null;
    switch (outcome.status) {
      case 'done':
      case 'failed':
        await this.sendPlain(chatId, this.formatTurnReply(tag, finished, outcome.status === 'failed' ? outcome.error : undefined));
        return;
      case 'cancelled':
        await this.sendPlain(chatId, this.formatTurnReply(tag, finished, undefined, `Cancelled: ${outcome.reason}`));
        return;
      case 'skipped':
        await this.sendPlain(chatId, `${tag}\n\nThis request did not run: ${outcome.reason}`);
        return;
    }
  }

  private async showProgress(chatId: number | string, event: TurnEvent, progress: TurnProgress): Promise<void> {
    switch (event.type) {
      case 'status':
        if (progress.statusSent < MAX_STATUS_MESSAGES_PER_TURN && event.text && event.text !== progress.lastStatus) {
          progress.statusSent += 1;
          progress.lastStatus = event.text;
          await this.sendPlain(chatId, oneLine(event.text, 300));
        }
        return;
      case 'model':
        progress.model = event.model;
        return;
      case 'tool':
        if (progress.toolSent >= MAX_PROGRESS_TOOL_MESSAGES_PER_TURN) return;
        if (event.state === 'requested') {
          progress.toolSent += 1;
          await this.sendPlain(chatId, event.tier >= 2 ? `Tool ${event.name} (Tier ${event.tier}) needs your approval; check the approval message.` : `Using tool ${event.name}...`);
        } else if (event.state === 'denied' || event.state === 'error') {
          progress.toolSent += 1;
          await this.sendPlain(chatId, `Tool ${event.name} ${event.state === 'denied' ? 'was denied' : 'failed'}${event.detail ? `: ${oneLine(event.detail, 200)}` : ''}`);
        }
        return;
      default:
        return;
    }
  }

  /** One reply per turn: the model's text as plain text, then sources, the model used and the tools that ran. */
  private formatTurnReply(tag: string, result: TurnResult | null, failure?: string, note?: string): string {
    const parts: string[] = [tag, ''];
    const body = result?.text.trim() ?? '';
    const errorText = result?.error?.message ?? failure;
    const errorCode = result?.error?.code ? ` [${result.error.code}]` : '';
    if (body) parts.push(body, '');
    if (result?.truncated && body) {
      parts.push('(Reply cut off at the output limit; it is incomplete.)');
    } else if (errorText) {
      parts.push(body ? `(Incomplete: ${errorText}${errorCode})` : `I could not answer: ${errorText}${errorCode}`);
    } else if (!body && !note) {
      parts.push('(The model returned no text.)');
    } else if (result?.partial) {
      parts.push('(Stopped early; the reply above is incomplete.)');
    }
    if (note) parts.push('', note);

    if (result && result.sources.length > 0) {
      parts.push('', 'Sources:', ...result.sources.map((url) => `- ${url}`));
    }
    const footer: string[] = [];
    if (result?.model) footer.push(`model: ${result.model}`);
    if (result && result.toolCalls.length > 0) {
      footer.push(`tools: ${result.toolCalls.map((call) => `${call.name}${call.ok ? '' : ` (failed${call.error ? `: ${oneLine(call.error, 60)}` : ''})`}`).join(', ')}`);
    }
    if (footer.length > 0) parts.push('', footer.join(' | '));
    return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  // --- Ensemble (sequential multi-model answer) ---

  private pickEnsembleModels(installedNames: string[]): string[] {
    const known: Array<{ name: string; definition: ModelDefinition }> = [];
    for (const name of installedNames) {
      const definition = this.rt.registry.getModel(name);
      if (definition && ENSEMBLE_LANES.has(definition.lane)) known.push({ name, definition });
    }
    return known
      .sort((a, b) => a.definition.memoryRequirementBytes - b.definition.memoryRequirementBytes)
      .slice(0, MAX_ENSEMBLE_MODELS)
      .map((entry) => entry.name);
  }

  private formatEnsemble(result: EnsembleResult): string {
    const answered = result.candidates.filter((candidate) => candidate.status === 'fulfilled');
    const lines = [result.primaryAnswer.trim(), ''];
    lines.push(`Answered in turn by: ${answered.map((candidate) => `${candidate.model} (${(candidate.latencyMs / 1000).toFixed(1)}s)`).join(', ')}`);
    lines.push(result.corroborated ? `Answer agreement: ${Math.round(result.consensusScore * 100)}% (word overlap between the models, not a fact check)` : 'Not corroborated: only one model answered.');
    for (const skipped of result.skipped ?? []) lines.push(`Skipped ${skipped.model}: ${skipped.reason}`);
    if (result.aborted) lines.push('Stopped early: the remaining models did not run.');
    for (const candidate of result.candidates) {
      if (candidate.status === 'rejected') lines.push(`${candidate.model} failed: ${oneLine(candidate.error ?? 'unknown error', 120)}`);
    }
    return lines.join('\n');
  }

  private async runEnsembleTurn(chatId: number | string, query: string): Promise<void> {
    const rt = this.rt;
    if (rt.killSwitch.isKilled()) {
      await this.sendPlain(chatId, `System halted: the kill switch is engaged (${rt.killSwitch.getKillReason() || 'no reason recorded'}).`);
      return;
    }
    const inventory = await rt.refreshInventory();
    if (inventory.lastGoodAt === null) {
      await this.sendPlain(chatId, `Ensemble is unavailable: ${inventory.status}`);
      return;
    }
    const models = this.pickEnsembleModels(inventory.installed.map((model) => model.name));
    if (models.length < 2) {
      await this.sendPlain(chatId, `Ensemble needs at least two installed chat models that Jarvis knows how to budget; found ${models.length === 0 ? 'none' : models[0]}. Use /models to see what is installed.`);
      return;
    }

    const safeQuery = redactSensitive(query);
    const userId = rt.ownerUserId;
    const { session } = await rt.sessions.getOrCreateActiveSession(userId, TELEGRAM_CHANNEL, 'Telegram');
    const history: ConversationTurn[] = (await rt.sessions.getMessages(userId, session.id)).slice(-60).map((m) => ({ role: m.role, content: m.content }));
    await this.saveTurn(userId, session.id, 'user', safeQuery);

    await this.sendPlain(chatId, `Ensemble: asking ${models.join(', ')} one after another. This is slow, and each model may need to load first.`);
    const context = await buildConversationContext({
      memory: rt.memory,
      userId,
      sessionId: session.id,
      prompt: safeQuery,
      turns: history,
      maxTokens: contextBudgetFor([safeQuery]),
    });

    let asked = 0;
    const ensemble = new MultiModelEnsemble({
      registry: rt.registry,
      governor: rt.governor,
      getInstalled: async () => installedFromDiagnostics((await rt.refreshInventory()).installed),
      getVramFreeBytes: async () => rt.getStatus().vram.freeBytes,
      providerFactory: (tag) => {
        asked += 1;
        void this.sendPlain(chatId, `Ensemble: asking ${tag} (${asked}/${models.length})...`).catch(() => undefined);
        return rt.providerFor(tag);
      },
    });

    const work = this.beginWork();
    const aborted = new Promise<never>((_, reject) => {
      work.signal.addEventListener('abort', () => reject(new Error(String(work.signal.reason ?? 'Aborted'))), { once: true });
    });
    aborted.catch(() => undefined);
    try {
      const running = ensemble.generateSimultaneous(safeQuery, { models, taskType: 'chat', memoryContext: context.text, signal: work.signal });
      running.catch(() => undefined);
      const result = await this.withTypingIndicator(chatId, () => Promise.race([running, aborted]));
      const reply = this.formatEnsemble(result);
      await this.saveTurn(userId, session.id, 'assistant', result.primaryAnswer);
      await this.sendPlain(chatId, reply);
    } catch (err: unknown) {
      await this.sendPlain(chatId, `Ensemble failed: ${oneLine(redactSensitive(errorMessage(err)), 400)}`);
    } finally {
      work.done();
    }
  }

  /** A write that fails (for example the session was deleted from the web mid-turn) is logged, never thrown. */
  private async saveTurn(userId: string, sessionId: string, role: 'user' | 'assistant', content: string): Promise<void> {
    try {
      await this.rt.sessions.addMessage(userId, sessionId, { role, content });
    } catch (err: unknown) {
      logger.warn(`[TelegramBot] ${role} turn not saved: ${errorMessage(err)}`, { sessionId });
    }
  }

  // --- Photos and documents ---

  private async handleMedia(msg: TelegramMessage, senderId: string): Promise<void> {
    const chatId = msg.chat.id;
    const caption = msg.caption?.trim() ?? '';

    let fileId: string | null = null;
    if (msg.photo && msg.photo.length > 0) {
      // Sizes arrive smallest first; take the largest one that fits under the limit.
      const fitting = [...msg.photo].reverse().find((size) => size.file_size === undefined || size.file_size <= MAX_IMAGE_BYTES);
      if (!fitting) {
        await this.sendPlain(chatId, `That photo is over the ${MAX_IMAGE_BYTES / (1024 * 1024)} MB limit for image analysis, so I did not download it.`);
        return;
      }
      fileId = fitting.file_id;
    } else if (msg.document) {
      if (!msg.document.mime_type?.startsWith('image/')) {
        await this.sendPlain(chatId, `I can only look at images; ${msg.document.mime_type ?? 'this document type'} is not supported.`);
        return;
      }
      if (msg.document.file_size !== undefined && msg.document.file_size > MAX_IMAGE_BYTES) {
        await this.sendPlain(chatId, `That image is ${msg.document.file_size} bytes, over the ${MAX_IMAGE_BYTES}-byte limit, so I did not download it.`);
        return;
      }
      fileId = msg.document.file_id;
    }
    if (!fileId) return;

    await this.sendAction(chatId, 'typing').catch(() => undefined);
    let bytes: Buffer;
    try {
      const file = await this.apiCall<TelegramFile>('getFile', { file_id: fileId });
      if (file.file_size !== undefined && file.file_size > MAX_IMAGE_BYTES) {
        await this.sendPlain(chatId, `That image is ${file.file_size} bytes, over the ${MAX_IMAGE_BYTES}-byte limit, so I did not download it.`);
        return;
      }
      if (!file.file_path) {
        await this.sendPlain(chatId, 'Telegram did not provide a download path for that file, so I could not read it.');
        return;
      }
      bytes = await this.downloadFile(file.file_path, MAX_IMAGE_BYTES);
    } catch (err: unknown) {
      await this.sendPlain(chatId, `I could not download that image: ${oneLine(redactSensitive(errorMessage(err)), 300)}`);
      return;
    }

    const work = this.beginWork();
    let description: Awaited<ReturnType<JarvisRuntime['media']['describeImage']>>;
    try {
      description = await this.withTypingIndicator(chatId, () => this.rt.media.describeImage(bytes, undefined, { signal: work.signal }));
    } finally {
      work.done();
    }
    if (work.signal.aborted) {
      await this.sendPlain(chatId, `Stopped: ${String(work.signal.reason ?? 'kill switch engaged')}`);
      return;
    }
    if (!description.available) {
      await this.sendPlain(chatId, `I could not look at the image: ${description.reason}`);
      if (!caption) return;
    }

    const prompt = caption || 'The owner sent an image without a caption. Say what it shows.';
    await this.runTurn(chatId, senderId, prompt, {
      attachments: [{ kind: 'image', description: description.available ? description.text : undefined }],
    });
  }

  // --- Approvals (Tier 2) ---

  private ownerChatId(): number | string {
    // In a private chat the chat id equals the user id, so the owner's id is where requests are sent.
    const id = Number(this.ownerId);
    if (Number.isSafeInteger(id) && id > 0) return id;
    throw new Error('TELEGRAM_OWNER_ID is not a numeric Telegram user id.');
  }

  /** The broker's notifier: asks the owner with Approve and Deny buttons. Throwing makes the broker deny the request. */
  private async notifyApproval(request: ApprovalRequest): Promise<void> {
    if (this.ownerId === '') {
      throw new Error('Approvals need TELEGRAM_OWNER_ID: with no owner configured nobody can be asked.');
    }
    const approveData = `${APPROVE_PREFIX}${request.id}`;
    const denyData = `${DENY_PREFIX}${request.id}`;
    if (Buffer.byteLength(approveData) > MAX_CALLBACK_DATA_BYTES) {
      throw new Error('The approval request id is too long for a Telegram button.');
    }
    const keyboard: InlineKeyboardMarkup = {
      inline_keyboard: [[{ text: 'Approve', callback_data: approveData }, { text: 'Deny', callback_data: denyData }]],
    };
    const summary = `${request.actionType} (Tier ${request.tier})`;
    const args = structuredApprovalArgs(request.metadata);
    // A security-relevant value that is cut off means the owner would approve something they cannot read.
    const hiddenSecurity = args.find((arg) => arg.securityRelevant && arg.omittedChars > 0);
    if (hiddenSecurity) {
      throw new Error(`The approval prompt cannot show '${hiddenSecurity.name}' in full (${hiddenSecurity.omittedChars} characters hidden), so the action was refused without asking.`);
    }
    const notShown = args.filter((arg) => arg.omittedChars > 0).map((arg) => `${arg.name} (+${arg.omittedChars} characters)`);
    // Each line is one argument; redacting line by line keeps a `password:` label in one value from hiding the next.
    const description = cleanMultiline(request.description.split('\n').map((line) => redactSensitive(line)).join('\n'));
    // Metadata the description already shows (the executor puts the arguments in both) is not repeated.
    const extra = Object.fromEntries(
      Object.entries(request.metadata ?? {}).filter(
        ([key, value]) => !(key === 'args' && args.length > 0) && !(typeof value === 'string' && value !== '' && request.description.includes(value))
      )
    );
    const details = Object.keys(extra).length > 0 ? cleanMultiline(Object.entries(extra).map(([key, value]) => redactSensitive(`${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)).join('\n')) : '';
    // Plain text, not Markdown: the description is untrusted, and the full text may be split across messages,
    // which could cut an escape sequence in half. The keyboard goes on the last part (see `sendMessage`).
    const text = [
      'Approval required',
      '',
      `Action: ${request.actionType} (Tier ${request.tier})`,
      `Requested by: ${oneLine(request.requestedBy, 120)}`,
      '',
      'What:',
      description,
      ...(notShown.length > 0 ? ['', `Not shown in full: ${notShown.join(', ')}.`] : []),
      ...(details ? ['', 'Details:', details] : []),
      '',
      'Nothing runs unless you tap Approve. It expires on its own if you do not answer.',
    ].join('\n');
    const sent = await this.sendPlain(this.ownerChatId(), text, { reply_markup: keyboard });
    const last = sent.at(-1);
    if (last) {
      this.approvalMessages.set(request.id, { chatId: last.chat.id, messageId: last.message_id, summary });
    }
  }

  /** A failed answer (the query is too old, or Telegram is down) must not undo or hide a decision already applied. */
  private async tryAnswerCallback(callbackQueryId: string, text?: string, showAlert = false): Promise<void> {
    try {
      await this.answerCallbackQuery(callbackQueryId, text, showAlert);
    } catch (err: unknown) {
      logger.warn(`[TelegramBot] Could not answer the callback query: ${errorMessage(err)}`);
    }
  }

  private async handleCallbackQuery(cb: TelegramCallbackQuery): Promise<void> {
    const senderId = cb.from?.id;
    const data = cb.data ?? '';
    if (!this.isAuthorized(senderId) || this.ownerId === '') {
      await this.auditAuthFailure(senderId, { action: 'unauthorized_callback', data: oneLine(data, 80) });
      await this.tryAnswerCallback(
        cb.id,
        this.ownerId === '' ? 'Approvals need TELEGRAM_OWNER_ID to be configured.' : 'Unauthorized: access restricted to the Jarvis owner.',
        true
      );
      return;
    }

    const approved = data.startsWith(APPROVE_PREFIX);
    if (!approved && !data.startsWith(DENY_PREFIX)) {
      await this.tryAnswerCallback(cb.id, 'Unknown action.');
      return;
    }
    const requestId = data.slice(approved ? APPROVE_PREFIX.length : DENY_PREFIX.length);
    const known = this.approvalMessages.get(requestId);
    const resolved = this.rt.approvals.resolve(requestId, approved, `telegram:${senderId}`);
    this.approvalMessages.delete(requestId);

    const chatId = known?.chatId ?? cb.message?.chat.id;
    const messageId = known?.messageId ?? cb.message?.message_id;
    const summary = known?.summary ?? 'the action';
    const outcomeText = resolved
      ? approved
        ? `APPROVED by you: ${summary}. It may now run.`
        : `DENIED by you: ${summary}. It will not run.`
      : `No longer pending: ${summary}. It already expired, was resolved, or was denied by the kill switch. Nothing ran because of this tap.`;
    await this.tryAnswerCallback(cb.id, resolved ? (approved ? 'Approved.' : 'Denied.') : 'Expired or already resolved.');
    if (chatId !== undefined && messageId !== undefined) {
      await this.editMessageText(chatId, messageId, outcomeText, { reply_markup: { inline_keyboard: [] } }).catch((err: unknown) =>
        logger.warn(`[TelegramBot] Could not update the approval message: ${errorMessage(err)}`)
      );
    }
  }

  // --- Long polling ---

  private track(promise: Promise<void>): void {
    this.inflight.add(promise);
    const forget = (): void => {
      this.inflight.delete(promise);
    };
    promise.then(forget, forget);
  }

  /** Resolves once every update handed out so far has been handled. */
  async idle(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.allSettled([...this.inflight]);
    }
  }

  private loadPollOffset(): void {
    try {
      const saved = this.rt.store.getCollection<PollStateDoc>(POLL_STATE_COLLECTION).findOne({ id: POLL_STATE_ID });
      // `update_id`s are per bot: another bot's offset can sit above this bot's ids and silence it. A document
      // saved before the bot id was recorded cannot be told apart, so it is still honoured.
      const sameBot = saved?.botId === undefined || saved.botId === this.botId;
      if (saved && sameBot && Number.isSafeInteger(saved.offset) && saved.offset > this.pollingOffset) this.pollingOffset = saved.offset;
      else if (saved && !sameBot) logger.warn(`[TelegramBot] Ignoring the saved poll offset: it belongs to bot ${saved.botId}, this is bot ${this.botId ?? 'unknown'}.`);
    } catch (err: unknown) {
      logger.warn(`[TelegramBot] Could not load the saved poll offset: ${errorMessage(err)}`);
    }
  }

  private savePollOffset(): void {
    try {
      this.rt.store.getCollection<PollStateDoc>(POLL_STATE_COLLECTION).insertOne({ id: POLL_STATE_ID, offset: this.pollingOffset, ...(this.botId ? { botId: this.botId } : {}) });
    } catch (err: unknown) {
      logger.warn(`[TelegramBot] Could not save the poll offset: ${errorMessage(err)}`);
    }
  }

  /**
   * Long-polls until `stopPolling`. The offset moves past an update before it is handled and is saved, so an
   * update is never handled twice (not even after a restart) and one that always fails cannot spin the loop.
   * Updates are handled concurrently, never awaited here, so a slow turn cannot stall polling or `/kill`.
   */
  async startPolling(pollIntervalMs = 250): Promise<void> {
    if (this.isPolling) return;
    this.isPolling = true;
    const abort = new AbortController();
    this.pollAbort = abort;
    let failures = 0;

    // `getMe` first: it proves the token, and gives the bot's id (keys the saved offset) and username (decides
    // which `/cmd@name` commands are ours). Only a verified bot with an owner becomes the approval channel.
    while (this.isPolling && !this.identityVerified) {
      try {
        const me = await this.apiCall<{ id?: number; username?: string }>('getMe', undefined, { signal: abort.signal });
        if (typeof me?.id === 'number') this.botId = String(me.id);
        this.botUsername = me?.username ?? null;
        this.identityVerified = true;
      } catch (err: unknown) {
        if (!this.isPolling) break;
        if (err instanceof TelegramApiError && (err.errorCode === 401 || err.errorCode === 404)) {
          logger.error(`[TelegramBot] Telegram rejected the bot token (${err.message}); not polling.`);
          this.isPolling = false;
          break;
        }
        failures += 1;
        const delay = Math.min(30_000, 1000 * 2 ** Math.min(failures, 5));
        logger.warn(`[TelegramBot] getMe failed (${failures} in a row): ${errorMessage(err)}; retrying in ${delay / 1000}s.`);
        await sleep(delay, abort.signal);
      }
    }
    if (this.isPolling) {
      this.loadPollOffset();
      this.registerApprovalNotifier();
    }
    failures = 0;

    while (this.isPolling) {
      const startedAt = Date.now();
      try {
        const updates = await this.getUpdates(this.pollingOffset, this.pollTimeoutSec, abort.signal);
        failures = 0;
        for (const update of updates) {
          if (update.update_id < this.pollingOffset) continue;
          this.pollingOffset = update.update_id + 1;
          this.savePollOffset();
          this.track(this.handleUpdate(update));
        }
        if (updates.length === 0 && Date.now() - startedAt < 1000) {
          await sleep(pollIntervalMs, abort.signal);
        }
      } catch (err: unknown) {
        if (!this.isPolling) break;
        failures += 1;
        const delay = Math.min(30_000, 1000 * 2 ** Math.min(failures, 5));
        logger.warn(`[TelegramBot] Polling failed (${failures} in a row): ${errorMessage(err)}; retrying in ${delay / 1000}s.`);
        await sleep(delay, abort.signal);
      }
    }
    if (this.pollAbort === abort) this.pollAbort = null;
  }

  /** Stops the loop and aborts a poll that is waiting on Telegram. */
  stopPolling(): void {
    this.isPolling = false;
    this.pollAbort?.abort();
    this.unregisterApprovalNotifier();
  }

  /** Stops polling and waits briefly for updates that are already being handled. */
  async stop(graceMs = 5000): Promise<void> {
    this.stopPolling();
    await Promise.race([this.idle(), sleep(graceMs)]);
  }
}
