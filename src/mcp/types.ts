/**
 * Jarvis Local AI Agent: Model Context Protocol (MCP) Type Definitions
 * Authority: Section 5.3, Section 18.1, OpenClaw Standards
 */

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, any>;
    required?: string[];
  };
}

export interface MCPServerConnection {
  listTools(): Promise<MCPTool[]>;
  callTool(name: string, args: any): Promise<any>;
}
