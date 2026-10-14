/**
 * Shared fakes for the runtime and chat-pipeline tests: a scripted LLM provider, a fake Ollama inventory,
 * and a `createRuntime` wrapper that touches no network, Ollama, adb, GPU or home directory.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRuntime, type JarvisRuntime, type RuntimeOptions } from '../../src/runtime/runtime.js';
import { DocumentStore } from '../../src/storage/collection.js';
import { CapabilityChecker } from '../../src/orchestration/capability.js';
import type { Diagnostics } from '../../src/web/diagnostics.js';
import type { GenerateStreamOptions, GenerationUsage, LLMProvider } from '../../src/services/provider.js';
import type { SearchOutcome } from '../../src/services/searxng.js';
import type { ExtractedContent } from '../../src/services/scraper.js';
import type { TurnEvent } from '../../src/chat/pipeline.js';

export const GIB = 2 ** 30;

/** The owner's box: about 47.8 GiB of Vulkan VRAM and 31.65 GB of host RAM (about 14 GiB of it free in normal use). */
export const REAL_VRAM_BYTES = 47.8 * GIB;
export const REAL_HOST_TOTAL_BYTES = 31.65 * GIB;
export const REAL_HOST_FREE_BYTES = 14 * GIB;

export const OWNER = 'owner';

/** On-disk sizes of the models installed on the owner's Ollama (`/api/tags`). */
export const REAL_MODEL_SIZES: Record<string, number> = {
  'qwen3:8b': 5225388164,
  'qwen3:14b': 9276198565,
  'qwen3:32b': 20201253829,
  'qwen3:72b': 47415724625,
  'deepseek-r1:70b': 42520397873,
  'rnogy/Nvidia_Llama-3_3-Nemotron-Super-49B-v1_5:q4_K_M': 30215578984,
};

export function fakeOllama(names: string[] = ['qwen3:8b'], overrides: Partial<Diagnostics['ollama']> = {}): Diagnostics['ollama'] {
  return {
    baseUrl: 'http://fake-ollama.local',
    reachable: true,
    loaded: [],
    installed: names.map((name) => ({ name, sizeBytes: REAL_MODEL_SIZES[name] ?? 4 * GIB, parameterSize: null, quantization: 'Q4_K_M', family: 'qwen3' })),
    ...overrides,
  };
}

/**
 * A VRAM pool that behaves like Ollama's: running a model loads it (evicting the others when it does not fit), and the
 * free-VRAM probe and `/api/ps` both read that state. A constant probe cannot show the resident-model defects.
 */
export class FakeGpu {
  private readonly resident = new Map<string, number>();

  constructor(
    public readonly totalBytes: number = REAL_VRAM_BYTES,
    private readonly sizeOf: (tag: string) => number = (tag) => REAL_MODEL_SIZES[tag] ?? 4 * GIB
  ) {}

  /** Puts a model in VRAM as Ollama would: unchanged when already resident, else evicting everything if it does not fit. */
  load(tag: string, sizeVramBytes: number = this.sizeOf(tag)): void {
    if (this.resident.has(tag)) return;
    if (sizeVramBytes > this.freeBytes()) this.resident.clear();
    this.resident.set(tag, sizeVramBytes);
  }

  unloadAll(): void {
    this.resident.clear();
  }

  freeBytes(): number {
    return Math.max(0, this.totalBytes - [...this.resident.values()].reduce((sum, bytes) => sum + bytes, 0));
  }

  loaded(): Array<{ name: string; sizeBytes: number; sizeVramBytes: number; expiresAt: string | null }> {
    return [...this.resident.entries()].map(([name, bytes]) => ({ name, sizeBytes: bytes, sizeVramBytes: bytes, expiresAt: null }));
  }

  residentTags(): string[] {
    return [...this.resident.keys()];
  }

  probeVram = async (): Promise<number | null> => this.freeBytes();
  probeVramTotal = async (): Promise<number | null> => this.totalBytes;
  /** `/api/tags` plus `/api/ps` from the same state. */
  fetchInventory = (names: string[]) => async () => fakeOllama(names, { loaded: this.loaded() });
}

export interface ProviderScript {
  /** Text chunks, in order. */
  chunks?: string[];
  /** Real usage reported once the stream finishes; omitted means the backend reports none. */
  usage?: Omit<GenerationUsage, 'model'> & { model?: string };
  /** Ollama's `done_reason`; `'length'` models a reply cut off at the output limit (usage then carries `truncated`). */
  doneReason?: 'stop' | 'length';
  /**
   * Reasoning emitted before the chunks, as `<think>...</think>` split into pieces of `splitAt` characters (default 5),
   * so the tags themselves arrive split across chunks. `unterminated: true` never closes the block.
   */
  think?: { text: string; splitAt?: number; unterminated?: boolean };
  /** Thrown before any chunk. */
  failImmediately?: Error;
  /** Thrown after this many chunks have been yielded. */
  failAfterChunks?: { count: number; error: Error };
  /** The stream does not start until this promise resolves. */
  gate?: Promise<void>;
}

export interface ProviderCall {
  model: string;
  prompt: string;
  options: GenerateStreamOptions;
}

/** Plays one script per generation call (the last repeats), and records every call it receives. */
export class ScriptedProvider implements LLMProvider {
  public readonly calls: ProviderCall[] = [];
  /** Set by a test to observe (and answer) model downloads. */
  public pullModel?: (name: string) => Promise<boolean>;
  private index = 0;

  /** Optional VRAM pool: starting a generation loads this model into it, as Ollama does. */
  public gpu?: FakeGpu;

  constructor(private scripts: ProviderScript[], private model = 'qwen3:8b') {}

  private next(): ProviderScript {
    const script = this.scripts[Math.min(this.index, this.scripts.length - 1)] ?? { chunks: [] };
    this.index += 1;
    return script;
  }

  getModel(): string {
    return this.model;
  }

  getBaseUrl(): string {
    return 'http://fake-ollama.local';
  }

  setModel(model: string): void {
    this.model = model;
  }

  async *generateStream(prompt: string, options: GenerateStreamOptions = {}): AsyncGenerator<string, void, undefined> {
    this.calls.push({ model: this.model, prompt, options });
    const script = this.next();
    this.gpu?.load(this.model);
    // Like the real provider, a request the caller aborts ends with an error instead of hanging behind its gate.
    const signal = options.signal;
    const aborted = new Promise<never>((_, reject) => {
      const fail = (): void => reject(new Error('This operation was aborted'));
      if (signal?.aborted) fail();
      else signal?.addEventListener('abort', fail, { once: true });
    });
    aborted.catch(() => undefined);
    await (script.gate ? Promise.race([script.gate, aborted]) : undefined);
    if (script.failImmediately) throw script.failImmediately;
    if (script.think) {
      const raw = `<think>${script.think.text}${script.think.unterminated ? '' : '</think>'}`;
      const size = Math.max(1, script.think.splitAt ?? 5);
      for (let at = 0; at < raw.length; at += size) yield raw.slice(at, at + size);
    }
    const chunks = script.chunks ?? [];
    for (let i = 0; i < chunks.length; i++) {
      if (script.failAfterChunks && script.failAfterChunks.count === i) throw script.failAfterChunks.error;
      yield chunks[i];
    }
    if (script.failAfterChunks && script.failAfterChunks.count >= chunks.length) throw script.failAfterChunks.error;
    const truncated = script.doneReason === 'length';
    if (script.usage || truncated) {
      options.onUsage?.({
        model: this.model,
        promptTokens: 0,
        completionTokens: 0,
        ...script.usage,
        ...(script.doneReason ? { doneReason: script.doneReason } : {}),
        ...(truncated ? { truncated: true } : {}),
      });
    }
  }

  async generate(prompt: string, options: GenerateStreamOptions = {}): Promise<string> {
    let text = '';
    for await (const chunk of this.generateStream(prompt, options)) text += chunk;
    return text;
  }

  async chat(): Promise<string> {
    throw new Error('ScriptedProvider.chat is not used');
  }

  async listModels(): Promise<string[]> {
    return [this.model];
  }
}

export function searchOk(urls: string[] = ['https://a.example/one', 'https://b.example/two']): SearchOutcome {
  return {
    source: 'searxng',
    results: urls.map((url, index) => ({ title: `Result ${index + 1}`, url, snippet: `snippet ${index + 1}`, engine: 'fake' })),
  };
}

export function searchNone(reason = 'SearXNG is unreachable (ECONNREFUSED) and the live web fallback is disabled.'): SearchOutcome {
  return { source: 'none', results: [], searxngError: 'ECONNREFUSED', unavailableReason: reason };
}

export function page(url: string, content: string, origin: 'page' | 'snippet' | 'unavailable' = 'page', title?: string): ExtractedContent {
  return { url, content, isUntrusted: true, extractedAt: '2026-01-01T00:00:00.000Z', origin, title, ...(origin === 'unavailable' ? { error: 'fetch failed' } : {}) };
}

export interface Harness {
  rt: JarvisRuntime;
  store: DocumentStore;
  dir: string;
  cleanup(): Promise<void>;
}

export type HarnessOptions = Omit<RuntimeOptions, 'store'> & {
  /** Free VRAM in bytes the probe reports; null (default) means unknown. A constant: see `gpu` for one that moves. */
  vramFreeBytes?: number | null;
  /** A stateful VRAM pool: the probe, its total and `/api/ps` read it. Pair it with `ScriptedProvider.gpu`. */
  gpu?: FakeGpu;
  /** Installed model tags the fake Ollama lists (default `qwen3:8b`). */
  installed?: string[];
  /** Host RAM the capability checker sees: free and total bytes. Defaults to the owner's 14 GiB free of 31.65 GB. */
  host?: { freeBytes: number; totalBytes: number };
};

/** A runtime on an in-memory store whose vault key, workspace and every external edge are local fakes. */
export async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-runtime-'));
  const store = new DocumentStore(':memory:');
  const { vramFreeBytes, gpu, installed, host, ...rest } = options;
  // The checker reads fixed host figures instead of the test box's `os.freemem()` (about 0.1 GB on macOS), with the
  // default floor of min(14 GiB, 25% of host RAM) the real workstation uses.
  const checker = new CapabilityChecker({ env: {}, unknownVramPolicy: 'allow' });
  const hostFigures = host ?? { freeBytes: REAL_HOST_FREE_BYTES, totalBytes: REAL_HOST_TOTAL_BYTES };
  checker.getFreeMemory = () => hostFigures.freeBytes;
  checker.getTotalMemory = () => hostFigures.totalBytes;
  const rt = await createRuntime({
    store,
    ownerUserId: OWNER,
    fetchInventory: gpu ? gpu.fetchInventory(installed ?? ['qwen3:8b']) : async () => fakeOllama(installed ?? ['qwen3:8b']),
    probeVram: gpu ? gpu.probeVram : async () => vramFreeBytes ?? null,
    probeVramTotal: gpu ? gpu.probeVramTotal : async () => null,
    getFreeMemory: () => 64 * GIB,
    capabilityChecker: checker,
    pacingDelayMs: 0,
    mcpServers: [],
    mobileTransport: { getStatus: async () => null, listNotifications: async () => [], listDevices: async () => [] },
    memoryOptions: { vault: { keyPath: path.join(dir, 'vault.key'), env: {} } },
    workspaceRoot: dir,
    ...rest,
  });
  let cleaned = false;
  return {
    rt,
    store,
    dir,
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      await rt.close();
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Collects turn events; `onEvent` can also act on them (for example abort after the first chunk). */
export function collectEvents(handler?: (event: TurnEvent) => void | Promise<void>): { events: TurnEvent[]; onEvent: (event: TurnEvent) => Promise<void> } {
  const events: TurnEvent[] = [];
  return {
    events,
    onEvent: async (event) => {
      events.push(event);
      await handler?.(event);
    },
  };
}

export function ofType<T extends TurnEvent['type']>(events: TurnEvent[], type: T): Array<Extract<TurnEvent, { type: T }>> {
  return events.filter((event): event is Extract<TurnEvent, { type: T }> => event.type === type);
}

/** Creates a session for the owner and returns its id. */
export async function newSession(rt: JarvisRuntime, title = 'Test'): Promise<string> {
  return (await rt.sessions.createSession(OWNER, title)).id;
}
