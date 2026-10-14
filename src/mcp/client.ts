/**
 * Jarvis Local AI Agent: Model Context Protocol (MCP) Client
 * Authority: Section 5.3, OpenClaw Connectors
 *
 * Connects to external or local MCP servers, discovers their exposed tools,
 * and bridges them into Jarvis's central ToolRegistry.
 */

import type { MCPTool, MCPServerConnection } from './types.js';
import type { ToolRegistry } from '../tools/registry.js';
import { logger } from '../utils/logger.js';

export class MockMCPServer implements MCPServerConnection {
  private tools: Array<MCPTool & { handler: (args: any) => Promise<any> }>;

  constructor(tools: Array<MCPTool & { handler: (args: any) => Promise<any> }> = []) {
    this.tools = tools;
  }

  public async listTools(): Promise<MCPTool[]> {
    return this.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  public async callTool(name: string, args: any): Promise<any> {
    const found = this.tools.find((t) => t.name === name);
    if (!found) {
      throw new Error(`MCP Tool not found: ${name}`);
    }
    return found.handler(args);
  }
}

export interface MCPClientOptions {
  server: MCPServerConnection;
}

export class MCPClient {
  private server: MCPServerConnection;

  constructor(options: MCPClientOptions) {
    this.server = options.server;
  }

  public async listTools(): Promise<MCPTool[]> {
    return this.server.listTools();
  }

  public async callTool(name: string, args: any): Promise<any> {
    return this.server.callTool(name, args);
  }

  /**
   * Discovers all tools on the MCP server and registers them into Jarvis's ToolRegistry.
   */
  public async bridgeToRegistry(registry: ToolRegistry): Promise<void> {
    const mcpTools = await this.listTools();
    logger.info(`[MCPClient] Bridging ${mcpTools.length} MCP tools into ToolRegistry...`);

    for (const tool of mcpTools) {
      registry.registerTool({
        name: tool.name,
        description: tool.description,
        tier: 1, // Read-only autonomous tool invocation by default
        parameters: {
          type: 'object',
          properties: tool.inputSchema.properties ?? {},
          required: tool.inputSchema.required ?? [],
        },
        handler: async (args: any) => {
          return this.callTool(tool.name, args);
        },
      });
    }
  }
}
