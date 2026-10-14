/**
 * Jarvis Local AI Agent: Function Calling Executor & Safety Gate
 * Authority: Section 5.3, Section 6.2, FEAT-005
 */

import crypto from 'node:crypto';
import type { ToolRegistry } from './registry.js';
import type { ActionGateway } from '../devagent/action-gateway.js';
import type { ToolCall, ToolResult } from './types.js';
import { logger } from '../utils/logger.js';

export interface ToolExecutorDeps {
  registry: ToolRegistry;
  gateway: ActionGateway;
}

export class ToolExecutor {
  private registry: ToolRegistry;
  private gateway: ActionGateway;

  constructor(deps: ToolExecutorDeps) {
    this.registry = deps.registry;
    this.gateway = deps.gateway;
  }

  /**
   * Executes a tool call through the Action Gateway safety tiers.
   */
  public async executeCall(call: ToolCall): Promise<ToolResult> {
    const tool = this.registry.getTool(call.name);

    if (!tool) {
      return {
        toolCallId: call.id,
        name: call.name,
        error: `Tool not found: '${call.name}'`,
      };
    }

    try {
      const result = await this.gateway.executeAction(
        {
          tier: tool.tier,
          actionType: 'SHELL_EXEC', // Mapped securely to Action Gateway verification
          targetId: tool.name,
          description: `Execute tool '${tool.name}'`,
          metadata: { args: call.args },
        },
        async () => {
          return tool.handler(call.args);
        }
      );

      return {
        toolCallId: call.id,
        name: call.name,
        result,
      };
    } catch (err: any) {
      logger.warn(`[ToolExecutor] Execution of '${call.name}' blocked or failed: ${err.message}`);
      return {
        toolCallId: call.id,
        name: call.name,
        error: err.message,
      };
    }
  }

  /**
   * Parses JSON tool calls emitted by local LLMs in their output text.
   */
  public parseModelToolCalls(text: string): ToolCall[] {
    const calls: ToolCall[] = [];

    // Pattern 1: Markdown JSON block with { "tool": "...", "args": { ... } }
    const jsonBlockRegex = /```(?:json)?\s*([\s\S]*?)\s*```/g;
    let match: RegExpExecArray | null;

    while ((match = jsonBlockRegex.exec(text)) !== null) {
      try {
        const parsed = JSON.parse(match[1]);
        if (parsed.tool && typeof parsed.tool === 'string') {
          calls.push({
            id: `call-${crypto.randomUUID()}`,
            name: parsed.tool,
            args: parsed.args ?? {},
          });
        } else if (Array.isArray(parsed.tool_calls)) {
          for (const tc of parsed.tool_calls) {
            if (tc.name) {
              calls.push({
                id: tc.id ?? `call-${crypto.randomUUID()}`,
                name: tc.name,
                args: tc.args ?? tc.parameters ?? {},
              });
            }
          }
        }
      } catch (err) {
        // Not a valid tool call JSON, ignore
      }
    }

    return calls;
  }
}
