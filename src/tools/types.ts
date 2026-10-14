/**
 * Jarvis Local AI Agent: Tool Definitions and Schemas
 * Authority: Section 5.3 (Tool calling), FEAT-005
 */

import type { GatewayTier } from '../devagent/types.js';

export interface ToolParameterProperty {
  type?: string | string[];
  description?: string;
  items?: ToolParameterProperty;
  enum?: Array<string | number | boolean>;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  properties?: Record<string, ToolParameterProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolParameters {
  type: 'object';
  properties: Record<string, ToolParameterProperty>;
  required?: string[];
  /** Unknown properties are rejected unless this is explicitly true. */
  additionalProperties?: boolean;
}

export type ToolSource = 'builtin' | 'mcp' | 'runtime';

export interface ToolHandlerContext {
  /** Aborted when the per-tool timeout elapses; handlers that can stop early should honour it. */
  signal: AbortSignal;
}

export interface ToolDefinition {
  name: string;
  description: string;
  tier: GatewayTier;
  parameters: ToolParameters;
  handler: (args: any, context?: ToolHandlerContext) => Promise<any>;
  /** Who registered it; a tool can only be replaced by the same source. Defaults to 'runtime'. */
  source?: ToolSource;
  timeoutMs?: number;
  maxResultChars?: number;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, any>;
}

export type ToolErrorCode =
  | 'NOT_FOUND'
  | 'INVALID_ARGUMENTS'
  | 'DENIED'
  | 'FORBIDDEN'
  | 'KILLED'
  | 'TIMEOUT'
  | 'FAILED';

export interface ToolResult {
  toolCallId: string;
  name: string;
  result?: any;
  error?: string;
  errorCode?: ToolErrorCode;
  /** Tool output is always data, never instructions: fence it before it reaches a prompt (`fenceToolResult`). */
  untrusted: true;
  truncated?: boolean;
}

export interface ModelFunctionSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: ToolParameters;
  };
}
