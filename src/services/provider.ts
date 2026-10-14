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

export interface GenerateOptions {
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
}

export interface GenerateStreamOptions extends GenerateOptions {
  signal?: AbortSignal;
}

const OllamaStreamLineSchema = z.object({
  response: z.string().optional(),
  done: z.boolean().optional(),
  error: z.string().optional(),
});

const GeminiStreamEventSchema = z.object({
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
  pullModel?(name: string): Promise<boolean>;
}

export interface OllamaProviderOptions {
  baseUrl?: string;
  model?: string;
}

export class OllamaProvider implements LLMProvider {
  private baseUrl: string;
  private model: string;

  constructor(options: OllamaProviderOptions = {}) {
    this.baseUrl = options.baseUrl ?? 'http://127.0.0.1:11434';
    this.model = options.model ?? 'qwen3:8b';
  }

  public getModel(): string {
    return this.model;
  }

  public getBaseUrl(): string {
    return this.baseUrl;
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
   * Aborting `options.signal` cancels the underlying HTTP request.
   */
  public async *generateStream(prompt: string, options: GenerateStreamOptions = {}): AsyncGenerator<string, void, undefined> {
    const response = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: options.signal,
      body: JSON.stringify({
        model: this.model,
        prompt,
        stream: true,
        options: {
          temperature: options.temperature ?? 0.7,
          num_predict: options.maxTokens ?? 1024,
          stop: options.stop,
        },
      }),
    });

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
        return;
      }
      if (parsed.data.response) {
        yield parsed.data.response;
      }
    }
  }

  public async chat(messages: ChatMessage[], options: GenerateOptions = {}): Promise<string> {
    const url = `${this.baseUrl}/api/chat`;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages,
          stream: false,
          options: {
            temperature: options.temperature ?? 0.7,
            num_predict: options.maxTokens ?? 1024,
            stop: options.stop,
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`Ollama chat error ${response.status}: ${response.statusText}`);
      }

      const data = (await response.json()) as any;
      return data.message?.content ?? '';
    } catch (err: any) {
      logger.error(`[OllamaProvider] Chat failed: ${err.message}`);
      throw err;
    }
  }

  public setModel(model: string): void {
    this.model = model;
    logger.info(`[OllamaProvider] Active model switched to: ${model}`);
  }

  public async listModels(): Promise<string[]> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`);
      if (res.ok) {
        const data = (await res.json()) as any;
        return (data.models ?? []).map((m: any) => m.name);
      }
    } catch {
      // Return local default shortlist
    }
    return [this.model, 'qwen2.5-coder:7b'];
  }

  public async pullModel(modelName: string): Promise<boolean> {
    logger.info(`[OllamaProvider] Requesting pull for model: ${modelName}`);
    try {
      const res = await fetch(`${this.baseUrl}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: modelName, stream: false }),
      });
      return res.ok;
    } catch (err: any) {
      logger.warn(`[OllamaProvider] Model pull failed: ${err.message}`);
      return false;
    }
  }
}

export interface GeminiProviderOptions {
  apiKey?: string;
  model?: string;
}

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
    return 'https://generativelanguage.googleapis.com';
  }

  public setModel(model: string): void {
    this.model = model;
    logger.info(`[GeminiProvider] Active model switched to: ${model}`);
  }

  public async listModels(): Promise<string[]> {
    return ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'];
  }

  public async pullModel(_name: string): Promise<boolean> {
    return true;
  }

  public async generate(prompt: string, options: GenerateOptions = {}): Promise<string> {
    if (!this.apiKey) {
      throw new Error('GEMINI_API_KEY is not configured in settings.env or environment variables.');
    }
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: options.temperature ?? 0.7,
          maxOutputTokens: options.maxTokens ?? 2048,
          stopSequences: options.stop,
        },
      }),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`Gemini API error ${res.status}: ${res.statusText} - ${errBody}`);
    }

    const data = (await res.json()) as any;
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  }

  public async *generateStream(prompt: string, options: GenerateStreamOptions = {}): AsyncGenerator<string, void, undefined> {
    if (!this.apiKey) {
      throw new Error('GEMINI_API_KEY is not configured in settings.env or environment variables.');
    }
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:streamGenerateContent?alt=sse&key=${this.apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: options.signal,
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: options.temperature ?? 0.7,
          maxOutputTokens: options.maxTokens ?? 2048,
          stopSequences: options.stop,
        },
      }),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`Gemini API error ${res.status}: ${res.statusText} - ${errBody}`);
    }
    if (!res.body) {
      throw new Error('Gemini returned no response body for a streaming request');
    }
    for await (const payload of readSseData(res.body)) {
      const parsed = GeminiStreamEventSchema.safeParse(JSON.parse(payload));
      const text = parsed.success ? parsed.data.candidates?.[0]?.content?.parts?.[0]?.text : undefined;
      if (text) yield text;
    }
  }

  public async chat(messages: ChatMessage[], options: GenerateOptions = {}): Promise<string> {
    if (!this.apiKey) {
      throw new Error('GEMINI_API_KEY is not configured.');
    }
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;
    const contents = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

    const systemMsg = messages.find((m) => m.role === 'system');
    const bodyPayload: any = {
      contents,
      generationConfig: {
        temperature: options.temperature ?? 0.7,
        maxOutputTokens: options.maxTokens ?? 2048,
        stopSequences: options.stop,
      },
    };

    if (systemMsg) {
      bodyPayload.systemInstruction = {
        parts: [{ text: systemMsg.content }],
      };
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyPayload),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`Gemini API error ${res.status}: ${res.statusText} - ${errBody}`);
    }

    const data = (await res.json()) as any;
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
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

  public async pullModel(name: string): Promise<boolean> {
    if (name.startsWith('gemini')) return true;
    return this.localProvider.pullModel ? this.localProvider.pullModel(name) : true;
  }

  public async generate(prompt: string, options: GenerateOptions = {}): Promise<string> {
    if (this.preferCloud && this.cloudProvider) {
      try {
        return await this.cloudProvider.generate(prompt, options);
      } catch (err: any) {
        logger.warn(`[HybridProvider] Cloud inference failed (${err.message}). Falling back to local model.`);
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
      } catch (err: any) {
        logger.warn(`[HybridProvider] Cloud chat failed (${err.message}). Falling back to local model.`);
      }
    }
    return this.localProvider.chat(messages, options);
  }
}

export interface MockLLMProviderOptions {
  cannedResponse?: string;
  model?: string;
}

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
    return [this.model, 'mock-qwen2.5-coder:7b'];
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
