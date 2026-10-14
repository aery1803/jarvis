/**
 * Unit Tests: Tool Executor & Action Gateway Enforcement
 * Authority: FEAT-005, Section 6.2 (Action Gateway Tiers)
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ToolExecutor } from '../src/tools/executor.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { ActionGateway } from '../src/devagent/action-gateway.js';
import { OwnActionRegistry } from '../src/devagent/action-registry.js';

describe('ToolExecutor', () => {
  let registry: ToolRegistry;
  let ownActionRegistry: OwnActionRegistry;
  let gateway: ActionGateway;
  let executor: ToolExecutor;

  beforeEach(() => {
    registry = new ToolRegistry();
    ownActionRegistry = new OwnActionRegistry(':memory:');
    gateway = new ActionGateway(ownActionRegistry, { minFreeMemoryBytes: 1024 * 1024 * 1024 });
    executor = new ToolExecutor({ registry, gateway });
  });

  test('should execute a registered Tier 1 tool successfully', async () => {
    registry.registerTool({
      name: 'sum',
      description: 'Adds two numbers',
      tier: 1,
      parameters: {
        type: 'object',
        properties: { a: { type: 'number' }, b: { type: 'number' } },
        required: ['a', 'b'],
      },
      handler: async (args: { a: number; b: number }) => args.a + args.b,
    });

    const result = await executor.executeCall({
      id: 'call-1',
      name: 'sum',
      args: { a: 15, b: 25 },
    });

    assert.equal(result.name, 'sum');
    assert.equal(result.result, 40);
    assert.equal(result.error, undefined);
  });

  test('should parse tool calls embedded in model output text', () => {
    const rawModelOutput = `I will calculate the sum for you.
\`\`\`json
{
  "tool": "sum",
  "args": { "a": 10, "b": 20 }
}
\`\`\``;

    const parsedCalls = executor.parseModelToolCalls(rawModelOutput);
    assert.equal(parsedCalls.length, 1);
    assert.equal(parsedCalls[0].name, 'sum');
    assert.equal(parsedCalls[0].args.a, 10);
  });

  test('should block Tier 3 tool execution through Action Gateway', async () => {
    registry.registerTool({
      name: 'delete_database',
      description: 'Deletes system database',
      tier: 3, // Forbidden to autonomous execution
      parameters: { type: 'object', properties: {} },
      handler: async () => 'deleted',
    });

    const result = await executor.executeCall({
      id: 'call-danger',
      name: 'delete_database',
      args: {},
    });

    assert.ok(result.error);
    assert.match(result.error, /Tier 3 action forbidden/i);
  });
});
