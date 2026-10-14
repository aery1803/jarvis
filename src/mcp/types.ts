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
    additionalProperties?: boolean;
  };
}

export interface MCPServerConnection {
  listTools(): Promise<MCPTool[]>;
  callTool(name: string, args: any): Promise<any>;
  close?(): Promise<void>;
}

/** One entry of the owner's `JARVIS_MCP_SERVERS` setting. Being listed there is the approval to run it. */
export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** Persists the approved hash of each tool's description + schema (tool pinning, master-context 5.4). */
export interface ApprovalStore {
  get(key: string): string | undefined | Promise<string | undefined>;
  set(key: string, hash: string): void | Promise<void>;
}
