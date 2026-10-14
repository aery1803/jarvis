/**
 * Jarvis Local AI Agent: Configuration Module
 * Authority: jarvis-master-context.md Section 17.10, 18.1, 18.2
 */

import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'node:path';
import os from 'node:os';
import { loadExternalSettings } from './security/credentials.js';
import { parseAllowedIps } from './web/access.js';

dotenv.config();

const ConfigSchema = z.object({
  repoOwner: z.string().default('aery1803'),
  repoName: z.string().default('jarvis'),
  projectNumber: z.number().int().default(2),
  projectId: z.string().default('PVT_kwHOBShJEs4Bm-d2'),
  pollingIntervalMs: z.number().int().default(45_000),
  pacingDelayMs: z.number().int().default(500),
  minFreeMemoryBytes: z.number().int().default(4 * 1024 * 1024 * 1024), // 4 GB default safe baseline for devagent actions
  databasePath: z.string().default(path.join(process.cwd(), 'data', 'devagent.db')),
  logLevel: z.enum(['DEBUG', 'INFO', 'WARN', 'ERROR']).default('INFO'),
  ollamaBaseUrl: z.string().default('http://127.0.0.1:11434'),
  llamaServerBaseUrl: z.string().default('http://127.0.0.1:8080'),
  webHost: z.string().default('127.0.0.1'),
  webAllowedIps: z.array(z.string()).default([]),
});

/** Environment variables win over `%USERPROFILE%\.jarvis\settings.env`. */
function setting(key: string): string | undefined {
  return process.env[key] ?? loadExternalSettings()[key];
}

export type JarvisConfig = z.infer<typeof ConfigSchema>;

function resolveMinFreeMemory(): number {
  if (process.env.JARVIS_MIN_FREE_RAM_GB) {
    return Math.round(Number.parseFloat(process.env.JARVIS_MIN_FREE_RAM_GB) * 1024 * 1024 * 1024);
  }
  if (process.env.JARVIS_MIN_FREE_RAM) {
    return Number.parseInt(process.env.JARVIS_MIN_FREE_RAM, 10);
  }
  return 4 * 1024 * 1024 * 1024;
}

export function loadConfig(overrides: Partial<JarvisConfig> = {}): JarvisConfig {
  const parsed = ConfigSchema.parse({
    repoOwner: process.env.JARVIS_REPO_OWNER ?? 'aery1803',
    repoName: process.env.JARVIS_REPO_NAME ?? 'jarvis',
    projectNumber: process.env.JARVIS_PROJECT_NUMBER ? Number.parseInt(process.env.JARVIS_PROJECT_NUMBER, 10) : 2,
    projectId: process.env.JARVIS_PROJECT_ID ?? 'PVT_kwHOBShJEs4Bm-d2',
    pollingIntervalMs: process.env.JARVIS_POLL_INTERVAL ? Number.parseInt(process.env.JARVIS_POLL_INTERVAL, 10) : 45_000,
    pacingDelayMs: process.env.JARVIS_PACING_MS ? Number.parseInt(process.env.JARVIS_PACING_MS, 10) : 500,
    minFreeMemoryBytes: resolveMinFreeMemory(),
    databasePath: process.env.JARVIS_DB_PATH ?? path.join(process.cwd(), 'data', 'devagent.db'),
    logLevel: (process.env.JARVIS_LOG_LEVEL as any) ?? 'INFO',
    ollamaBaseUrl: process.env.JARVIS_OLLAMA_URL ?? 'http://127.0.0.1:11434',
    llamaServerBaseUrl: process.env.JARVIS_LLAMA_URL ?? 'http://127.0.0.1:8080',
    webHost: setting('JARVIS_WEB_HOST') ?? '127.0.0.1',
    webAllowedIps: parseAllowedIps(setting('JARVIS_WEB_ALLOWED_IPS')),
    ...overrides,
  });

  return parsed;
}

export const config = loadConfig();
