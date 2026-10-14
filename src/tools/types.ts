/**
 * Jarvis Local AI Agent: Tool Definitions and Schemas
 * Authority: Section 5.3 (Tool calling), FEAT-005
 */

import type { GatewayTier } from '../devagent/types.js';

export interface ToolDefinition {
  name: string;
  description: string;
  tier: GatewayTier;
  parameters: {
    type: 'object';
    properties: Record<string, {
      type: string;
      description?: string;
      items?: any;
      enum?: string[];
    }>;
    required?: string[];
  };
  handler: (args: any) => Promise<any>;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, any>;
}

export interface ToolResult {
  toolCallId: string;
  name: string;
  result?: any;
  error?: string;
}

export interface ModelFunctionSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: any;
  };
}
