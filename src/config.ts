/**
 * Jarvis Local AI Agent: Configuration Module
 * Authority: jarvis-master-context.md Section 17.10, 18.1, 18.2
 */

import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'node:path';
import { loadExternalSettings } from './security/credentials.js';
import { parseAllowedIps } from './web/access.js';
import { parseThinkingMode, type ThinkingMode } from './services/thinking-control.js';

dotenv.config();

const BYTES_PER_GIB = 1024 * 1024 * 1024;

export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

const ConfigSchema = z.object({
  repoOwner: z.string().default('aery1803'),
  repoName: z.string().default('jarvis'),
  projectNumber: z.number().int().default(2),
  projectId: z.string().default('PVT_kwHOBShJEs4Bm-d2'),
  pollingIntervalMs: z.number().int().default(45_000),
  pacingDelayMs: z.number().int().default(500),
  minFreeMemoryBytes: z.number().int().default(4 * BYTES_PER_GIB),
  /** Same threshold as `minFreeMemoryBytes`, in GiB, for callers that budget in whole numbers. */
  minHostFreeGb: z.number().default(4),
  databasePath: z.string().default(path.join(process.cwd(), 'data', 'devagent.db')),
  logLevel: z.enum(['DEBUG', 'INFO', 'WARN', 'ERROR']).default('INFO'),
  ollamaBaseUrl: z.string().default('http://127.0.0.1:11434'),
  llamaServerBaseUrl: z.string().default('http://127.0.0.1:8080'),
  searxngBaseUrl: z.string().default('http://127.0.0.1:8080'),
  /** Resident baseline model; every default or fallback model name in the runtime comes from here. */
  defaultModel: z.string().min(1).default('qwen3:8b'),
  /** Token budget handed to the context builder for a chat turn. */
  contextTokens: z.number().int().min(1).default(16_384),
  /** Direct DuckDuckGo search when SearXNG is unreachable. On by default; `JARVIS_SEARCH_LIVE_FALLBACK=0` turns it off. */
  searchLiveFallback: z.boolean().default(true),
  /** `off` sends `think:false` to the qwen3 family, `auto` leaves each model's default, `on` always thinks. */
  thinkingMode: z.enum(['off', 'auto', 'on']).default('off'),
  /** Tier 2: pulling a missing model downloads gigabytes, so it is never implicit. */
  allowModelPull: z.boolean().default(false),
  mcpServers: z.array(z.any()).default([]),
  webHost: z.string().default('127.0.0.1'),
  webAllowedIps: z.array(z.string()).default([]),
  /** Extra browser origins (for example `http://jarvis.lan:3000`) allowed to make state-changing requests. */
  webAllowedOrigins: z.array(z.string()).default([]),
});

export type JarvisConfig = Omit<z.infer<typeof ConfigSchema>, 'mcpServers'> & { mcpServers: McpServerConfig[] };

/** Environment variables win over `%USERPROFILE%\.jarvis\settings.env`; an empty value counts as unset. */
export function readSetting(key: string): string | undefined {
  const fromEnv = process.env[key];
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv.trim();
  const fromFile = loadExternalSettings()[key];
  return fromFile !== undefined && fromFile.trim() !== '' ? fromFile.trim() : undefined;
}

function numberSetting(key: string, fallback: number, options: { integer?: boolean; min?: number } = {}): number {
  const raw = readSetting(key);
  if (raw === undefined) return fallback;
  const value = options.integer ? Number.parseInt(raw, 10) : Number.parseFloat(raw);
  if (!Number.isFinite(value) || (options.min !== undefined && value < options.min)) {
    process.emitWarning(`${key}="${raw}" is not a valid number${options.min !== undefined ? ` >= ${options.min}` : ''}; using ${fallback}.`);
    return fallback;
  }
  return value;
}

function booleanSetting(key: string, fallback: boolean): boolean {
  const raw = readSetting(key)?.toLowerCase();
  if (raw === undefined) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  process.emitWarning(`${key}="${raw}" is not a boolean; using ${fallback}.`);
  return fallback;
}

function resolveThinkingMode(): ThinkingMode {
  const raw = readSetting('JARVIS_THINKING');
  if (raw === undefined) return 'off';
  const mode = parseThinkingMode(raw);
  if (mode) return mode;
  process.emitWarning(`JARVIS_THINKING="${raw}" is not off, auto or on; using off.`);
  return 'off';
}

function listSetting(key: string): string[] {
  return (readSetting(key) ?? '')
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function resolveMinHostFreeGb(): number {
  const gbKey = ['JARVIS_MIN_HOST_FREE_GB', 'JARVIS_MIN_FREE_RAM_GB'].find((key) => readSetting(key) !== undefined);
  if (gbKey) return numberSetting(gbKey, 4, { min: 0 });
  return numberSetting('JARVIS_MIN_FREE_RAM', 4 * BYTES_PER_GIB, { integer: true, min: 0 }) / BYTES_PER_GIB;
}

function parseMcpServer(entry: unknown, index: number): McpServerConfig {
  const candidate = entry as Partial<McpServerConfig> | null;
  if (!candidate || typeof candidate.name !== 'string' || !candidate.name || typeof candidate.command !== 'string' || !candidate.command) {
    throw new Error(`entry ${index} needs a non-empty "name" and "command"`);
  }
  const args = candidate.args ?? [];
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    throw new Error(`entry ${index} "args" must be an array of strings`);
  }
  const env = candidate.env;
  if (env !== undefined && (typeof env !== 'object' || env === null || Object.values(env).some((value) => typeof value !== 'string'))) {
    throw new Error(`entry ${index} "env" must map names to strings`);
  }
  return { name: candidate.name, command: candidate.command, args, ...(env ? { env } : {}) };
}

/** `JARVIS_MCP_SERVERS` is a JSON array of `{ name, command, args?, env? }`; a malformed value disables MCP rather than the process. */
function resolveMcpServers(): McpServerConfig[] {
  const raw = readSetting('JARVIS_MCP_SERVERS');
  if (raw === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('expected a JSON array');
    return parsed.map(parseMcpServer);
  } catch (err: unknown) {
    process.emitWarning(`JARVIS_MCP_SERVERS ignored: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

export function loadConfig(overrides: Partial<JarvisConfig> = {}): JarvisConfig {
  const minHostFreeGb = resolveMinHostFreeGb();
  const logLevel = (readSetting('JARVIS_LOG_LEVEL') ?? 'INFO').toUpperCase();

  return ConfigSchema.parse({
    repoOwner: readSetting('JARVIS_REPO_OWNER') ?? 'aery1803',
    repoName: readSetting('JARVIS_REPO_NAME') ?? 'jarvis',
    projectNumber: numberSetting('JARVIS_PROJECT_NUMBER', 2, { integer: true }),
    projectId: readSetting('JARVIS_PROJECT_ID') ?? 'PVT_kwHOBShJEs4Bm-d2',
    pollingIntervalMs: numberSetting('JARVIS_POLL_INTERVAL', 45_000, { integer: true, min: 1 }),
    pacingDelayMs: numberSetting('JARVIS_PACING_MS', 500, { integer: true, min: 0 }),
    minFreeMemoryBytes: Math.round(minHostFreeGb * BYTES_PER_GIB),
    minHostFreeGb,
    databasePath: readSetting('JARVIS_DB_PATH') ?? path.join(process.cwd(), 'data', 'devagent.db'),
    logLevel: ['DEBUG', 'INFO', 'WARN', 'ERROR'].includes(logLevel) ? logLevel : 'INFO',
    ollamaBaseUrl: readSetting('JARVIS_OLLAMA_URL') ?? 'http://127.0.0.1:11434',
    llamaServerBaseUrl: readSetting('JARVIS_LLAMA_URL') ?? 'http://127.0.0.1:8080',
    searxngBaseUrl: readSetting('JARVIS_SEARXNG_URL') ?? 'http://127.0.0.1:8080',
    defaultModel: readSetting('JARVIS_DEFAULT_MODEL') ?? 'qwen3:8b',
    contextTokens: numberSetting('JARVIS_CONTEXT_TOKENS', 16_384, { integer: true, min: 1 }),
    searchLiveFallback: booleanSetting('JARVIS_SEARCH_LIVE_FALLBACK', true),
    thinkingMode: resolveThinkingMode(),
    allowModelPull: booleanSetting('JARVIS_ALLOW_MODEL_PULL', false),
    mcpServers: resolveMcpServers(),
    webHost: readSetting('JARVIS_WEB_HOST') ?? '127.0.0.1',
    webAllowedIps: parseAllowedIps(readSetting('JARVIS_WEB_ALLOWED_IPS')),
    webAllowedOrigins: listSetting('JARVIS_WEB_ALLOWED_ORIGINS'),
    ...overrides,
  });
}

export const config = loadConfig();
