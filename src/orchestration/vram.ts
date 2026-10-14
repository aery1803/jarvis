import { probeGpu } from '../web/diagnostics.js';
import type { InstalledModelInfo } from './lanes.js';

type GpuProbe = typeof probeGpu;

/**
 * Free VRAM from `probeGpu()` with a short cache: each probe spawns `llama-cli --list-devices`, which is too
 * slow to run on every chat message. Resolves null (unknown) when no device reports a free figure.
 */
export function createVramProbe(options: { ttlMs?: number; probe?: GpuProbe; now?: () => number } = {}): () => Promise<number | null> {
  const ttlMs = options.ttlMs ?? 5000;
  const probe = options.probe ?? probeGpu;
  const now = options.now ?? Date.now;
  let cached: { at: number; value: number | null } | null = null;

  return async () => {
    if (cached && now() - cached.at < ttlMs) return cached.value;
    let value: number | null = null;
    try {
      const gpu = await probe();
      const free = gpu.devices.map((d) => d.freeBytes).filter((b): b is number => typeof b === 'number');
      value = free.length > 0 ? Math.max(...free) : null;
    } catch {
      value = null;
    }
    cached = { at: now(), value };
    return value;
  };
}

let sharedProbe: (() => Promise<number | null>) | null = null;

export function getSharedVramProbe(): () => Promise<number | null> {
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
