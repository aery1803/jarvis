/**
 * Jarvis Local AI Agent: Host & Inference Diagnostics Probe
 * Authority: Section 4 (verified hardware baseline), Section 7.3/7.4 (memory governor, thermal pacing)
 *
 * Why this exists: the memory governor budgets model loads against `os.freemem()`, but on the Flow Z13 the
 * 64 GB unified pool is split before Windows boots -- Windows (and therefore `os.totalmem()`) sees only the
 * ~31.65 GB host partition, while models are loaded into the ~46.5 GB Vulkan VRAM partition that Node cannot
 * see at all. Sizing a 47 GB model against `os.freemem()` is therefore comparing against the wrong pool.
 *
 * This endpoint reports both pools, plus what Ollama actually has installed and resident, so the owner (and
 * the governor) can budget against measured numbers instead of constants baked into the registry.
 *
 * Everything here is read-only and best-effort: each probe is independently timed out and reported as an
 * error string rather than failing the response, so a missing llama.cpp or a stopped Ollama still yields the
 * host numbers.
 */

import os from 'node:os';
import fs from 'node:fs';
import { execFile } from 'node:child_process';

/** llama.cpp Vulkan build used for the Section 4 baseline; the preflight script probes the same path. */
const LLAMA_CLI_PATH = 'C:\\tools\\llama.cpp\\llama-cli.exe';
const BYTES_PER_MIB = 1024 * 1024;

export interface GpuDevice {
  index: number;
  backend: string;
  name: string;
  totalBytes: number | null;
  freeBytes: number | null;
}

export interface OllamaModelInfo {
  name: string;
  sizeBytes: number | null;
  parameterSize: string | null;
  quantization: string | null;
  family: string | null;
}

export interface LoadedOllamaModel {
  name: string;
  sizeBytes: number | null;
  /** Portion resident in VRAM, as Ollama reports it; 0 means the model is running on the CPU. */
  sizeVramBytes: number | null;
  expiresAt: string | null;
}

export interface Diagnostics {
  collectedAt: string;
  host: {
    hostname: string;
    platform: string;
    release: string;
    arch: string;
    nodeVersion: string;
    cpuModel: string | null;
    cpuCount: number;
    /** Host RAM only. On a box with carved-out VRAM this is NOT the physical DIMM total. */
    totalMemoryBytes: number;
    freeMemoryBytes: number;
    uptimeSeconds: number;
    loadAverage: number[];
  };
  process: {
    rssBytes: number;
    heapUsedBytes: number;
    uptimeSeconds: number;
  };
  gpu: {
    devices: GpuDevice[];
    probe: 'llama.cpp' | 'unavailable';
    error?: string;
  };
  ollama: {
    baseUrl: string;
    reachable: boolean;
    installed: OllamaModelInfo[];
    loaded: LoadedOllamaModel[];
    error?: string;
  };
}

/**
 * Parses `llama-cli --list-devices` output. Builds differ in how they word the memory pair, e.g.
 *   `  Vulkan0: AMD Radeon(TM) 8060S Graphics (48971 MiB, 46523 MiB free)`
 *   `  Vulkan0: AMD Radeon(TM) 8060S Graphics (48971 MiB total, 46523 MiB free)`
 * so the two MiB figures are read positionally and only the one tagged `free` is treated as free.
 */
export function parseGpuDevices(stdout: string): GpuDevice[] {
  const devices: GpuDevice[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const header = line.match(/^\s*([A-Za-z]+)(\d+):\s*(.+?)\s*(?:\(([^)]*)\))?\s*$/);
    if (!header) continue;
    const [, backend, index, name, memory] = header;
    if (!/^(vulkan|cuda|rocm|sycl|metal|hip|opencl)$/i.test(backend)) continue;

    let totalBytes: number | null = null;
    let freeBytes: number | null = null;
    if (memory) {
      const figures = [...memory.matchAll(/(\d+(?:\.\d+)?)\s*(MiB|GiB)(\s*free)?/gi)];
      for (const [, amount, unit, isFree] of figures) {
        const bytes = Math.round(Number.parseFloat(amount) * BYTES_PER_MIB * (/GiB/i.test(unit) ? 1024 : 1));
        if (isFree) {
          freeBytes = bytes;
        } else if (totalBytes === null) {
          totalBytes = bytes;
        }
      }
    }

    devices.push({ index: Number.parseInt(index, 10), backend, name: name.trim(), totalBytes, freeBytes });
  }
  return devices;
}

/** Runs `llama-cli --list-devices` with no shell and fixed arguments; never throws. */
export async function probeGpu(timeoutMs = 10_000): Promise<Diagnostics['gpu']> {
  if (os.platform() !== 'win32' || !fs.existsSync(LLAMA_CLI_PATH)) {
    return {
      devices: [],
      probe: 'unavailable',
      error: os.platform() !== 'win32' ? `GPU probe only runs on the Windows host (platform: ${os.platform()})` : `llama-cli not found at ${LLAMA_CLI_PATH}`,
    };
  }

  return new Promise((resolve) => {
    execFile(LLAMA_CLI_PATH, ['--list-devices'], { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      // llama-cli prints its device table to either stream depending on the build, so both are parsed.
      const combined = `${stdout ?? ''}\n${stderr ?? ''}`;
      const devices = parseGpuDevices(combined);
      if (devices.length > 0) {
        resolve({ devices, probe: 'llama.cpp' });
        return;
      }
      resolve({ devices: [], probe: 'unavailable', error: err ? err.message : 'llama-cli listed no recognised devices' });
    });
  });
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function asRecordArray(value: unknown, key: string): Array<Record<string, unknown>> {
  const list = (value as Record<string, unknown> | undefined)?.[key];
  return Array.isArray(list) ? (list.filter((item) => typeof item === 'object' && item !== null) as Array<Record<string, unknown>>) : [];
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Reads Ollama's installed (`/api/tags`) and resident (`/api/ps`) model lists; never throws. */
export async function probeOllama(baseUrl: string, timeoutMs = 8_000): Promise<Diagnostics['ollama']> {
  try {
    const [tags, ps] = await Promise.all([
      fetchJson(`${baseUrl}/api/tags`, timeoutMs),
      // `/api/ps` is absent on older Ollama builds; an empty resident list is not a failure.
      fetchJson(`${baseUrl}/api/ps`, timeoutMs).catch(() => ({ models: [] })),
    ]);

    const installed: OllamaModelInfo[] = asRecordArray(tags, 'models').map((model) => {
      const details = (model.details ?? {}) as Record<string, unknown>;
      return {
        name: stringOrNull(model.name) ?? stringOrNull(model.model) ?? 'unknown',
        sizeBytes: numberOrNull(model.size),
        parameterSize: stringOrNull(details.parameter_size),
        quantization: stringOrNull(details.quantization_level),
        family: stringOrNull(details.family),
      };
    });

    const loaded: LoadedOllamaModel[] = asRecordArray(ps, 'models').map((model) => ({
      name: stringOrNull(model.name) ?? stringOrNull(model.model) ?? 'unknown',
      sizeBytes: numberOrNull(model.size),
      sizeVramBytes: numberOrNull(model.size_vram),
      expiresAt: stringOrNull(model.expires_at),
    }));

    return { baseUrl, reachable: true, installed, loaded };
  } catch (err: unknown) {
    return {
      baseUrl,
      reachable: false,
      installed: [],
      loaded: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function collectDiagnostics(
  ollamaBaseUrl: string,
  probes: { gpu?: () => Promise<Diagnostics['gpu']>; ollama?: (baseUrl: string) => Promise<Diagnostics['ollama']> } = {}
): Promise<Diagnostics> {
  const cpus = os.cpus();
  const memoryUsage = process.memoryUsage();
  const [gpu, ollama] = await Promise.all([(probes.gpu ?? probeGpu)(), (probes.ollama ?? probeOllama)(ollamaBaseUrl)]);

  return {
    collectedAt: new Date().toISOString(),
    host: {
      hostname: os.hostname(),
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      nodeVersion: process.version,
      cpuModel: cpus[0]?.model ?? null,
      cpuCount: cpus.length,
      totalMemoryBytes: os.totalmem(),
      freeMemoryBytes: os.freemem(),
      uptimeSeconds: Math.round(os.uptime()),
      loadAverage: os.loadavg(),
    },
    process: {
      rssBytes: memoryUsage.rss,
      heapUsedBytes: memoryUsage.heapUsed,
      uptimeSeconds: Math.round(process.uptime()),
    },
    gpu,
    ollama,
  };
}
