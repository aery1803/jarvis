/**
 * Unit Tests: Configuration resolution
 * Authority: Section 17.10
 */

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

const KEYS = ['JARVIS_DEFAULT_MODEL', 'JARVIS_CONTEXT_TOKENS', 'JARVIS_MIN_HOST_FREE_GB', 'JARVIS_MIN_FREE_RAM_GB', 'JARVIS_MIN_FREE_RAM', 'JARVIS_ALLOW_MODEL_PULL', 'JARVIS_SEARCH_LIVE_FALLBACK', 'JARVIS_MCP_SERVERS', 'JARVIS_WEB_ALLOWED_IPS', 'JARVIS_POLL_INTERVAL'];

describe('loadConfig', () => {
  afterEach(() => {
    for (const key of KEYS) delete process.env[key];
  });

  test('defaults match the measured box: qwen3:8b baseline, 16384 context, no implicit pulls', () => {
    const cfg = loadConfig();
    assert.equal(cfg.defaultModel, 'qwen3:8b');
    assert.equal(cfg.contextTokens, 16_384);
    assert.equal(cfg.allowModelPull, false);
    assert.equal(cfg.searchLiveFallback, false);
    assert.deepEqual(cfg.mcpServers, []);
    assert.equal(cfg.minHostFreeGb, 4);
    assert.equal(cfg.minFreeMemoryBytes, 4 * 1024 ** 3);
  });

  test('environment values override, and numbers that are not numbers fall back instead of becoming NaN', () => {
    process.env.JARVIS_DEFAULT_MODEL = 'qwen3:32b';
    process.env.JARVIS_CONTEXT_TOKENS = 'lots';
    process.env.JARVIS_POLL_INTERVAL = '-5';
    process.env.JARVIS_ALLOW_MODEL_PULL = 'true';
    process.env.JARVIS_MIN_HOST_FREE_GB = '12.5';
    const cfg = loadConfig();
    assert.equal(cfg.defaultModel, 'qwen3:32b');
    assert.equal(cfg.contextTokens, 16_384);
    assert.equal(cfg.pollingIntervalMs, 45_000);
    assert.equal(cfg.allowModelPull, true);
    assert.equal(cfg.minHostFreeGb, 12.5);
    assert.equal(cfg.minFreeMemoryBytes, Math.round(12.5 * 1024 ** 3));
  });

  test('legacy JARVIS_MIN_FREE_RAM (bytes) still works', () => {
    process.env.JARVIS_MIN_FREE_RAM = String(8 * 1024 ** 3);
    assert.equal(loadConfig().minHostFreeGb, 8);
  });

  test('MCP servers are parsed and malformed JSON disables them instead of crashing', () => {
    process.env.JARVIS_MCP_SERVERS = JSON.stringify([{ name: 'fs', command: 'node', args: ['server.js'] }]);
    assert.deepEqual(loadConfig().mcpServers, [{ name: 'fs', command: 'node', args: ['server.js'] }]);
    process.env.JARVIS_MCP_SERVERS = '{nope';
    assert.deepEqual(loadConfig().mcpServers, []);
  });

  test('a nonsense allowlist entry fails loudly at load time', () => {
    process.env.JARVIS_WEB_ALLOWED_IPS = '192.168.1.0/24, lan-laptop';
    assert.throws(() => loadConfig(), /Invalid JARVIS_WEB_ALLOWED_IPS/);
    process.env.JARVIS_WEB_ALLOWED_IPS = '192.168.1.0/24';
    assert.deepEqual(loadConfig().webAllowedIps, ['192.168.1.0/24']);
  });
});
