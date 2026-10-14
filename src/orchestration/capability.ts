import os from 'node:os';
import type { ModelDefinition } from './registry.js';

const GIB = 1024 * 1024 * 1024;

export interface CapabilityCheckResult {
  canRun: boolean;
  /** 'vram': weights budgeted against the Vulkan pool; 'host': legacy host-RAM comparison; 'unverified': no VRAM figure and policy 'allow'. */
  mode: 'vram' | 'host' | 'unverified';
  freeRamBytes: number;
  freeRamGb: number;
  totalRamGb: number;
  requiredRamBytes: number;
  /** Free bytes left in the governing pool after the load (VRAM in 'vram' mode, host RAM otherwise). */
  headroomBytes: number;
  headroomGb: number;
  vramFreeBytes: number | null;
  reason?: string;
}

export interface CapabilityCheckerOptions {
  /** Host free-RAM floor in bytes. Beats `JARVIS_MIN_HOST_FREE_GB` and the computed default. */
  minHeadroomBytes?: number;
  /** Extra VRAM kept free beyond the model's own requirement. Default 512 MiB. */
  vramMarginBytes?: number;
  /** What to do when no VRAM figure is available: legacy host-only comparison, or skip the check. */
  unknownVramPolicy?: 'host-only' | 'allow';
  env?: Record<string, string | undefined>;
}

export class CapabilityChecker {
  private explicitFloorBytes: number | null;
  private vramMarginBytes: number;
  private unknownVramPolicy: 'host-only' | 'allow';
  private vramFreeBytes: number | null = null;

  constructor(options: CapabilityCheckerOptions = {}) {
    const envGb = Number.parseFloat((options.env ?? process.env).JARVIS_MIN_HOST_FREE_GB ?? '');
    this.explicitFloorBytes =
      options.minHeadroomBytes ?? (Number.isFinite(envGb) && envGb >= 0 ? envGb * GIB : null);
    this.vramMarginBytes = options.vramMarginBytes ?? 512 * 1024 * 1024;
    this.unknownVramPolicy = options.unknownVramPolicy ?? 'host-only';
  }

  getFreeMemory(): number {
    return os.freemem();
  }

  getTotalMemory(): number {
    return os.totalmem();
  }

  /** Fed by the runtime from `probeGpu()` in `src/web/diagnostics.ts`; null means unknown. */
  setVramFree(bytes: number | null): void {
    this.vramFreeBytes = bytes !== null && Number.isFinite(bytes) && bytes >= 0 ? bytes : null;
  }

  getVramFree(): number | null {
    return this.vramFreeBytes;
  }

  /**
   * Host free-RAM floor. A flat 14 GB (the old default) refuses everything on a box whose Windows partition is
   * 31.65 GB and often has ~14 GB free, because the weights live in the Vulkan pool, not host RAM. The default is
   * therefore min(14 GB, 25% of total host RAM): still 14 GB on a large host, a proportionate reserve on this one.
   */
  getHostFloorBytes(): number {
    return this.explicitFloorBytes ?? Math.min(14 * GIB, 0.25 * this.getTotalMemory());
  }

  /**
   * Whether a model can load without starving the OS. With a VRAM figure the weights are budgeted against VRAM
   * (requirement + margin must fit) and host RAM only has to stay above the floor; without one the legacy
   * host-only comparison applies and requires the floor to still hold AFTER the load.
   */
  canRunModel(model: ModelDefinition): CapabilityCheckResult {
    const freeBytes = this.getFreeMemory();
    const totalBytes = this.getTotalMemory();
    const requiredBytes = model.memoryRequirementBytes;
    const floor = this.getHostFloorBytes();
    const vramFree = this.vramFreeBytes;
    const gb = (bytes: number) => parseFloat((bytes / GIB).toFixed(2));

    const build = (
      canRun: boolean,
      mode: CapabilityCheckResult['mode'],
      headroomBytes: number,
      reason?: string,
    ): CapabilityCheckResult => ({
      canRun,
      mode,
      freeRamBytes: freeBytes,
      freeRamGb: gb(freeBytes),
      totalRamGb: gb(totalBytes),
      requiredRamBytes: requiredBytes,
      headroomBytes,
      headroomGb: gb(headroomBytes),
      vramFreeBytes: vramFree,
      ...(reason ? { reason } : {}),
    });

    const hostExhausted = `Host memory headroom exhausted: ${gb(freeBytes)} GB free, minimum required is ${(floor / GIB).toFixed(1)} GB.`;

    if (vramFree !== null) {
      const vramAfter = vramFree - requiredBytes - this.vramMarginBytes;
      if (freeBytes < floor) return build(false, 'vram', vramAfter, hostExhausted);
      if (vramAfter < 0) {
        return build(
          false,
          'vram',
          vramAfter,
          `Insufficient VRAM: ${model.id} needs ${(requiredBytes / GIB).toFixed(2)} GB plus a ${(this.vramMarginBytes / GIB).toFixed(2)} GB margin, but only ${gb(vramFree)} GB of VRAM is free.`,
        );
      }
      return build(true, 'vram', vramAfter);
    }

    if (this.unknownVramPolicy === 'allow') {
      if (freeBytes < floor) return build(false, 'unverified', freeBytes - requiredBytes, hostExhausted);
      return build(true, 'unverified', freeBytes - requiredBytes);
    }

    const remainingAfterLoad = freeBytes - requiredBytes;
    if (freeBytes < floor) return build(false, 'host', remainingAfterLoad, hostExhausted);
    if (remainingAfterLoad < floor) {
      return build(
        false,
        'host',
        remainingAfterLoad,
        `Insufficient memory: model requires ${(requiredBytes / GIB).toFixed(2)} GB and would leave ${gb(remainingAfterLoad)} GB free, below the ${(floor / GIB).toFixed(1)} GB floor (only ${gb(freeBytes)} GB free now).`,
      );
    }
    return build(true, 'host', remainingAfterLoad);
  }

  isSystemReady(): { ready: boolean; freeRamGb: number; minRequiredGb: number } {
    const free = this.getFreeMemory();
    const floor = this.getHostFloorBytes();
    return {
      ready: free >= floor,
      freeRamGb: parseFloat((free / GIB).toFixed(2)),
      minRequiredGb: parseFloat((floor / GIB).toFixed(1)),
    };
  }
}
