/**
 * Jarvis Local AI Agent: Schema-Checked Tool Registry
 * Authority: Section 5.3 (Tool calling), FEAT-005
 */

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import type { ToolDefinition, ModelFunctionSchema, ToolSource } from './types.js';
import { SearXNGClient } from '../services/searxng.js';
import type { SearchOutcome } from '../services/searxng.js';
import { logger } from '../utils/logger.js';

const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,64}$/;
const MAX_FILE_READ_BYTES = 200 * 1024;
const SECRET_EXTENSIONS = ['.db', '.sqlite', '.sqlite3', '.db-wal', '.db-shm', '.db-journal', '.pem', '.key', '.pfx', '.p12', '.crt', '.keystore'];
const SECRET_BASENAMES = new Set(['.env', 'settings.env', 'credentials.json', '.npmrc', 'id_rsa', 'id_ed25519', '.netrc']);
const SECRET_DIRECTORIES = new Set(['.git', '.ssh']);

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'what', 'whats', 'how', 'can', 'you', 'please', 'tell', 'show', 'give', 'about', 'that', 'this',
  'from', 'have', 'are', 'was', 'were', 'will', 'would', 'could', 'should', 'does', 'did', 'was', 'any', 'all', 'get', 'let',
]);

function tokenize(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
}

function tokensMatch(a: string, b: string): boolean {
  if (a === b) {
    return true;
  }
  return Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a));
}

export interface PathCheck {
  ok: boolean;
  path?: string;
  reason?: string;
}

function isSecretPath(relativePath: string): boolean {
  const segments = relativePath.split(/[\\/]+/).filter(Boolean).map((s) => s.toLowerCase());
  if (segments.length === 0) {
    return false;
  }
  const base = segments[segments.length - 1];
  return (
    segments[0] === 'data' ||
    segments.some((s) => SECRET_DIRECTORIES.has(s)) ||
    SECRET_BASENAMES.has(base) ||
    base.startsWith('.env.') ||
    SECRET_EXTENSIONS.some((ext) => base.endsWith(ext))
  );
}

/**
 * Resolves `requested` inside `root` or explains why not. Uses `path.relative` rather than a string prefix test,
 * which would accept the sibling `/repo-evil` for root `/repo`, and re-checks the `fs.realpathSync` target so a
 * symlink cannot lead out of the workspace or into a secret file.
 */
export function resolveWorkspaceFile(root: string, requested: unknown): PathCheck {
  if (typeof requested !== 'string' || requested.trim() === '' || requested.includes('\0')) {
    return { ok: false, reason: 'A relative file path is required.' };
  }
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, requested);
  const inside = (base: string, candidate: string): string | null => {
    const rel = path.relative(base, candidate);
    return rel === '' || rel.startsWith('..') || path.isAbsolute(rel) ? null : rel;
  };

  const rel = inside(resolvedRoot, target);
  if (rel === null) {
    return { ok: false, reason: 'Access denied: Cannot read files outside workspace.' };
  }
  if (isSecretPath(rel)) {
    return { ok: false, reason: 'Access denied: that file may contain secrets and is never readable by tools.' };
  }
  if (!fs.existsSync(target)) {
    return { ok: false, reason: `File not found: ${requested}` };
  }

  const realRoot = fs.realpathSync(resolvedRoot);
  const realTarget = fs.realpathSync(target);
  const realRel = inside(realRoot, realTarget);
  if (realRel === null) {
    return { ok: false, reason: 'Access denied: Cannot read files outside workspace.' };
  }
  if (isSecretPath(realRel)) {
    return { ok: false, reason: 'Access denied: that file may contain secrets and is never readable by tools.' };
  }
  return { ok: true, path: realTarget };
}

export interface BuiltinToolOptions {
  searchClient?: { searchDetailed(query: string, options?: { maxResults?: number }): Promise<SearchOutcome> };
  /** Defaults to `process.cwd()` at call time. */
  workspaceRoot?: string;
}

export interface BulkRegistration {
  registered: string[];
  rejected: Array<{ name: string; reason: string }>;
}

export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();

  public registerTool(tool: ToolDefinition): void {
    if (!TOOL_NAME.test(tool.name)) {
      throw new Error(`Invalid tool name '${tool.name}': use 1-64 letters, digits, '_', '.', ':' or '-'.`);
    }
    const existing = this.tools.get(tool.name);
    if (existing) {
      if ((existing.source ?? 'runtime') !== (tool.source ?? 'runtime')) {
        throw new Error(`Refusing to replace ${existing.source ?? 'runtime'} tool '${tool.name}' with a ${tool.source ?? 'runtime'} tool.`);
      }
      logger.warn(`[ToolRegistry] Overwriting existing tool: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
    logger.debug(`[ToolRegistry] Registered tool: ${tool.name} (Tier ${tool.tier})`);
  }

  /** Registers many tools; a bad one is reported instead of aborting the rest. */
  public registerTools(tools: ToolDefinition[]): BulkRegistration {
    const outcome: BulkRegistration = { registered: [], rejected: [] };
    for (const tool of tools) {
      try {
        this.registerTool(tool);
        outcome.registered.push(tool.name);
      } catch (err) {
        outcome.rejected.push({ name: tool.name, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    return outcome;
  }

  public unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  public unregisterBySource(source: ToolSource): number {
    let removed = 0;
    for (const [name, tool] of Array.from(this.tools.entries())) {
      if ((tool.source ?? 'runtime') === source && this.tools.delete(name)) {
        removed++;
      }
    }
    return removed;
  }

  public getTool(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  public getAllTools(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  public getSchemasForModel(tools: ToolDefinition[] = this.getAllTools()): ModelFunctionSchema[] {
    return tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  /**
   * The tools most relevant to `prompt` by keyword overlap, best first (master-context 5.3: a small model must
   * never be shown dozens of tools). Returns an empty list when nothing overlaps.
   */
  public selectToolsForPrompt(prompt: string, max = 10): ToolDefinition[] {
    const promptTokens = Array.from(new Set(tokenize(prompt)));
    if (promptTokens.length === 0 || max <= 0) {
      return [];
    }
    const scored = this.getAllTools().map((tool) => {
      const nameTokens = tokenize(tool.name);
      const descriptionTokens = tokenize(tool.description);
      const parameterTokens = Object.keys(tool.parameters.properties ?? {}).flatMap(tokenize);
      let score = 0;
      for (const token of promptTokens) {
        if (nameTokens.some((t) => tokensMatch(t, token))) score += 3;
        if (descriptionTokens.some((t) => tokensMatch(t, token))) score += 1;
        if (parameterTokens.some((t) => tokensMatch(t, token))) score += 1;
      }
      return { tool, score };
    });
    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
      .slice(0, max)
      .map((s) => s.tool);
  }

  /**
   * Registers baseline built-in tools (system_stats, web_search, file_read)
   */
  public registerBuiltinTools(options: BuiltinToolOptions = {}): void {
    // 1. System Stats Tool (Tier 1: Read-only)
    this.registerTool({
      name: 'system_stats',
      description: 'Returns host memory headroom and hardware specifications.',
      tier: 1,
      source: 'builtin',
      parameters: {
        type: 'object',
        properties: {},
      },
      handler: async () => {
        const freeGb = Number((os.freemem() / (1024 * 1024 * 1024)).toFixed(2));
        const totalGb = Number((os.totalmem() / (1024 * 1024 * 1024)).toFixed(2));
        return {
          os: `${os.type()} ${os.release()} (${os.arch()})`,
          freeMemoryGb: freeGb,
          totalMemoryGb: totalGb,
          headroomStatus: freeGb >= 14 ? 'HEALTHY' : 'WARNING_LOW_HEADROOM',
          note: 'Host RAM only; the GPU/Vulkan memory pool is not visible to Node.',
        };
      },
    });

    // 2. Web Search Tool (Tier 1: Read-only)
    const searchClient = options.searchClient ?? new SearXNGClient({ enableFallback: true });
    this.registerTool({
      name: 'web_search',
      description: 'Performs local privacy-first metasearch via SearXNG.',
      tier: 1,
      source: 'builtin',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query', minLength: 1, maxLength: 300 },
          maxResults: { type: 'integer', description: 'Maximum results to return (default 3)', minimum: 1, maximum: 10 },
        },
        required: ['query'],
      },
      handler: async (args: { query: string; maxResults?: number }) => {
        const outcome = await searchClient.searchDetailed(args.query, { maxResults: args.maxResults ?? 3 });
        return {
          source: outcome.source,
          results: outcome.results,
          ...(outcome.unavailableReason ? { unavailable: outcome.unavailableReason } : {}),
        };
      },
    });

    // 3. File Read Tool (Tier 1: Read-only within workspace)
    this.registerTool({
      name: 'file_read',
      description: 'Reads the contents of a local text file within the workspace.',
      tier: 1,
      source: 'builtin',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Relative path to file', minLength: 1, maxLength: 500 },
        },
        required: ['filePath'],
      },
      handler: async (args: { filePath: string }) => {
        const check = resolveWorkspaceFile(options.workspaceRoot ?? process.cwd(), args.filePath);
        if (!check.ok || !check.path) {
          throw new Error(check.reason ?? 'Access denied.');
        }
        const stat = fs.statSync(check.path);
        if (!stat.isFile()) {
          throw new Error(`Not a regular file: ${args.filePath}`);
        }
        const fd = fs.openSync(check.path, 'r');
        try {
          const buffer = Buffer.alloc(Math.min(stat.size, MAX_FILE_READ_BYTES));
          const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
          const slice = buffer.subarray(0, bytesRead);
          if (slice.subarray(0, 8192).includes(0)) {
            throw new Error(`Refusing to read a binary file: ${args.filePath}`);
          }
          const text = slice.toString('utf-8');
          return stat.size > MAX_FILE_READ_BYTES ? `${text}\n[truncated: file is ${stat.size} bytes]` : text;
        } finally {
          fs.closeSync(fd);
        }
      },
    });
  }
}
