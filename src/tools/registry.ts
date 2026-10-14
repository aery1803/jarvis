/**
 * Jarvis Local AI Agent: Schema-Checked Tool Registry
 * Authority: Section 5.3 (Tool calling), FEAT-005
 */

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import type { ToolDefinition, ModelFunctionSchema } from './types.js';
import { SearXNGClient } from '../services/searxng.js';
import { logger } from '../utils/logger.js';

export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();

  public registerTool(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      logger.warn(`[ToolRegistry] Overwriting existing tool: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
    logger.debug(`[ToolRegistry] Registered tool: ${tool.name} (Tier ${tool.tier})`);
  }

  public getTool(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  public getAllTools(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  public getSchemasForModel(): ModelFunctionSchema[] {
    return this.getAllTools().map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  /**
   * Registers baseline built-in tools (system_stats, web_search, file_read)
   */
  public registerBuiltinTools(): void {
    // 1. System Stats Tool (Tier 1: Read-only)
    this.registerTool({
      name: 'system_stats',
      description: 'Returns host memory headroom and hardware specifications.',
      tier: 1,
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
        };
      },
    });

    // 2. Web Search Tool (Tier 1: Read-only)
    const searchClient = new SearXNGClient({ enableFallback: true });
    this.registerTool({
      name: 'web_search',
      description: 'Performs local privacy-first metasearch via SearXNG.',
      tier: 1,
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          maxResults: { type: 'number', description: 'Maximum results to return (default 3)' },
        },
        required: ['query'],
      },
      handler: async (args: { query: string; maxResults?: number }) => {
        return searchClient.search(args.query, { maxResults: args.maxResults ?? 3 });
      },
    });

    // 3. File Read Tool (Tier 1: Read-only within workspace)
    this.registerTool({
      name: 'file_read',
      description: 'Reads the contents of a local file within the workspace.',
      tier: 1,
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Relative path to file' },
        },
        required: ['filePath'],
      },
      handler: async (args: { filePath: string }) => {
        const target = path.resolve(process.cwd(), args.filePath);
        // Sandboxing: ensure within current working directory
        if (!target.startsWith(process.cwd())) {
          throw new Error('Access denied: Cannot read files outside workspace.');
        }
        if (!fs.existsSync(target)) {
          throw new Error(`File not found: ${args.filePath}`);
        }
        return fs.readFileSync(target, 'utf-8');
      },
    });
  }
}
