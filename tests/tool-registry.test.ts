/**
 * Unit Tests: Tool Registry
 * Authority: CODING_RULES.md (TDD), FEAT-005 Specification
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from '../src/tools/registry.js';
import type { ToolDefinition } from '../src/tools/types.js';

describe('ToolRegistry', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  test('should register and retrieve a tool definition', () => {
    const echoTool: ToolDefinition = {
      name: 'echo',
      description: 'Echoes back the input text',
      tier: 1,
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to echo' },
        },
        required: ['text'],
      },
      handler: async (args: { text: string }) => args.text,
    };

    registry.registerTool(echoTool);
    const retrieved = registry.getTool('echo');

    assert.ok(retrieved);
    assert.equal(retrieved.name, 'echo');
    assert.equal(retrieved.tier, 1);
  });

  test('should format tool schemas for LLM provider function calling', () => {
    registry.registerTool({
      name: 'get_weather',
      description: 'Get weather for a city',
      tier: 1,
      parameters: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
      handler: async () => ({ temp: '22C' }),
    });

    const schemas = registry.getSchemasForModel();
    assert.equal(schemas.length, 1);
    assert.equal(schemas[0].type, 'function');
    assert.equal(schemas[0].function.name, 'get_weather');
  });

  test('should have built-in system_stats tool registered by default', async () => {
    registry.registerBuiltinTools();
    const statsTool = registry.getTool('system_stats');
    assert.ok(statsTool);

    const stats = await statsTool.handler({});
    assert.ok(stats.freeMemoryGb > 0);
    assert.ok(stats.totalMemoryGb > 0);
  });
});
