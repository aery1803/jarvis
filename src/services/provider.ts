/**
 * Jarvis Local AI Agent: Unified LLM Provider Interface
 * Authority: Section 7.5, Section 18.1
 */

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

export interface LLMProvider {
  generate(prompt: string, options?: GenerateOptions): Promise<string>;
  chat(messages: ChatMessage[], options?: GenerateOptions): Promise<string>;
  getModel(): string;
  getBaseUrl(): string;
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
    this.model = options.model ?? 'qwen2.5:7b';
  }

  public getModel(): string {
    return this.model;
  }

  public getBaseUrl(): string {
    return this.baseUrl;
  }

  public async generate(prompt: string, options: GenerateOptions = {}): Promise<string> {
    const url = `${this.baseUrl}/api/generate`;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          prompt,
          stream: false,
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

      const data = (await response.json()) as any;
      return data.response ?? '';
    } catch (err: any) {
      logger.error(`[OllamaProvider] Generate failed: ${err.message}`);
      throw err;
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

  public getBaseUrl(): string {
    return 'http://mock-llm.local';
  }

  public async generate(_prompt: string, _options?: GenerateOptions): Promise<string> {
    return this.cannedResponse;
  }

  public async chat(messages: ChatMessage[], _options?: GenerateOptions): Promise<string> {
    const lastMsg = messages[messages.length - 1];
    return `${this.cannedResponse} (Replying to: "${lastMsg?.content ?? ''}")`;
  }
}
