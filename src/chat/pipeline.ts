/**
 * Jarvis Local AI Agent: Shared Chat Pipeline
 * Authority: FEAT-004, Section 8 (memory tiers), Section 5.3 (tool calling), CODING_RULES.md section 5
 *
 * `runChatTurn` is the only place chat logic lives; the web server and the Telegram bot both call it with the
 * same `JarvisRuntime`, so they cannot drift apart. It never throws: every failure becomes an `error` event
 * plus a `TurnResult`. Every turn ends with exactly one `done` event; an `error` event may precede it.
 *
 * Honesty rules enforced here: a provider failure with no output saves nothing as the assistant's reply and
 * invents no text; an unavailable search engine or model is reported to the owner with its typed reason;
 * secrets are routed to the vault and never persisted in the transcript; web text, tool output and image
 * descriptions only ever reach the model fenced as data.
 */

import type { JarvisRuntime } from '../runtime/runtime.js';
import type { GenerateStreamOptions, GenerationUsage } from '../services/provider.js';
import { CognitionEngine, type ReflexHint, type ToolResultSummary, type ToolSchemaSummary } from '../agents/cognition.js';
import {
  PROMPT_TOKEN_CAP,
  SYSTEM_PROMPT_RESERVE_TOKENS,
  assertPromptWithinCap,
  buildConversationContext,
  clampText,
  estimateTokens,
  fitContextToBudget,
  parseRememberCommand,
  pickSmallestModel,
  recordTaskEpisode,
  shouldSummarize,
  summarizeAndStoreSession,
  type ConversationTurn,
} from '../memory/context-builder.js';
import { detectSensitive, redactSensitive } from '../memory/sensitive.js';
import { fenceToolResult } from '../tools/executor.js';
import type { ToolCall, ToolDefinition, ToolResult } from '../tools/types.js';
import type { ProvisionDecision } from '../orchestration/provisioner.js';
import { isHeavyModel } from '../orchestration/governor.js';
import type { ApprovalRequest } from '../security/approvals.js';
import { ReflexCompiler, type ReflexMacro } from '../skills/reflex.js';
import { fenceUntrusted } from '../bridge/untrusted.js';
import { SessionNotFoundError } from '../sessions/manager.js';
import { logger } from '../utils/logger.js';
import { gatherResearch, shouldResearchPrompt } from './research.js';
import { ThinkStreamFilter, stripThinking } from './thinking.js';
import { resolveThink } from '../services/thinking-control.js';

export { shouldResearchPrompt } from './research.js';

const MIN_CONTEXT_WINDOW_TOKENS = 4096;
const CONTEXT_MARGIN_TOKENS = 256;
const MAX_TOOL_ROUNDS = 3;
const MAX_TOOL_CALLS_PER_TURN = 6;
const TOOL_RESULT_CHARS = 4_000;
const TOOL_BUDGET_TOKENS = 5_000;
const MIN_CONTEXT_BUDGET_TOKENS = 1_000;
const MAX_TOOLS_OFFERED = 10;
/** Tools whose arguments leave the machine; the owner sees them in full (up to this many characters) in the tool event. */
const OUTBOUND_TOOLS = new Set(['web_search', 'browse_page']);
const OUTBOUND_PREVIEW_CHARS = 500;
/** The post-turn summary is background work: it waits this long for a model and for the lease, then is skipped. */
const SUMMARY_TIMEOUT_MS = 2 * 60 * 1000;
const SUMMARY_LEASE_WAIT_MS = 60 * 1000;

export type TurnEvent =
  | { type: 'status'; text: string }
  | { type: 'sources'; urls: string[] }
  | { type: 'model'; model: string; lane: string; rationale: string }
  | { type: 'chunk'; text: string }
  | { type: 'tool'; name: string; tier: 1 | 2 | 3; state: 'requested' | 'approved' | 'denied' | 'done' | 'error'; detail?: string }
  | { type: 'error'; message: string; code?: string }
  | { type: 'done'; partial: boolean; /** The reply stopped at the output limit, not because the model finished. */ truncated?: boolean };

export interface TurnInput {
  surface: 'web' | 'telegram';
  userId: string;
  sessionId: string;
  prompt: string;
  /** The owner's UI or Telegram model choice; honoured by the provisioner. */
  explicitModel?: string;
  /** True or false is the owner's choice; undefined lets a conservative word-boundary heuristic decide. */
  useResearch?: boolean;
  signal?: AbortSignal;
  /** Ledger rows for this turn carry it. */
  taskId?: string;
  /** Images the surface already described through `MediaService` (the description is untrusted vision-model text). */
  attachments?: Array<{ kind: 'image'; description?: string }>;
}

export interface ToolCallRecord {
  name: string;
  tier: 1 | 2 | 3;
  ok: boolean;
  error?: string;
  argsPreview: string;
}

export interface TurnResult {
  /** True only when a complete answer was generated and nothing went wrong. */
  ok: boolean;
  /** The reply text (possibly partial); empty when nothing was generated. */
  text: string;
  sources: string[];
  /** The Ollama tag that served the turn; null when no model was chosen. */
  model: string | null;
  /** The reply is incomplete (stream broke, aborted, killed after some output, or cut off at the output limit). */
  partial: boolean;
  /** Ollama stopped at the output limit (`done_reason: 'length'`): the text ends mid-thought. Implies `partial` and `ok: false`. */
  truncated: boolean;
  /** Real backend counts summed over the turn's generation calls; zero when the backend reported none. */
  usage: { promptTokens: number; completionTokens: number; calls: number };
  toolCalls: ToolCallRecord[];
  error?: { message: string; code?: string };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function previewArgs(args: unknown, maxChars = 200): string {
  try {
    return clampText(redactSensitive((JSON.stringify(args) ?? '').replace(/\s+/g, ' ')), maxChars);
  } catch {
    return '[unserializable]';
  }
}

function capToolResult(result: ToolResult, maxChars: number): ToolResult {
  if (result.result === undefined) return result;
  const text = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
  return { ...result, result: clampText(text ?? '', maxChars) };
}

interface PassOutcome {
  /** What the model said outside `<think>` blocks. */
  text: string;
  aborted: boolean;
  error?: Error;
  /** Ollama stopped at the output limit. */
  truncated?: boolean;
  /** How many characters of `text` were already shown; a `sniff` pass holds back from its first possible tool call. */
  emitted?: number;
  /** The stream ended inside a `<think>` block: the model spent its output on reasoning and never answered. */
  unterminatedThinking?: boolean;
}

type PassMode = 'stream' | 'sniff';

/** Start of the first thing that could be a tool call: a fence or a JSON object (a bare array holds objects). */
const TOOL_MARKER = /```|\{/;

/** How many trailing characters might still turn into a marker (a lone or double backtick). */
function partialMarkerLength(text: string): number {
  if (text.endsWith('``')) return 2;
  return text.endsWith('`') ? 1 : 0;
}

/**
 * One turn at a time per conversation: a second message (another tab, Telegram) waits for the first reply to be saved
 * so history, generation and the assistant row stay one unit instead of interleaving.
 */
const sessionTails = new Map<string, Promise<void>>();

async function acquireSession(key: string, stopped: Promise<'stopped'>, onWait: () => Promise<void>): Promise<(() => void) | null> {
  const previous = sessionTails.get(key);
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = (previous ?? Promise.resolve()).then(() => mine);
  sessionTails.set(key, tail);
  const releaseOnce = (): void => {
    release();
    void tail.then(() => {
      if (sessionTails.get(key) === tail) sessionTails.delete(key);
    });
  };
  if (previous) {
    await onWait();
    const outcome = await Promise.race([previous.then(() => 'ready' as const), stopped]);
    if (outcome === 'stopped') {
      releaseOnce();
      return null;
    }
  }
  return releaseOnce;
}

export async function runChatTurn(rt: JarvisRuntime, input: TurnInput, onEvent: (event: TurnEvent) => void | Promise<void>): Promise<TurnResult> {
  const startedAt = Date.now();
  const turn = new AbortController();
  const result: TurnResult = {
    ok: false,
    text: '',
    sources: [],
    model: null,
    partial: false,
    truncated: false,
    usage: { promptTokens: 0, completionTokens: 0, calls: 0 },
    toolCalls: [],
  };
  let doneSent = false;
  const pendingLedger: Array<Promise<unknown>> = [];
  /** Every character of reply text that was shown to the owner; it is what gets saved. */
  let shown = '';

  // A consumer that throws (a closed socket, a failed Telegram edit) must not break the turn.
  const emit = async (event: TurnEvent): Promise<void> => {
    try {
      await onEvent(event);
    } catch (err: unknown) {
      logger.warn(`[ChatPipeline] Event consumer failed on '${event.type}': ${errorMessage(err)}`);
    }
  };
  const status = (text: string): Promise<void> => emit({ type: 'status', text });
  const emitChunk = async (text: string): Promise<void> => {
    shown += text;
    await emit({ type: 'chunk', text });
  };
  const fail = async (message: string, code?: string): Promise<void> => {
    result.error ??= { message, ...(code ? { code } : {}) };
    await emit({ type: 'error', message, ...(code ? { code } : {}) });
  };
  const sendDone = async (partial: boolean): Promise<void> => {
    if (doneSent) return;
    doneSent = true;
    result.partial = partial;
    await emit({ type: 'done', partial, ...(result.truncated ? { truncated: true } : {}) });
  };
  const isStopped = (): boolean => turn.signal.aborted || rt.killSwitch.isKilled();
  // Resolves when the turn is aborted or the kill switch trips (the runtime aborts every registered controller).
  const stopped = new Promise<'stopped'>((resolve) => {
    if (turn.signal.aborted) resolve('stopped');
    else turn.signal.addEventListener('abort', () => resolve('stopped'), { once: true });
  });
  /** Work that cannot observe an abort (a tool handler, an approval wait) must not keep the turn alive past it. */
  const unlessStopped = <T>(work: Promise<T>): Promise<T | 'stopped'> => {
    work.catch(() => undefined);
    return Promise.race([work, stopped]);
  };
  const killedMessage = (): string => `Kill switch engaged: ${rt.killSwitch.getKillReason() || 'emergency stop'}. Nothing runs until the owner resets it.`;

  /**
   * Binds an approval this turn asked for to the turn: when the turn is stopped, timed out or killed the pending
   * request is denied, so a later tap on its prompt cannot run an action nobody is waiting for. Call it right after
   * the request was made (the broker registers it synchronously). Returns the disposer.
   */
  const bindApprovals = (matches: (request: ApprovalRequest) => boolean): (() => void) => {
    const denyPending = (): void => {
      for (const request of rt.approvals.pending()) if (matches(request)) rt.approvals.resolve(request.id, false, 'system');
    };
    if (turn.signal.aborted) denyPending();
    else turn.signal.addEventListener('abort', denyPending, { once: true });
    return () => turn.signal.removeEventListener('abort', denyPending);
  };

  // An abort or kill that lands before any generation started.
  const finishStopped = async (): Promise<void> => {
    if (rt.killSwitch.isKilled()) await fail(killedMessage(), 'kill_switch');
    await sendDone(false);
  };

  const onInputAbort = (): void => turn.abort(input.signal?.reason ?? 'Aborted by caller');
  let unlockSession: () => void = () => undefined;

  try {
    // 1. Kill switch: nothing is saved or generated while it is engaged.
    try {
      rt.killSwitch.assertNotKilled();
    } catch (err: unknown) {
      await fail(errorMessage(err), 'kill_switch');
      await sendDone(false);
      return result;
    }
    if (!input.prompt.trim()) {
      await fail('The message is empty.', 'empty_prompt');
      await sendDone(false);
      return result;
    }
    if (input.signal?.aborted) {
      await sendDone(false);
      return result;
    }
    input.signal?.addEventListener('abort', onInputAbort, { once: true });
    rt.registerAbort(turn);

    // One turn at a time per conversation; a Stop while waiting leaves the queue at once.
    const releaseSession = await acquireSession(`${input.userId}:${input.sessionId}`, stopped, () =>
      status('Waiting for the previous reply in this conversation to finish...')
    );
    if (!releaseSession) {
      await finishStopped();
      return result;
    }
    let sessionReleased = false;
    unlockSession = (): void => {
      if (sessionReleased) return;
      sessionReleased = true;
      releaseSession();
    };
    if (isStopped()) {
      await finishStopped();
      return result;
    }

    // 2. The session must be the user's own; history is read before the new message is saved.
    const session = await rt.sessions.getSession(input.userId, input.sessionId);
    if (!session) {
      await fail('Session not found.', 'session_not_found');
      await sendDone(false);
      return result;
    }
    const history: ConversationTurn[] = (await rt.sessions.getMessages(input.userId, input.sessionId)).map((message) => ({
      role: message.role,
      // A reply saved before reasoning was stripped must not spend the next turns' context on its chain of thought.
      content: message.role === 'assistant' ? stripThinking(message.content) : message.content,
    }));

    // A secret is stored only in the vault (step 3); the transcript, the model and the memory tiers see a redacted copy.
    const prompt = detectSensitive(input.prompt).sensitive ? redactSensitive(input.prompt) : input.prompt;
    try {
      await rt.sessions.addMessage(input.userId, input.sessionId, { role: 'user', content: prompt });
    } catch (err: unknown) {
      await fail(err instanceof SessionNotFoundError ? 'Session not found.' : `Could not save your message: ${errorMessage(err)}`, 'session_not_found');
      await sendDone(false);
      return result;
    }

    // 3. "remember that ...": secrets go to the vault, everything else to the profile. The value is never echoed.
    const fact = parseRememberCommand(input.prompt);
    if (fact) {
      try {
        const stored = await rt.memory.rememberFact(input.userId, fact);
        await status(
          stored.stored === 'vault'
            ? `Stored in the encrypted vault as "${stored.tag ?? stored.key}" (${stored.created ? 'new entry' : 'updated'}). I will not repeat it.`
            : `Remembered "${stored.key}" in your profile (${stored.created ? 'new' : 'updated'}).`
        );
      } catch (err: unknown) {
        logger.warn(`[ChatPipeline] rememberFact failed: ${errorMessage(err)}`);
        await status('I could not save that to memory; it was not stored.');
      }
    }

    // 4. Research: only on request, or when the prompt is clearly a lookup.
    let researchFacts = '';
    let consensusScore: number | undefined;
    if (!(fact && input.useResearch !== true) && shouldResearchPrompt(prompt, input.useResearch)) {
      const research = await gatherResearch(rt, { userId: input.userId, prompt, signal: turn.signal, status });
      researchFacts = research.facts;
      consensusScore = research.consensusScore;
      result.sources = research.sources;
      if (research.sources.length > 0) await emit({ type: 'sources', urls: research.sources });
    }
    if (isStopped()) {
      await finishStopped();
      return result;
    }

    // 5. Model choice: installed models only, the owner's explicit choice honoured, no silent downloads.
    // Forced: the previous turn may have loaded or evicted a model since the cached snapshot, and the VRAM verdict
    // depends on what Ollama holds right now.
    const inventory = await rt.refreshInventory({ force: true });
    if (inventory.lastGoodAt === null && !rt.registry.hasInstalledInfo()) {
      await fail(`Ollama is unreachable, so no model can be chosen or run (${inventory.error ?? inventory.status}).`, 'ollama_unreachable');
      await sendDone(false);
      return result;
    }
    const confirmPull = rt.config.allowModelPull
      ? async (modelId: string, sizeBytes: number): Promise<boolean> => {
          // Pulling gigabytes is Tier 2: the gateway asks the owner through the approval broker. The wait ends with the turn.
          const asking = rt.gateway.executeAction(
            {
              tier: 2,
              actionType: 'MODEL_PULL',
              targetId: modelId,
              description: `Download model ${modelId}${sizeBytes > 0 ? ` (${(sizeBytes / 2 ** 30).toFixed(1)} GiB)` : ''}`,
              metadata: { model: modelId, sizeBytes },
            },
            async () => true,
            { requestedBy: input.surface }
          );
          const unbind = bindApprovals((request) => request.actionType === 'MODEL_PULL' && request.metadata?.model === modelId);
          try {
            const outcome = await unlessStopped(asking);
            // An approval that lands after the turn was stopped does not start a download.
            return outcome !== 'stopped' && !isStopped();
          } catch (err: unknown) {
            await status(`Model download not approved: ${errorMessage(err)}`);
            return false;
          } finally {
            unbind();
          }
        }
      : undefined;

    let decision: ProvisionDecision;
    try {
      decision = await rt.createProvisioner().ensureAndDispatch({
        prompt,
        explicitModel: input.explicitModel,
        allowPull: rt.config.allowModelPull,
        confirmPull,
        onProgress: (message) => status(message),
        signal: turn.signal,
      });
    } catch (err: unknown) {
      await fail(`Model selection failed: ${errorMessage(err)}`, 'model_unavailable');
      await sendDone(false);
      return result;
    }
    if (!decision.canRun) {
      await fail(decision.reason ?? decision.rationale, 'model_unavailable');
      await sendDone(false);
      return result;
    }
    const model = decision.targetModel;
    const modelDef = rt.registry.getModel(model);
    if (!modelDef) {
      await fail(`Model ${model} is not in the registry.`, 'model_unavailable');
      await sendDone(false);
      return result;
    }
    result.model = model;
    await emit({ type: 'model', model, lane: decision.lane, rationale: decision.rationale });

    // 6. Context: T0-T4 memory fitted to what is left after the request, research and tool text.
    const imageParts = (input.attachments ?? []).map((attachment) =>
      attachment.description
        ? `[Attached image, described by a vision model; untrusted data]\n${fenceUntrusted('image', attachment.description)}`
        : '[An image was attached but it could not be analysed, so it is not visible to you.]'
    );
    if ((input.attachments ?? []).some((attachment) => !attachment.description)) {
      await status('An attached image could not be described, so I am answering from the text only.');
    }
    const requestText = [prompt, ...imageParts].join('\n\n');

    const toolsOffered: ToolDefinition[] = fact ? [] : rt.tools.selectToolsForPrompt(prompt, MAX_TOOLS_OFFERED);
    let reflexMacro: ReflexMacro | null = null;
    let reflexHint: ReflexHint | undefined;
    if (!fact) {
      try {
        const match = await rt.reflexes.findReflexMatch(prompt);
        if (match) {
          reflexMacro = match.macro;
          reflexHint = ReflexCompiler.hintFromMatch(match);
          for (const step of match.macro.steps) {
            const tool = rt.tools.getTool(step);
            if (tool && toolsOffered.length < MAX_TOOLS_OFFERED && !toolsOffered.includes(tool)) toolsOffered.push(tool);
          }
        }
      } catch (err: unknown) {
        logger.warn(`[ChatPipeline] Reflex lookup skipped: ${errorMessage(err)}`);
      }
    }
    /** The only tools the model may call this turn: the ones its prompt listed. */
    const offeredNames = new Set(toolsOffered.map((tool) => tool.name));
    const toolSchemas: ToolSchemaSummary[] = toolsOffered.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      tier: tool.tier,
      isUntrusted: tool.source === 'mcp',
    }));

    let liveSessionIds: Set<string> | undefined;
    try {
      liveSessionIds = new Set((await rt.sessions.listSessions(input.userId)).map((entry) => entry.id));
    } catch (err: unknown) {
      logger.warn(`[ChatPipeline] Could not list sessions for the summary filter: ${errorMessage(err)}`);
    }
    const baseContext = await buildConversationContext({ memory: rt.memory, userId: input.userId, sessionId: input.sessionId, prompt, turns: history, liveSessionIds });
    const researchBudgetChars =
      Math.max(0, PROMPT_TOKEN_CAP - estimateTokens(requestText) - SYSTEM_PROMPT_RESERVE_TOKENS - MIN_CONTEXT_BUDGET_TOKENS - (toolSchemas.length > 0 ? TOOL_BUDGET_TOKENS : 0)) * 4;
    const facts = clampText(researchFacts, researchBudgetChars);
    const taskType = facts ? 'research' : decision.category === 'code' || decision.category === 'precision' ? 'code' : decision.category === 'reasoning' ? 'reasoning' : 'chat';

    const toolOutputs: ToolResult[] = [];
    const assemble = (withTools: boolean): string => {
      let perResultChars = TOOL_RESULT_CHARS;
      for (;;) {
        const toolResults: ToolResultSummary[] = toolOutputs.map((output) => ({
          tool: output.name,
          output: fenceToolResult(capToolResult(output, perResultChars)),
          isError: output.error !== undefined,
        }));
        const schemas = withTools ? toolSchemas : [];
        const fitted = fitContextToBudget(baseContext, [requestText, facts, JSON.stringify(schemas), ...toolResults.map((r) => r.output)]);
        const text = CognitionEngine.formatPrompt(requestText, {
          taskType,
          memoryContext: fitted.text,
          researchFacts: facts,
          consensusScore,
          activeModel: model,
          toolSchemas: schemas,
          toolResults,
          reflexHint: withTools ? reflexHint : undefined,
        });
        // Large tool output is shrunk before the cap is given up on.
        if (assertPromptWithinCap(text).ok || perResultChars <= 250 || toolResults.length === 0) return text;
        perResultChars = Math.floor(perResultChars / 2);
      }
    };

    const firstPrompt = assemble(toolSchemas.length > 0);
    const capCheck = assertPromptWithinCap(firstPrompt);
    if (!capCheck.ok) {
      await fail(`Your message is too long for the ${capCheck.cap}-token prompt limit (about ${capCheck.tokens} tokens). Please shorten it.`, 'prompt_too_large');
      await sendDone(false);
      return result;
    }

    // 7. Generate while holding the governor lease, so web and Telegram turns serialize on heavy models.
    const recordUsage = (usage: GenerationUsage, passStartedAt: number): void => {
      result.usage.promptTokens += usage.promptTokens;
      result.usage.completionTokens += usage.completionTokens;
      result.usage.calls += 1;
      pendingLedger.push(
        rt.ledger
          .recordUsage({
            model: usage.model || model,
            lane: decision.lane,
            taskId: input.taskId,
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            latencyMs: usage.totalDurationMs ?? Date.now() - passStartedAt,
            loadMs: usage.loadDurationMs,
            promptEvalMs: usage.promptEvalDurationMs,
            decodeMs: usage.evalDurationMs,
            doneReason: usage.doneReason,
          })
          .catch((err: unknown) => logger.warn(`[ChatPipeline] Ledger write failed: ${errorMessage(err)}`))
      );
    };

    const runPass = async (promptText: string, mode: PassMode): Promise<PassOutcome> => {
      const provider = rt.providerFor(model);
      const passStartedAt = Date.now();
      const { maxOutputTokens, inferenceIdleTimeoutMs } = rt.limits;
      const contextTokens = Math.max(MIN_CONTEXT_WINDOW_TOKENS, Math.ceil((estimateTokens(promptText) + maxOutputTokens + CONTEXT_MARGIN_TOKENS) / 1024) * 1024);

      // A model that goes silent (a hung runner, a crashed GPU) must not hold the lease forever: this aborts the
      // provider request when no chunk arrives for `inferenceIdleTimeoutMs`, which frees the lease.
      const watchdog = new AbortController();
      let timedOut = false;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const armIdleTimer = (): void => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          timedOut = true;
          watchdog.abort(new Error('inference timed out'));
        }, inferenceIdleTimeoutMs);
        idleTimer.unref?.();
      };
      const timeoutError = (): Error =>
        Object.assign(new Error(`the model produced no output for ${Math.round(inferenceIdleTimeoutMs / 1000)} s and was stopped`), { code: 'INFERENCE_TIMEOUT' });

      let truncated = false;
      const options: GenerateStreamOptions = {
        maxTokens: maxOutputTokens,
        contextTokens,
        think: resolveThink(rt.config.thinkingMode, model, decision.category),
        signal: AbortSignal.any([turn.signal, watchdog.signal]),
        onUsage: (usage) => {
          if (usage.truncated) truncated = true;
          // A final line that only said "cut off" carries no counts; a ledger row of zeros would pass for a real figure.
          if (usage.promptTokens === 0 && usage.completionTokens === 0 && usage.totalDurationMs === undefined) return;
          recordUsage(usage, passStartedAt);
        },
      };

      const filter = new ThinkStreamFilter();
      let text = '';
      let emitted = 0;
      const emitUpTo = async (limit: number): Promise<void> => {
        if (limit <= emitted) return;
        await emitChunk(text.slice(emitted, limit));
        emitted = limit;
      };
      // `stream` shows text as it arrives. `sniff` shows prose as it arrives too, but holds back from the first fence or
      // `{` (and a half-typed fence): that is where a tool call starts, and it is shown only if it turns out to be an answer.
      const show = async (): Promise<void> => {
        if (mode === 'stream') return emitUpTo(text.length);
        const marker = text.search(TOOL_MARKER);
        return emitUpTo(marker === -1 ? text.length - partialMarkerLength(text) : marker);
      };
      const outcome = (extra: Partial<PassOutcome> = {}): PassOutcome => ({
        text,
        emitted,
        aborted: isStopped(),
        ...(truncated ? { truncated: true } : {}),
        ...(filter.unterminated ? { unterminatedThinking: true } : {}),
        ...extra,
      });

      armIdleTimer();
      try {
        const stream: AsyncIterable<string> = provider.generateStream
          ? provider.generateStream(promptText, options)
          : (async function* () {
              yield await provider.generate(promptText, options);
            })();
        for await (const chunk of stream) {
          if (isStopped()) break;
          armIdleTimer();
          const piece = filter.push(chunk);
          if (piece) {
            text += piece;
            await show();
          }
        }
        const tail = filter.end();
        if (tail) {
          text += tail;
          await show();
        }
        return timedOut ? outcome({ error: timeoutError() }) : outcome();
      } catch (err: unknown) {
        return outcome({ error: timedOut ? timeoutError() : err instanceof Error ? err : new Error(String(err)) });
      } finally {
        clearTimeout(idleTimer);
      }
    };

    // Each pass takes the lease on its own, so a long wait for an owner approval never holds a heavy model.
    // A stop while the turn is still queued leaves the queue at once (the governor watches the signal); once the
    // pass has started it winds down by itself (its provider request carries the abort signal) and keeps its partial text.
    const leasedPass = async (promptText: string, mode: PassMode): Promise<PassOutcome> => {
      const holder = rt.governor.getActiveHeavyModel();
      if (isHeavyModel(modelDef) && holder !== null) await status(`Queued: waiting for ${holder} to finish before loading ${model}.`);
      try {
        return await rt.governor.withLease(
          modelDef,
          async () => {
            if (isStopped()) return { text: '', aborted: true };
            return runPass(promptText, mode);
          },
          { timeoutMs: rt.limits.leaseWaitMs, signal: turn.signal }
        );
      } catch (err: unknown) {
        return { text: '', aborted: isStopped(), error: err instanceof Error ? err : new Error(String(err)) };
      }
    };

    const runToolCalls = async (calls: ToolCall[]): Promise<void> => {
      for (const call of calls) {
        if (isStopped() || result.toolCalls.length >= MAX_TOOL_CALLS_PER_TURN) break;
        const tool = rt.tools.getTool(call.name);
        const tier = tool?.tier ?? 1;
        // Anything that leaves the machine is shown to the owner with its full arguments (secrets redacted).
        const argsPreview = previewArgs(call.args, OUTBOUND_TOOLS.has(call.name) ? OUTBOUND_PREVIEW_CHARS : 200);
        await emit({ type: 'tool', name: call.name, tier, state: 'requested', detail: argsPreview });

        // The model may only call what its prompt offered; a registered tool it merely guessed the name of is refused.
        if (!offeredNames.has(call.name)) {
          const error = `Tool '${call.name}' was not offered for this turn.`;
          toolOutputs.push({ toolCallId: call.id, name: call.name, error, errorCode: 'FORBIDDEN', untrusted: true });
          result.toolCalls.push({ name: call.name, tier, ok: false, error, argsPreview });
          await emit({ type: 'tool', name: call.name, tier, state: 'denied', detail: error });
          continue;
        }

        // Never `isOwnerExplicitlyApproved`: a Tier 2 call waits for the owner through the approval broker.
        // Requests that already existed belong to something else; the one this call raises is the new one for this tool.
        const alreadyPending = new Set(rt.approvals.pending().map((request) => request.id));
        const running = rt.executor.executeCall(call, { requestedBy: input.surface, signal: turn.signal });
        // A Stop (or the kill switch) denies this call's pending approval, so a late tap cannot run it afterwards.
        const unbind = bindApprovals(
          (request) => request.actionType === 'TOOL_CALL' && request.requestedBy === input.surface && request.metadata?.tool === call.name && !alreadyPending.has(request.id)
        );
        let awaited: ToolResult | 'stopped';
        try {
          awaited = await unlessStopped(running);
        } finally {
          unbind();
        }
        const output: ToolResult =
          awaited === 'stopped'
            ? {
                toolCallId: call.id,
                name: call.name,
                error: tier >= 2 ? 'Stopped before the tool finished; an action the owner had already approved may still complete.' : 'Stopped before the tool finished.',
                errorCode: 'KILLED',
                untrusted: true,
              }
            : awaited;
        toolOutputs.push(output);
        const ok = output.error === undefined;
        result.toolCalls.push({ name: call.name, tier, ok, ...(ok ? {} : { error: output.error }), argsPreview });
        if (ok) {
          if (tier >= 2) await emit({ type: 'tool', name: call.name, tier, state: 'approved' });
          await emit({ type: 'tool', name: call.name, tier, state: 'done', ...(output.truncated ? { detail: 'result truncated' } : {}) });
        } else {
          const denied = output.errorCode === 'DENIED' || output.errorCode === 'FORBIDDEN';
          await emit({ type: 'tool', name: call.name, tier, state: denied ? 'denied' : 'error', detail: clampText(output.error ?? '', 300) });
        }
      }
    };

    let failure: Error | undefined;
    let aborted = false;
    let lastPass: PassOutcome | null = null;
    const finalPass = (pass: PassOutcome): void => {
      lastPass = pass;
      aborted = pass.aborted;
      failure = pass.error;
    };

    if (toolSchemas.length === 0) {
      finalPass(await leasedPass(firstPrompt, 'stream'));
    } else {
      // Tools are on offer, so each pass is sniffed: prose streams, tool-call JSON is held back and executed. Once the
      // tool budget is spent, a last pass streams with no tools on offer.
      let rounds = 0;
      for (;;) {
        const withTools = rounds < MAX_TOOL_ROUNDS && result.toolCalls.length < MAX_TOOL_CALLS_PER_TURN;
        const promptText = rounds === 0 ? firstPrompt : assemble(withTools);
        const size = assertPromptWithinCap(promptText);
        if (!size.ok) {
          failure = new Error(`the tool results made the prompt too large (about ${size.tokens} tokens, limit ${size.cap})`);
          break;
        }
        if (!withTools) {
          finalPass(await leasedPass(promptText, 'stream'));
          break;
        }
        const pass = await leasedPass(promptText, 'sniff');
        const calls = pass.error || pass.aborted ? [] : rt.executor.parseModelToolCalls(pass.text);
        if (calls.length === 0) {
          finalPass(pass);
          // Held-back text that was not a tool call is the answer after all: show it now.
          const rest = pass.text.slice(pass.emitted ?? 0);
          if (rest) await emitChunk(rest);
          break;
        }
        rounds += 1;
        await runToolCalls(calls);
        if (isStopped()) {
          aborted = true;
          break;
        }
      }
    }

    // 8. Outcome: no canned reply on failure, and a partial or cut-off reply is saved as such.
    const answer = shown;
    const hasText = answer.trim() !== '';
    const finalOutcome = lastPass as PassOutcome | null;
    const hitOutputLimit = !failure && !aborted && finalOutcome?.truncated === true;
    let partial = false;
    if (failure && !aborted) {
      const code = (failure as { code?: unknown }).code;
      if (hasText) {
        partial = true;
        await fail(`The response was interrupted: ${failure.message}`, 'stream_interrupted');
      } else {
        await fail(`Model ${model} could not answer: ${failure.message}`, typeof code === 'string' ? code.toLowerCase() : 'provider_error');
      }
    } else if (aborted) {
      partial = hasText;
      if (rt.killSwitch.isKilled()) await fail(killedMessage(), 'kill_switch');
    } else if (hitOutputLimit) {
      // Ollama stopped at `num_predict`: what was shown ends mid-thought, so it is reported as cut off, never as complete.
      result.truncated = true;
      partial = hasText;
      const limit = rt.limits.maxOutputTokens;
      if (hasText) {
        const message = `The reply was cut off at the ${limit}-token output limit and is incomplete.`;
        result.error ??= { message, code: 'output_truncated' };
        await status(message);
      } else {
        await fail(
          finalOutcome?.unterminatedThinking
            ? `Model ${model} used its whole ${limit}-token output limit on reasoning and never gave an answer.`
            : `Model ${model} hit the ${limit}-token output limit before producing an answer.`,
          'output_truncated'
        );
      }
    } else if (!hasText) {
      await fail(`Model ${model} returned an empty response.`, 'empty_response');
    }

    result.text = hasText ? answer : '';
    result.ok = hasText && !failure && !aborted && !result.truncated;
    if (hasText) {
      try {
        await rt.sessions.addMessage(input.userId, input.sessionId, {
          role: 'assistant',
          content: answer,
          meta: {
            sources: result.sources,
            ...(consensusScore !== undefined ? { confidence: consensusScore } : {}),
            ...(result.toolCalls.length > 0 ? { toolCalls: result.toolCalls } : {}),
            ...(partial ? { partial: true } : {}),
            ...(result.truncated ? { truncated: true } : {}),
          },
        });
      } catch (err: unknown) {
        // The session can be deleted mid-turn (another tab, or Telegram); the reply is dropped with a warning.
        logger.warn(`[ChatPipeline] Assistant reply not saved: ${errorMessage(err)}`, { sessionId: input.sessionId });
      }
    }
    await Promise.allSettled(pendingLedger);
    await sendDone(partial);
    // The reply is saved: the next message in this conversation may start. Bookkeeping below does not hold it up.
    unlockSession();

    // 10. After `done`: reflex bookkeeping, the task episode, and the rolling summary every few messages.
    if (!isStopped()) {
      const durationMs = Date.now() - startedAt;
      const toolsFine = result.toolCalls.length > 0 && result.toolCalls.every((call) => call.ok);
      try {
        if (reflexMacro && result.toolCalls.length > 0) {
          if (toolsFine && result.ok) await rt.reflexes.recordSuccess(reflexMacro.id, durationMs);
          else await rt.reflexes.recordFailure(reflexMacro.id);
        } else if (!reflexMacro && toolsFine && result.ok) {
          const steps = result.toolCalls.map((call) => call.name);
          if (new Set(steps).size >= 2) await rt.reflexes.compileReflex(prompt, steps, durationMs);
        }
      } catch (err: unknown) {
        logger.warn(`[ChatPipeline] Reflex bookkeeping skipped: ${errorMessage(err)}`);
      }

      // A session deleted during the turn must not get episodes or summaries written back after its delete.
      const sessionStillExists = (await rt.sessions.getSession(input.userId, input.sessionId).catch(() => null)) !== null;
      if (result.ok && sessionStillExists) {
        await recordTaskEpisode(rt.memory, { userId: input.userId, sessionId: input.sessionId, goal: prompt, outcome: answer, executionTimeMs: durationMs });
      }
      if (sessionStillExists) {
        // Background work with its own controller: the kill switch aborts it, and neither the summary request nor
        // the wait for the lease can hold a heavy model or the process open indefinitely.
        const summaryAbort = new AbortController();
        rt.registerAbort(summaryAbort);
        try {
          const messages = await rt.sessions.getMessages(input.userId, input.sessionId);
          if (shouldSummarize(messages.length)) {
            const installedTags = rt.registry.listInstalled().map((def) => rt.registry.getInstalledTag(def.id) ?? def.id);
            const summarizerModel = pickSmallestModel(installedTags) ?? model;
            const summarizerDef = rt.registry.getModel(summarizerModel) ?? modelDef;
            // Rolling summaries are redacted inside `summarizeAndStoreSession`, so no secret reaches the summarizer.
            await rt.governor.withLease(
              summarizerDef,
              () =>
                summarizeAndStoreSession({
                  memory: rt.memory,
                  summarizer: rt.providerFor(summarizerModel),
                  userId: input.userId,
                  sessionId: input.sessionId,
                  turns: messages.map((message) => ({ role: message.role, content: message.content })),
                  signal: summaryAbort.signal,
                  timeoutMs: SUMMARY_TIMEOUT_MS,
                  think: resolveThink(rt.config.thinkingMode, summarizerModel, 'chat'),
                }),
              { timeoutMs: SUMMARY_LEASE_WAIT_MS, signal: summaryAbort.signal }
            );
          }
        } catch (err: unknown) {
          logger.warn(`[ChatPipeline] Post-turn summary skipped: ${errorMessage(err)}`);
        } finally {
          rt.unregisterAbort(summaryAbort);
        }
      }
    }
    return result;
  } catch (err: unknown) {
    logger.error(`[ChatPipeline] Turn failed unexpectedly: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    await fail(`Unexpected error: ${errorMessage(err)}`, 'internal');
    await Promise.allSettled(pendingLedger);
    await sendDone(result.text.trim() !== '');
    return result;
  } finally {
    unlockSession();
    input.signal?.removeEventListener('abort', onInputAbort);
    rt.unregisterAbort(turn);
  }
}
