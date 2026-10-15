/**
 * Jarvis Local AI Agent: Unified LLM Provider Interface
 * Authority: Section 7.5, Section 18.1
 */

import { z } from 'zod';
import { logger } from '../utils/logger.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Default context window sent as `num_ctx`; Ollama otherwise falls back to its ~4k default and silently truncates the prompt head. */
export const DEFAULT_CONTEXT_TOKENS = 16_384;

const MIN_CONTEXT_TOKENS = 512;
const DEFAULT_MAX_OUTPUT_TOKENS = 1024;
const DEFAULT_CHAT_TIMEOUT_MS = 300_000;
const DEFAULT_LIST_TIMEOUT_MS = 5_000;
const DEFAULT_PULL_TIMEOUT_MS = 3 * 60 * 60 * 1000;

/** Real token counts and timings reported by the backend for one completed generation. */
export interface GenerationUsage {
  model: string;
  promptTokens: number;
  completionTokens: number;
  /** Wall-clock time the backend spent end to end, when it reports one. */
  totalDurationMs?: number;
  /** Time the backend spent generating completion tokens, when it reports one. */
  evalDurationMs?: number;
  promptEvalDurationMs?: number;
  loadDurationMs?: number;
  /** completionTokens / evalDuration; absent when the backend gave no eval duration. */
  tokensPerSec?: number;
  /** Ollama `done_reason` of the final line (`stop`, `length`, `load`...); absent when the backend sent none. */
  doneReason?: string;
  /** True when generation stopped at the output limit (`done_reason: 'length'`), so the reply is cut off mid-thought. */
  truncated?: boolean;
}

export interface GenerateOptions {
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
  /** Model context window in tokens, sent as Ollama `options.num_ctx`. Defaults to the provider's default (16384). */
  contextTokens?: number;
  /** Aborts the HTTP request (streaming and non-streaming). */
  signal?: AbortSignal;
  /** Overall request timeout for non-streaming calls; for streams it is applied to the whole generation when set. */
  timeoutMs?: number;
  /** Ollama's top-level `think` switch. Left out of the request when undefined, so the model keeps its own default. */
  think?: boolean;
  /** Called once, with the backend's real counts, when a generation completes. Not called for failed or aborted calls. */
  onUsage?: (usage: GenerationUsage) => void;
}

export interface GenerateStreamOptions extends GenerateOptions {
  signal?: AbortSignal;
}

/** One non-streaming `/api/generate` call made only to read Ollama's own timing counters. */
export interface SpeedProbeRequest {
  prompt: string;
  numCtx: number;
  numPredict: number;
  think: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Ollama's final-object counters exactly as reported (durations in nanoseconds); a field the backend left out stays undefined. */
export interface SpeedProbeCounters {
  loadDurationNs?: number;
  promptEvalCount?: number;
  promptEvalDurationNs?: number;
  evalCount?: number;
  evalDurationNs?: number;
  totalDurationNs?: number;
  doneReason?: string;
}

/** What `/api/ps` reports for one resident model. `contextLength` is absent on Ollama builds that do not send it. */
export interface ResidentModelInfo {
  name: string;
  sizeBytes: number;
  sizeVramBytes: number;
  contextLength?: number;
}

export interface SpeedProbeClient {
  generateOnce(request: SpeedProbeRequest): Promise<SpeedProbeCounters>;
  /** The model's `/api/ps` entry, or null when it is not resident. */
  residentModel(options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<ResidentModelInfo | null>;
}

export interface PullProgress {
  status: string;
  completedBytes?: number;
  totalBytes?: number;
  percent?: number;
}

export interface PullModelOptions {
  onProgress?: (progress: PullProgress) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface InstalledModel {
  name: string;
  sizeBytes: number;
  modifiedAt?: string;
}

function combineSignals(signal: AbortSignal | undefined, timeoutMs: number | undefined): AbortSignal | undefined {
  const signals: AbortSignal[] = [];
  if (signal) signals.push(signal);
  if (timeoutMs !== undefined && timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs));
  if (signals.length === 0) return undefined;
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
}

function resolveContextTokens(requested: number | undefined, fallback: number): number {
  const value = requested ?? fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.max(MIN_CONTEXT_TOKENS, Math.floor(value));
}

/** Tags Ollama has answered "does not support thinking" for; shared by every provider instance because they are created per call. */
const thinkUnsupportedModels = new Set<string>();

/** Forgets which models rejected `think`. Only tests and a model re-pull need it. */
export function resetThinkingSupportCache(): void {
  thinkUnsupportedModels.clear();
}

const THINK_REJECTED = /does not support thinking|doesn't support thinking|thinking is not supported/i;

function nsToMs(ns: number | undefined): number | undefined {
  return ns === undefined ? undefined : Math.round(ns / 1e6);
}

const OllamaStatsShape = {
  prompt_eval_count: z.number().optional(),
  eval_count: z.number().optional(),
  total_duration: z.number().optional(),
  load_duration: z.number().optional(),
  prompt_eval_duration: z.number().optional(),
  eval_duration: z.number().optional(),
};

const OllamaStreamLineSchema = z.object({
  response: z.string().optional(),
  done: z.boolean().optional(),
  done_reason: z.string().optional(),
  error: z.string().optional(),
  ...OllamaStatsShape,
});

const OllamaChatResponseSchema = z.object({
  message: z.object({ content: z.string().optional() }).optional(),
  error: z.string().optional(),
  ...OllamaStatsShape,
});

const OllamaTagsSchema = z.object({
  models: z
    .array(z.object({ name: z.string(), size: z.number().optional(), modified_at: z.string().optional() }))
    .optional(),
});

const OllamaPullLineSchema = z.object({
  status: z.string().optional(),
  error: z.string().optional(),
  total: z.number().optional(),
  completed: z.number().optional(),
});

interface OllamaStats {
  prompt_eval_count?: number;
  eval_count?: number;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_duration?: number;
  eval_duration?: number;
}

function usageFromOllama(model: string, stats: OllamaStats, doneReason?: string, maxTokens?: number): GenerationUsage | null {
  const truncated = doneReason === 'length' || (maxTokens !== undefined && doneReason === undefined && (stats.eval_count ?? 0) >= maxTokens);
  // A final line without counts is still reported when it says the reply was cut off: the caller must learn that.
  if (stats.prompt_eval_count === undefined && stats.eval_count === undefined && !truncated) return null;
  const completionTokens = stats.eval_count ?? 0;
  const evalDurationMs = nsToMs(stats.eval_duration);
  return {
    model,
    promptTokens: stats.prompt_eval_count ?? 0,
    completionTokens,
    totalDurationMs: nsToMs(stats.total_duration),
    evalDurationMs,
    promptEvalDurationMs: nsToMs(stats.prompt_eval_duration),
    loadDurationMs: nsToMs(stats.load_duration),
    tokensPerSec:
      stats.eval_duration && stats.eval_duration > 0
        ? Math.round((completionTokens / (stats.eval_duration / 1e9)) * 100) / 100
        : undefined,
    ...(doneReason !== undefined ? { doneReason } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}

function emitUsage(options: GenerateOptions, usage: GenerationUsage | null): void {
  if (!usage || !options.onUsage) return;
  try {
    options.onUsage(usage);
  } catch (err: unknown) {
    logger.warn(`[provider] onUsage callback threw: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const GeminiUsageSchema = z.object({
  promptTokenCount: z.number().optional(),
  candidatesTokenCount: z.number().optional(),
});

const GeminiStreamEventSchema = z.object({
  usageMetadata: GeminiUsageSchema.optional(),
  candidates: z
    .array(z.object({ content: z.object({ parts: z.array(z.object({ text: z.string().optional() })).optional() }).optional() }))
    .optional(),
});

/**
 * Splits a byte stream into complete lines. Partial lines are buffered across network chunks,
 * and `TextDecoder({ stream: true })` keeps multi-byte characters intact across chunk boundaries.
 */
export async function* readLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) yield line;
        newlineIndex = buffer.indexOf('\n');
      }
    }
    buffer += decoder.decode();
    const last = buffer.trim();
    if (last) yield last;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * Server-sent events reader (OpenAI/Gemini style): yields the payload of each `data: ` line and stops at `[DONE]`.
 */
export async function* readSseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string, void, undefined> {
  for await (const line of readLines(body)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') return;
    if (payload) yield payload;
  }
}

export interface LLMProvider {
  generate(prompt: string, options?: GenerateOptions): Promise<string>;
  generateStream?(prompt: string, options?: GenerateStreamOptions): AsyncIterable<string>;
  chat(messages: ChatMessage[], options?: GenerateOptions): Promise<string>;
  getModel(): string;
  getBaseUrl(): string;
  setModel?(model: string): void;
  listModels?(): Promise<string[]>;
  /** Like `listModels` but throws when the backend is unreachable, so "unreachable" is distinguishable from "no models". */
  listModelsStrict?(): Promise<string[]>;
  pullModel?(name: string, options?: PullModelOptions): Promise<boolean>;
}

export interface OllamaProviderOptions {
  baseUrl?: string;
  model?: string;
  /** Context window sent when a call does not pass `contextTokens`. */
  defaultContextTokens?: number;
}

export class OllamaProvider implements LLMProvider, SpeedProbeClient {
  private baseUrl: string;
  private model: string;
  private defaultContextTokens: number;

  constructor(options: OllamaProviderOptions = {}) {
    this.baseUrl = options.baseUrl ?? 'http://127.0.0.1:11434';
    this.model = options.model ?? 'qwen3:8b';
    this.defaultContextTokens = options.defaultContextTokens ?? DEFAULT_CONTEXT_TOKENS;
  }

  public getModel(): string {
    return this.model;
  }

  public getBaseUrl(): string {
    return this.baseUrl;
  }

  private buildOptions(options: GenerateOptions): Record<string, unknown> {
    return {
      temperature: options.temperature ?? 0.7,
      num_predict: options.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      num_ctx: resolveContextTokens(options.contextTokens, this.defaultContextTokens),
      stop: options.stop,
    };
  }

  /**
   * POSTs to Ollama with the top-level `think` field only when defined. Ollama answers HTTP 400 "does not support
   * thinking" for models without a thinking mode; that is retried once without the field and remembered per model tag.
   */
  private async post(path: string, body: Record<string, unknown>, think: boolean | undefined, signal: AbortSignal | undefined): Promise<Response> {
    const send = (withThink: boolean | undefined): Promise<Response> =>
      fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify(withThink === undefined ? body : { ...body, think: withThink }),
      });
    const effective = thinkUnsupportedModels.has(this.model) ? undefined : think;
    const response = await send(effective);
    if (response.status !== 400 || effective === undefined) return response;
    const detail = await response.text().catch(() => '');
    if (!THINK_REJECTED.test(detail)) {
      return new Response(detail, { status: response.status, statusText: response.statusText });
    }
    thinkUnsupportedModels.add(this.model);
    logger.info(`[OllamaProvider] ${this.model} does not support thinking; retrying without the think field.`);
    return send(undefined);
  }

  public async generate(prompt: string, options: GenerateStreamOptions = {}): Promise<string> {
    try {
      let text = '';
      for await (const chunk of this.generateStream(prompt, options)) {
        text += chunk;
      }
      return text;
    } catch (err: unknown) {
      logger.error(`[OllamaProvider] Generate failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  /**
   * Streams completion text from Ollama `/api/generate` (newline-delimited JSON, one object per line).
   * Aborting `options.signal` cancels the underlying HTTP request. The final `done` line carries the real
   * token counts, which are handed to `options.onUsage`.
   */
  public async *generateStream(prompt: string, options: GenerateStreamOptions = {}): AsyncGenerator<string, void, undefined> {
    const response = await this.post(
      '/api/generate',
      { model: this.model, prompt, stream: true, options: this.buildOptions(options) },
      options.think,
      combineSignals(options.signal, options.timeoutMs)
    );

    if (!response.ok) {
      throw new Error(`Ollama error ${response.status}: ${response.statusText}`);
    }
    if (!response.body) {
      throw new Error('Ollama returned no response body for a streaming request');
    }

    for await (const line of readLines(response.body)) {
      let json: unknown;
      try {
        json = JSON.parse(line);
      } catch {
        throw new Error(`Ollama sent a malformed stream line: ${line.slice(0, 200)}`);
      }
      const parsed = OllamaStreamLineSchema.safeParse(json);
      if (!parsed.success) {
        throw new Error(`Ollama sent an unexpected stream line: ${line.slice(0, 200)}`);
      }
      if (parsed.data.error) {
        throw new Error(`Ollama stream error: ${parsed.data.error}`);
      }
      if (parsed.data.done) {
        emitUsage(options, usageFromOllama(this.model, parsed.data, parsed.data.done_reason, options.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS));
        return;
      }
      if (parsed.data.response) {
        yield parsed.data.response;
      }
    }
    throw new Error('Ollama stream ended before the final done line (connection dropped or model crashed)');
  }

  public async chat(messages: ChatMessage[], options: GenerateOptions = {}): Promise<string> {
    try {
      const response = await this.post(
        '/api/chat',
        { model: this.model, messages, stream: false, options: this.buildOptions(options) },
        options.think,
        combineSignals(options.signal, options.timeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS)
      );

      if (!response.ok) {
        throw new Error(`Ollama chat error ${response.status}: ${response.statusText}`);
      }

      const parsed = OllamaChatResponseSchema.safeParse(await response.json());
      if (!parsed.success) {
        throw new Error('Ollama chat returned an unexpected response shape');
      }
      if (parsed.data.error) {
        throw new Error(`Ollama chat error: ${parsed.data.error}`);
      }
      emitUsage(options, usageFromOllama(this.model, parsed.data));
      return parsed.data.message?.content ?? '';
    } catch (err: unknown) {
      logger.error(`[OllamaProvider] Chat failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  /**
   * One non-streaming `/api/generate` call at temperature 0 with `keep_alive` left at Ollama's default. `think` is always
   * sent (the retry in `post` drops it for models that have no thinking mode), so a thinking model does not spend the
   * token budget on a hidden reasoning block when the caller asked for none.
   */
  public async generateOnce(request: SpeedProbeRequest): Promise<SpeedProbeCounters> {
    const response = await this.post(
      '/api/generate',
      {
        model: this.model,
        prompt: request.prompt,
        stream: false,
        options: { num_ctx: request.numCtx, num_predict: request.numPredict, temperature: 0 },
      },
      request.think,
      combineSignals(request.signal, request.timeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS)
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Ollama error ${response.status}: ${detail.slice(0, 200) || response.statusText}`);
    }
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null) throw new Error('Ollama returned an unexpected response shape');
    const record = body as Record<string, unknown>;
    if (typeof record.error === 'string') throw new Error(`Ollama error: ${record.error}`);
    const count = (key: string): number | undefined => (typeof record[key] === 'number' && Number.isFinite(record[key]) ? (record[key] as number) : undefined);
    return {
      loadDurationNs: count('load_duration'),
      promptEvalCount: count('prompt_eval_count'),
      promptEvalDurationNs: count('prompt_eval_duration'),
      evalCount: count('eval_count'),
      evalDurationNs: count('eval_duration'),
      totalDurationNs: count('total_duration'),
      ...(typeof record.done_reason === 'string' ? { doneReason: record.done_reason } : {}),
    };
  }

  public async residentModel(options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ResidentModelInfo | null> {
    const res = await fetch(`${this.baseUrl}/api/ps`, { signal: combineSignals(options.signal, options.timeoutMs ?? DEFAULT_LIST_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`Ollama /api/ps returned HTTP ${res.status}: ${res.statusText}`);
    const body: unknown = await res.json();
    const models = typeof body === 'object' && body !== null && Array.isArray((body as { models?: unknown }).models) ? ((body as { models: unknown[] }).models) : [];
    for (const entry of models) {
      if (typeof entry !== 'object' || entry === null) continue;
      const record = entry as Record<string, unknown>;
      if (record.name !== this.model && record.model !== this.model) continue;
      const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
      return {
        name: typeof record.name === 'string' ? record.name : this.model,
        sizeBytes: num(record.size),
        sizeVramBytes: num(record.size_vram),
        ...(typeof record.context_length === 'number' ? { contextLength: record.context_length } : {}),
      };
    }
    return null;
  }

  public setModel(model: string): void {
    this.model = model;
    logger.info(`[OllamaProvider] Active model switched to: ${model}`);
  }

  /** Installed models with real on-disk sizes. Throws when Ollama is unreachable or answers with an error. */
  public async listInstalledModels(options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<InstalledModel[]> {
    const res = await fetch(`${this.baseUrl}/api/tags`, {
      signal: combineSignals(options.signal, options.timeoutMs ?? DEFAULT_LIST_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`Ollama /api/tags returned HTTP ${res.status}: ${res.statusText}`);
    }
    const parsed = OllamaTagsSchema.safeParse(await res.json());
    if (!parsed.success) {
      throw new Error('Ollama /api/tags returned an unexpected response shape');
    }
    return (parsed.data.models ?? []).map((m) => ({ name: m.name, sizeBytes: m.size ?? 0, modifiedAt: m.modified_at }));
  }

  public async listModelsStrict(): Promise<string[]> {
    return (await this.listInstalledModels()).map((m) => m.name);
  }

  /** Never fabricates: an empty list means Ollama is unreachable or has no models; use `listModelsStrict` to tell which. */
  public async listModels(): Promise<string[]> {
    try {
      return await this.listModelsStrict();
    } catch (err: unknown) {
      logger.warn(`[OllamaProvider] Could not list installed models: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /**
   * Streams `/api/pull` (NDJSON), reporting progress through `options.onProgress`. Resolves `true` only once Ollama
   * reports `success`; resolves `false` on an error line, HTTP error, abort or timeout. Never throws.
   */
  public async pullModel(modelName: string, options: PullModelOptions = {}): Promise<boolean> {
    logger.info(`[OllamaProvider] Requesting pull for model: ${modelName}`);
    try {
      const res = await fetch(`${this.baseUrl}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: combineSignals(options.signal, options.timeoutMs ?? DEFAULT_PULL_TIMEOUT_MS),
        body: JSON.stringify({ name: modelName, stream: true }),
      });
      if (!res.ok || !res.body) {
        logger.warn(`[OllamaProvider] Model pull for ${modelName} rejected: HTTP ${res.status}`);
        return false;
      }

      let succeeded = false;
      for await (const line of readLines(res.body)) {
        let json: unknown;
        try {
          json = JSON.parse(line);
        } catch {
          continue;
        }
        const parsed = OllamaPullLineSchema.safeParse(json);
        if (!parsed.success) continue;
        if (parsed.data.error) {
          logger.warn(`[OllamaProvider] Model pull for ${modelName} failed: ${parsed.data.error}`);
          return false;
        }
        const status = parsed.data.status ?? '';
        if (status === 'success') succeeded = true;
        if (options.onProgress) {
          const total = parsed.data.total;
          const completed = parsed.data.completed;
          try {
            options.onProgress({
              status,
              completedBytes: completed,
              totalBytes: total,
              percent: total && completed !== undefined ? Math.min(100, Math.round((completed / total) * 1000) / 10) : undefined,
            });
          } catch (err: unknown) {
            logger.warn(`[OllamaProvider] onProgress callback threw: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
      if (!succeeded) {
        logger.warn(`[OllamaProvider] Model pull for ${modelName} ended without a success status`);
      }
      return succeeded;
    } catch (err: unknown) {
      logger.warn(`[OllamaProvider] Model pull failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }
}

export interface GeminiProviderOptions {
  apiKey?: string;
  model?: string;
}

const GEMINI_ORIGIN = 'https://generativelanguage.googleapis.com';
const DEFAULT_GEMINI_TIMEOUT_MS = 120_000;

export class GeminiProvider implements LLMProvider {
  private apiKey: string;
  private model: string;

  constructor(options: GeminiProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.GEMINI_API_KEY ?? '';
    this.model = options.model ?? 'gemini-2.0-flash';
  }

  public getModel(): string {
    return this.model;
  }

  public getBaseUrl(): string {
    return GEMINI_ORIGIN;
  }

  public setModel(model: string): void {
    this.model = model;
    logger.info(`[GeminiProvider] Active model switched to: ${model}`);
  }

  /** Static catalogue of selectable Gemini models; empty when no API key is configured so the UI never offers unusable models. */
  public async listModels(): Promise<string[]> {
    return this.apiKey ? ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'] : [];
  }

  public async pullModel(_name: string): Promise<boolean> {
    return true;
  }

  private headers(): Record<string, string> {
    // The key goes in a header, never the URL, because request URLs end up in logs and error messages.
    return { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey };
  }

  private requireKey(): void {
    if (!this.apiKey) {
      throw new Error('GEMINI_API_KEY is not configured in settings.env or environment variables.');
    }
  }

  private generationConfig(options: GenerateOptions): Record<string, unknown> {
    return {
      temperature: options.temperature ?? 0.7,
      maxOutputTokens: options.maxTokens ?? 2048,
      stopSequences: options.stop,
    };
  }

  private reportUsage(options: GenerateOptions, meta: z.infer<typeof GeminiUsageSchema> | undefined): void {
    if (!meta) return;
    emitUsage(options, {
      model: this.model,
      promptTokens: meta.promptTokenCount ?? 0,
      completionTokens: meta.candidatesTokenCount ?? 0,
    });
  }

  private async postJson(path: string, body: unknown, options: GenerateOptions): Promise<unknown> {
    const res = await fetch(`${GEMINI_ORIGIN}${path}`, {
      method: 'POST',
      headers: this.headers(),
      signal: combineSignals(options.signal, options.timeoutMs ?? DEFAULT_GEMINI_TIMEOUT_MS),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`Gemini API error ${res.status}: ${res.statusText} - ${errBody.slice(0, 500)}`);
    }
    return res.json();
  }

  public async generate(prompt: string, options: GenerateOptions = {}): Promise<string> {
    this.requireKey();
    const raw = await this.postJson(
      `/v1beta/models/${encodeURIComponent(this.model)}:generateContent`,
      { contents: [{ parts: [{ text: prompt }] }], generationConfig: this.generationConfig(options) },
      options
    );
    const parsed = GeminiStreamEventSchema.safeParse(raw);
    if (!parsed.success) throw new Error('Gemini returned an unexpected response shape');
    this.reportUsage(options, parsed.data.usageMetadata);
    return parsed.data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  }

  public async *generateStream(prompt: string, options: GenerateStreamOptions = {}): AsyncGenerator<string, void, undefined> {
    this.requireKey();
    const res = await fetch(`${GEMINI_ORIGIN}/v1beta/models/${encodeURIComponent(this.model)}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: this.headers(),
      signal: combineSignals(options.signal, options.timeoutMs),
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: this.generationConfig(options),
      }),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`Gemini API error ${res.status}: ${res.statusText} - ${errBody.slice(0, 500)}`);
    }
    if (!res.body) {
      throw new Error('Gemini returned no response body for a streaming request');
    }
    let lastUsage: z.infer<typeof GeminiUsageSchema> | undefined;
    for await (const payload of readSseData(res.body)) {
      let json: unknown;
      try {
        json = JSON.parse(payload);
      } catch {
        throw new Error(`Gemini sent a malformed stream event: ${payload.slice(0, 200)}`);
      }
      const parsed = GeminiStreamEventSchema.safeParse(json);
      if (!parsed.success) continue;
      if (parsed.data.usageMetadata) lastUsage = parsed.data.usageMetadata;
      const text = parsed.data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) yield text;
    }
    this.reportUsage(options, lastUsage);
  }

  public async chat(messages: ChatMessage[], options: GenerateOptions = {}): Promise<string> {
    this.requireKey();
    const contents = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

    const systemText = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const bodyPayload: Record<string, unknown> = {
      contents,
      generationConfig: this.generationConfig(options),
    };
    if (systemText) {
      bodyPayload.systemInstruction = { parts: [{ text: systemText }] };
    }

    const raw = await this.postJson(`/v1beta/models/${encodeURIComponent(this.model)}:generateContent`, bodyPayload, options);
    const parsed = GeminiStreamEventSchema.safeParse(raw);
    if (!parsed.success) throw new Error('Gemini returned an unexpected response shape');
    this.reportUsage(options, parsed.data.usageMetadata);
    return parsed.data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  }
}

export interface HybridProviderOptions {
  localProvider?: LLMProvider;
  cloudProvider?: LLMProvider;
  preferCloud?: boolean;
}

export class HybridProvider implements LLMProvider {
  private localProvider: LLMProvider;
  private cloudProvider?: LLMProvider;
  private preferCloud: boolean;

  constructor(options: HybridProviderOptions = {}) {
    this.localProvider = options.localProvider ?? new OllamaProvider();
    if (options.cloudProvider) {
      this.cloudProvider = options.cloudProvider;
    } else if (process.env.GEMINI_API_KEY) {
      this.cloudProvider = new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY });
    }
    this.preferCloud = options.preferCloud ?? Boolean(process.env.GEMINI_API_KEY);
  }

  public getModel(): string {
    return this.preferCloud && this.cloudProvider ? this.cloudProvider.getModel() : this.localProvider.getModel();
  }

  public getBaseUrl(): string {
    return this.preferCloud && this.cloudProvider ? this.cloudProvider.getBaseUrl() : this.localProvider.getBaseUrl();
  }

  public setModel(model: string): void {
    if (model.startsWith('gemini') && this.cloudProvider) {
      this.preferCloud = true;
      this.cloudProvider.setModel?.(model);
    } else {
      this.preferCloud = false;
      this.localProvider.setModel?.(model);
    }
  }

  public async listModels(): Promise<string[]> {
    const local = this.localProvider.listModels ? await this.localProvider.listModels() : [];
    const cloud = this.cloudProvider?.listModels ? await this.cloudProvider.listModels() : [];
    return [...cloud, ...local];
  }

  /** Throws when the local backend is unreachable; the cloud catalogue is static and never fails. */
  public async listModelsStrict(): Promise<string[]> {
    const local = this.localProvider.listModelsStrict
      ? await this.localProvider.listModelsStrict()
      : this.localProvider.listModels
        ? await this.localProvider.listModels()
        : [];
    const cloud = this.cloudProvider?.listModels ? await this.cloudProvider.listModels() : [];
    return [...cloud, ...local];
  }

  public async pullModel(name: string, options?: PullModelOptions): Promise<boolean> {
    if (name.startsWith('gemini')) return true;
    return this.localProvider.pullModel ? this.localProvider.pullModel(name, options) : true;
  }

  public async generate(prompt: string, options: GenerateOptions = {}): Promise<string> {
    if (this.preferCloud && this.cloudProvider) {
      try {
        return await this.cloudProvider.generate(prompt, options);
      } catch (err: unknown) {
        if (options.signal?.aborted) throw err;
        logger.warn(`[HybridProvider] Cloud inference failed (${err instanceof Error ? err.message : String(err)}). Falling back to local model.`);
      }
    }
    return this.localProvider.generate(prompt, options);
  }

  public async *generateStream(prompt: string, options: GenerateStreamOptions = {}): AsyncGenerator<string, void, undefined> {
    if (this.preferCloud && this.cloudProvider?.generateStream) {
      let yielded = false;
      try {
        for await (const chunk of this.cloudProvider.generateStream(prompt, options)) {
          yielded = true;
          yield chunk;
        }
        return;
      } catch (err: unknown) {
        // Falling back after partial output would duplicate text, so only fall back before the first chunk.
        if (yielded || options.signal?.aborted) throw err;
        logger.warn(`[HybridProvider] Cloud stream failed (${err instanceof Error ? err.message : String(err)}). Falling back to local model.`);
      }
    }
    if (!this.localProvider.generateStream) {
      yield await this.localProvider.generate(prompt, options);
      return;
    }
    yield* this.localProvider.generateStream(prompt, options);
  }

  public async chat(messages: ChatMessage[], options: GenerateOptions = {}): Promise<string> {
    if (this.preferCloud && this.cloudProvider) {
      try {
        return await this.cloudProvider.chat(messages, options);
      } catch (err: unknown) {
        if (options.signal?.aborted) throw err;
        logger.warn(`[HybridProvider] Cloud chat failed (${err instanceof Error ? err.message : String(err)}). Falling back to local model.`);
      }
    }
    return this.localProvider.chat(messages, options);
  }
}

export interface MockLLMProviderOptions {
  cannedResponse?: string;
  model?: string;
}

/** Test double only. Production code must never construct this to stand in for a real model. */
export class MockLLMProvider implements LLMProvider {
  private cannedResponse: string;
  private model: string;

  constructor(options: MockLLMProviderOptions = {}) {
    this.cannedResponse = options.cannedResponse ?? 'Jarvis mock synthesis response.';
    this.model = options.model ?? 'mock-lane-7b';
  }

  public getModel(): string {
    return this.model;
  }

  public setModel(model: string): void {
    this.model = model;
  }

  public async listModels(): Promise<string[]> {
    return [this.model, 'mock-coder:7b'];
  }

  public async pullModel(_name: string): Promise<boolean> {
    return true;
  }

  public getBaseUrl(): string {
    return 'http://mock-llm.local';
  }

  public async generate(_prompt: string, _options?: GenerateOptions): Promise<string> {
    return this.cannedResponse;
  }

  public async *generateStream(_prompt: string, _options?: GenerateStreamOptions): AsyncGenerator<string, void, undefined> {
    yield this.cannedResponse;
  }

  public async chat(messages: ChatMessage[], _options?: GenerateOptions): Promise<string> {
    const lastMsg = messages[messages.length - 1];
    return `${this.cannedResponse} (Replying to: "${lastMsg?.content ?? ''}")`;
  }
}
