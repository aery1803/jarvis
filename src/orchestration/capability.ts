import os from 'node:os';
import { ModelDefinition } from './registry.js';

export interface CapabilityCheckResult {
  canRun: boolean;
  freeRamBytes: number;
  freeRamGb: number;
  totalRamGb: number;
  requiredRamBytes: number;
  headroomBytes: number;
  headroomGb: number;
  reason?: string;
}

export interface CapabilityCheckerOptions {
  minHeadroomBytes?: number; // Default: 14 GB per Principle 1 / Section 7.4
}

export class CapabilityChecker {
  private minHeadroomBytes: number;

  constructor(options: CapabilityCheckerOptions = {}) {
    this.minHeadroomBytes = options.minHeadroomBytes ?? 14 * 1024 * 1024 * 1024;
  }

  getFreeMemory(): number {
    return os.freemem();
  }

  getTotalMemory(): number {
    return os.totalmem();
  }

  /**
   * Evaluates if a given model can safely execute without reducing OS RAM headroom below threshold.
   */
  canRunModel(model: ModelDefinition): CapabilityCheckResult {
    const freeBytes = this.getFreeMemory();
    const totalBytes = this.getTotalMemory();
    const requiredBytes = model.memoryRequirementBytes;
    const remainingAfterLoad = freeBytes - requiredBytes;

    const freeRamGb = parseFloat((freeBytes / (1024 * 1024 * 1024)).toFixed(2));
    const totalRamGb = parseFloat((totalBytes / (1024 * 1024 * 1024)).toFixed(2));
    const headroomGb = parseFloat((remainingAfterLoad / (1024 * 1024 * 1024)).toFixed(2));

    if (freeBytes < this.minHeadroomBytes) {
      return {
        canRun: false,
        freeRamBytes: freeBytes,
        freeRamGb,
        totalRamGb,
        requiredRamBytes: requiredBytes,
        headroomBytes: remainingAfterLoad,
        headroomGb,
        reason: `Host memory headroom exhausted: ${freeRamGb} GB free, minimum required is ${(this.minHeadroomBytes / (1024 * 1024 * 1024)).toFixed(1)} GB.`,
      };
    }

    if (remainingAfterLoad < 0) {
      return {
        canRun: false,
        freeRamBytes: freeBytes,
        freeRamGb,
        totalRamGb,
        requiredRamBytes: requiredBytes,
        headroomBytes: remainingAfterLoad,
        headroomGb,
        reason: `Insufficient memory: model requires ${(requiredBytes / (1024 * 1024 * 1024)).toFixed(2)} GB, but only ${freeRamGb} GB free.`,
      };
    }

    return {
      canRun: true,
      freeRamBytes: freeBytes,
      freeRamGb,
      totalRamGb,
      requiredRamBytes: requiredBytes,
      headroomBytes: remainingAfterLoad,
      headroomGb,
    };
  }

  /**
   * Verifies general system readiness.
   */
  isSystemReady(): { ready: boolean; freeRamGb: number; minRequiredGb: number } {
    const free = this.getFreeMemory();
    const minRequiredGb = parseFloat((this.minHeadroomBytes / (1024 * 1024 * 1024)).toFixed(1));
    const freeRamGb = parseFloat((free / (1024 * 1024 * 1024)).toFixed(2));
    return {
      ready: free >= this.minHeadroomBytes,
      freeRamGb,
      minRequiredGb,
    };
  }
}
