/**
 * Unit Tests: Host & Inference Diagnostics Probe
 * Authority: Section 4 (hardware baseline), Section 7.4 (memory governor), CODING_RULES.md Section 2
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import { parseGpuDevices, probeGpu, probeOllama, collectDiagnostics } from '../src/web/diagnostics.js';

describe('parseGpuDevices', () => {
  test('reads the "N MiB total, N MiB free" wording', () => {
    const devices = parseGpuDevices(
      ['Available devices:', '  Vulkan0: AMD Radeon(TM) 8060S Graphics (48971 MiB total, 46523 MiB free)'].join('\n')
    );
    assert.equal(devices.length, 1);
    assert.equal(devices[0].backend, 'Vulkan');
    assert.equal(devices[0].index, 0);
    assert.equal(devices[0].name, 'AMD Radeon(TM) 8060S Graphics');
    assert.equal(devices[0].totalBytes, 48971 * 1024 * 1024);
    assert.equal(devices[0].freeBytes, 46523 * 1024 * 1024);
  });

  test('reads the shorter "N MiB, N MiB free" wording used by other builds', () => {
    const [device] = parseGpuDevices('  Vulkan0: AMD Radeon(TM) 8060S Graphics (48971 MiB, 46523 MiB free)');
    assert.equal(device.totalBytes, 48971 * 1024 * 1024);
    assert.equal(device.freeBytes, 46523 * 1024 * 1024);
  });

  test('keeps a device whose memory figures are absent', () => {
    const [device] = parseGpuDevices('  Vulkan0: AMD Radeon(TM) 8060S Graphics');
    assert.equal(device.name, 'AMD Radeon(TM) 8060S Graphics');
    assert.equal(device.totalBytes, null);
    assert.equal(device.freeBytes, null);
  });

  test('ignores banner lines and unrecognised backends', () => {
    const devices = parseGpuDevices(
      [
        'ggml_vulkan: Found 1 Vulkan devices:',
        'Available devices:',
        '  Vulkan0: AMD Radeon(TM) 8060S Graphics (48971 MiB, 46523 MiB free)',
        '  Widget3: not a compute backend (12 MiB)',
        'load_backend: loaded RPC backend',
      ].join('\n')
    );
    assert.deepEqual(devices.map((d) => d.backend), ['Vulkan']);
  });

  test('handles several devices and GiB units', () => {
    const devices = parseGpuDevices(
      ['  CUDA0: NVIDIA Test (24 GiB total, 20 GiB free)', '  Vulkan1: AMD Test (8192 MiB, 4096 MiB free)'].join('\n')
    );
    assert.deepEqual(devices.map((d) => [d.backend, d.index]), [
      ['CUDA', 0],
      ['Vulkan', 1],
    ]);
    assert.equal(devices[0].totalBytes, 24 * 1024 * 1024 * 1024);
    assert.equal(devices[1].freeBytes, 4096 * 1024 * 1024);
  });

  test('returns nothing for empty or unrelated output', () => {
    assert.deepEqual(parseGpuDevices(''), []);
    assert.deepEqual(parseGpuDevices('error while handling argument "--list-devices"'), []);
  });
});

describe('probeGpu', () => {
  test('reports unavailable rather than throwing when it cannot run here', async () => {
    const gpu = await probeGpu();
    if (os.platform() === 'win32') {
      assert.ok(gpu.probe === 'llama.cpp' || gpu.probe === 'unavailable');
    } else {
      assert.equal(gpu.probe, 'unavailable');
      assert.deepEqual(gpu.devices, []);
      assert.match(gpu.error ?? '', /only runs on the Windows host/);
    }
  });
});

/** Serves canned `/api/tags` and `/api/ps` payloads, or a status code, in place of Ollama. */
async function withFakeOllama<T>(
  routes: Record<string, { status?: number; body?: unknown }>,
  run: (baseUrl: string) => Promise<T>
): Promise<T> {
  const server = http.createServer((req, res) => {
    const route = routes[req.url ?? ''];
    if (!route) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(route.status ?? 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(route.body ?? {}));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('probeOllama', () => {
  test('normalizes installed and resident models, including VRAM residency', async () => {
    const ollama = await withFakeOllama(
      {
        '/api/tags': {
          body: {
            models: [
              { name: 'qwen3:8b', size: 5_200_000_000, details: { parameter_size: '8.2B', quantization_level: 'Q4_K_M', family: 'qwen3' } },
              { name: 'qwen3:72b', size: 47_400_000_000, details: { parameter_size: '72B', quantization_level: 'Q4_K_M', family: 'qwen3' } },
            ],
          },
        },
        '/api/ps': {
          body: { models: [{ name: 'qwen3:8b', size: 5_200_000_000, size_vram: 5_200_000_000, expires_at: '2026-10-15T12:00:00Z' }] },
        },
      },
      (baseUrl) => probeOllama(baseUrl)
    );

    assert.equal(ollama.reachable, true);
    assert.deepEqual(ollama.installed.map((m) => m.name), ['qwen3:8b', 'qwen3:72b']);
    assert.equal(ollama.installed[1].sizeBytes, 47_400_000_000);
    assert.equal(ollama.installed[0].quantization, 'Q4_K_M');
    assert.deepEqual(ollama.loaded.map((m) => [m.name, m.sizeVramBytes]), [['qwen3:8b', 5_200_000_000]]);
  });

  test('still reports installed models when /api/ps is missing (older Ollama)', async () => {
    const ollama = await withFakeOllama({ '/api/tags': { body: { models: [{ name: 'qwen3:8b' }] } } }, (baseUrl) => probeOllama(baseUrl));
    assert.equal(ollama.reachable, true);
    assert.deepEqual(ollama.installed.map((m) => m.name), ['qwen3:8b']);
    assert.deepEqual(ollama.loaded, []);
  });

  test('reports unreachable instead of throwing when Ollama is down', async () => {
    const ollama = await probeOllama('http://127.0.0.1:9', 500);
    assert.equal(ollama.reachable, false);
    assert.deepEqual(ollama.installed, []);
    assert.ok(ollama.error);
  });

  test('tolerates a malformed payload', async () => {
    const ollama = await withFakeOllama({ '/api/tags': { body: { models: 'not-an-array' } }, '/api/ps': { body: {} } }, (baseUrl) =>
      probeOllama(baseUrl)
    );
    assert.equal(ollama.reachable, true);
    assert.deepEqual(ollama.installed, []);
  });
});

describe('collectDiagnostics', () => {
  test('always returns the host numbers even when every external probe fails', async () => {
    const diagnostics = await collectDiagnostics('http://127.0.0.1:9');
    assert.ok(diagnostics.host.totalMemoryBytes > 0);
    assert.ok(diagnostics.host.freeMemoryBytes > 0);
    assert.equal(diagnostics.host.platform, os.platform());
    assert.ok(diagnostics.host.cpuCount >= 1);
    assert.ok(diagnostics.process.rssBytes > 0);
    assert.equal(diagnostics.ollama.reachable, false);
    assert.ok(Array.isArray(diagnostics.gpu.devices));
    assert.ok(Date.parse(diagnostics.collectedAt) > 0);
  });
});
