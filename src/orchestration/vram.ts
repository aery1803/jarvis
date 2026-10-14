import { probeGpu } from '../web/diagnostics.js';
import type { InstalledModelInfo } from './lanes.js';

type GpuProbe = typeof probeGpu;

/** Free VRAM probe; `total` reads the pool size from the same cached `probeGpu()` result. */
export type VramProbe = (() => Promise<number | null>) & { total: () => Promise<number | null> };

/**
 * Free VRAM from `probeGpu()` with a short cache: each probe spawns `llama-cli --list-devices`, which is too
 * slow to run on every chat message. Resolves null (unknown) when no device reports a free figure. `total` is the
 * size of the device with the most free memory, from the same probe.
 */
export function createVramProbe(options: { ttlMs?: number; probe?: GpuProbe; now?: () => number } = {}): VramProbe {
  const ttlMs = options.ttlMs ?? 5000;
  const probe = options.probe ?? probeGpu;
  const now = options.now ?? Date.now;
  let cached: { at: number; free: number | null; total: number | null } | null = null;

  const read = async (): Promise<{ free: number | null; total: number | null }> => {
    if (cached && now() - cached.at < ttlMs) return cached;
    let free: number | null = null;
    let total: number | null = null;
    try {
      const gpu = await probe();
      const withFree = gpu.devices.filter((d): d is typeof d & { freeBytes: number } => typeof d.freeBytes === 'number');
      if (withFree.length > 0) {
        const best = withFree.reduce((a, b) => (b.freeBytes > a.freeBytes ? b : a));
        free = best.freeBytes;
        total = typeof best.totalBytes === 'number' ? best.totalBytes : null;
      }
    } catch {
      free = null;
      total = null;
    }
    cached = { at: now(), free, total };
    return cached;
  };

  const freeProbe = (async () => (await read()).free) as VramProbe;
  freeProbe.total = async () => (await read()).total;
  return freeProbe;
}

let sharedProbe: VramProbe | null = null;

export function getSharedVramProbe(): VramProbe {
  sharedProbe ??= createVramProbe();
  return sharedProbe;
}

/** Adapts `probeOllama().installed` (diagnostics shape) to what `ModelRegistry.reconcileInstalled` takes. */
export function installedFromDiagnostics(
  installed: Array<{ name: string; sizeBytes: number | null; parameterSize: string | null; quantization: string | null; family: string | null }>,
): InstalledModelInfo[] {
  return installed.map((m) => ({
    name: m.name,
    sizeBytes: m.sizeBytes,
    parameterSize: m.parameterSize,
    quantization: m.quantization,
    family: m.family,
  }));
}
