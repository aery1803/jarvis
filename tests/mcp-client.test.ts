/**
 * Unit Tests: Model Context Protocol (MCP) Client
 * Authority: FEAT-005, Section 5.3 (MCP Integration)
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MCPClient, MockMCPServer } from '../src/mcp/client.js';
import { ToolRegistry } from '../src/tools/registry.js';

describe('MCPClient', () => {
  test('should connect to an MCP server and discover tools', async () => {
    const mockServer = new MockMCPServer([
      {
        name: 'mcp_git_status',
        description: 'Returns git status of workspace',
        inputSchema: { type: 'object', properties: {} },
        handler: async () => ({ branch: 'main', clean: true }),
      },
    ]);

    const client = new MCPClient({ server: mockServer });
    const tools = await client.listTools();

    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, 'mcp_git_status');
  });

  test('should execute an MCP tool and return structured output', async () => {
    const mockServer = new MockMCPServer([
      {
        name: 'mcp_read_file',
        description: 'Reads file content',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
        handler: async (args: { path: string }) => ({ content: `Data of ${args.path}` }),
      },
    ]);

    const client = new MCPClient({ server: mockServer });
    const result = await client.callTool('mcp_read_file', { path: 'README.md' });

    assert.equal(result.content, 'Data of README.md');
  });

  test('should bridge MCP tools seamlessly into Jarvis ToolRegistry', async () => {
    const mockServer = new MockMCPServer([
      {
        name: 'mcp_search_docs',
        description: 'Searches internal documentation',
        inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
        handler: async (args: { q: string }) => [`Match for ${args.q}`],
      },
    ]);

    const client = new MCPClient({ server: mockServer });
    const registry = new ToolRegistry();

    await client.bridgeToRegistry(registry);

    const tool = registry.getTool('mcp_search_docs');
    assert.ok(tool);
    assert.equal(tool.description, 'Searches internal documentation');

    const executionResult = await tool.handler({ q: 'Vulkan' });
    assert.deepEqual(executionResult, ['Match for Vulkan']);
  });
});
