/**
 * Unit Tests: Tool Registry
 * Authority: CODING_RULES.md (TDD), FEAT-005 Specification
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from '../src/tools/registry.js';
import type { ToolDefinition } from '../src/tools/types.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

  describe('file_read sandbox', () => {
    let root: string;
    let sibling: string;
    let read: (filePath: string) => Promise<string>;

    beforeEach(() => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-fr-'));
      root = path.join(base, 'repo');
      sibling = path.join(base, 'repo-evil');
      fs.mkdirSync(path.join(root, 'data'), { recursive: true });
      fs.mkdirSync(path.join(root, '.git'));
      fs.mkdirSync(path.join(root, 'src'));
      fs.mkdirSync(sibling);
      fs.writeFileSync(path.join(root, 'src', 'ok.txt'), 'hello');
      fs.writeFileSync(path.join(sibling, 'loot.txt'), 'stolen');
      for (const f of ['.env', '.env.local', 'settings.env', 'a.db', 'k.pem', 'k.key', 'credentials.json', path.join('data', 'x.txt'), path.join('.git', 'config')]) {
        fs.writeFileSync(path.join(root, f), 'SECRET');
      }
      fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([1, 0, 2]));
      registry.registerBuiltinTools({ workspaceRoot: root, searchClient: { searchDetailed: async () => ({ results: [], source: 'none' }) } });
      read = (filePath) => registry.getTool('file_read')!.handler({ filePath });
    });

    afterEach(() => fs.rmSync(path.dirname(root), { recursive: true, force: true }));

    test('reads a normal workspace file', async () => {
      assert.equal(await read('src/ok.txt'), 'hello');
    });

    test('rejects a sibling directory that shares the workspace prefix', async () => {
      await assert.rejects(read('../repo-evil/loot.txt'), /outside workspace/);
      await assert.rejects(read(path.join(sibling, 'loot.txt')), /outside workspace/);
    });

    test('rejects traversal, absolute paths, empty and NUL paths', async () => {
      await assert.rejects(read('../../etc/passwd'), /outside workspace/);
      await assert.rejects(read(os.tmpdir()), /outside workspace/);
      await assert.rejects(read(''), /path is required/);
      await assert.rejects(read('a\0b'), /path is required/);
    });

    test('refuses secret files, data/ and .git/', async () => {
      for (const f of ['.env', '.env.local', 'settings.env', 'a.db', 'k.pem', 'k.key', 'credentials.json', 'data/x.txt', '.git/config']) {
        await assert.rejects(read(f), /secrets/, f);
      }
    });

    test('refuses a symlink that leads out of the workspace or into a secret', async (t) => {
      try {
        fs.symlinkSync(path.join(sibling, 'loot.txt'), path.join(root, 'link.txt'));
        fs.symlinkSync(path.join(root, '.env'), path.join(root, 'innocent.txt'));
      } catch {
        t.skip('symlinks not permitted here');
        return;
      }
      await assert.rejects(read('link.txt'), /outside workspace/);
      await assert.rejects(read('innocent.txt'), /secrets/);
    });

    test('refuses directories, binaries and missing files', async () => {
      await assert.rejects(read('src'), /Not a regular file/);
      await assert.rejects(read('bin.dat'), /binary/);
      await assert.rejects(read('nope.txt'), /File not found/);
    });
  });

  describe('registry management', () => {
    const make = (name: string, description: string, source?: 'builtin' | 'mcp' | 'runtime', props: string[] = []): ToolDefinition => ({
      name,
      description,
      tier: 1,
      source,
      parameters: { type: 'object', properties: Object.fromEntries(props.map((p) => [p, { type: 'string' }])) },
      handler: async () => name,
    });

    test('unregister removes a tool and unregisterBySource removes a whole source', () => {
      registry.registerTools([make('a', 'x', 'mcp'), make('b', 'x', 'mcp'), make('c', 'x')]);
      assert.equal(registry.unregister('c'), true);
      assert.equal(registry.unregister('c'), false);
      assert.equal(registry.unregisterBySource('mcp'), 2);
      assert.equal(registry.getAllTools().length, 0);
    });

    test('refuses to let another source replace a tool and invalid names, reporting per tool', () => {
      registry.registerTool(make('file_read', 'x', 'builtin'));
      const outcome = registry.registerTools([make('file_read', 'evil', 'mcp'), make('bad name', 'x'), make('good', 'x')]);
      assert.deepEqual(outcome.registered, ['good']);
      assert.equal(outcome.rejected.length, 2);
      assert.equal(registry.getTool('file_read')?.description, 'x');
      registry.registerTool(make('good', 'replaced'));
      assert.equal(registry.getTool('good')?.description, 'replaced');
    });

    test('selectToolsForPrompt ranks by keyword overlap and caps the list', () => {
      registry.registerTools([
        make('web_search', 'Search the web for pages', 'builtin', ['query']),
        make('file_read', 'Read a local file', 'builtin', ['filePath']),
        make('system_stats', 'Host memory and hardware specifications', 'builtin'),
        make('calendar_add', 'Add an event to the calendar', 'runtime', ['title']),
      ]);
      const names = (p: string, max?: number) => registry.selectToolsForPrompt(p, max).map((t) => t.name);
      assert.equal(names('please search the web for vulkan drivers')[0], 'web_search');
      assert.equal(names('how much memory is free on the host')[0], 'system_stats');
      assert.deepEqual(names('read the file notes.md'), ['file_read']);
      assert.deepEqual(names('tell me a joke'), []);
      assert.deepEqual(names('search file memory calendar', 2).length, 2);
      assert.deepEqual(names('', 5), []);
    });

    test('getSchemasForModel accepts a subset', () => {
      registry.registerTools([make('a', 'x'), make('b', 'x')]);
      assert.deepEqual(registry.getSchemasForModel(registry.selectToolsForPrompt('zzz')).length, 0);
      assert.equal(registry.getSchemasForModel([registry.getTool('a')!]).length, 1);
    });
  });

  describe('web_search builtin', () => {
    test('reports the typed outcome honestly, including when no engine is reachable', async () => {
      registry.registerBuiltinTools({
        searchClient: { searchDetailed: async () => ({ results: [], source: 'none', unavailableReason: 'SearXNG is unreachable' }) },
      });
      const out = await registry.getTool('web_search')!.handler({ query: 'x' });
      assert.deepEqual(out, { source: 'none', results: [], unavailable: 'SearXNG is unreachable' });
    });
  });
});
