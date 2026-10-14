import { CapabilityChecker } from './capability.js';
import type { ModelDefinition } from './registry.js';

export interface MemoryGovernorOptions {
  capabilityChecker?: CapabilityChecker;
  pacingDelayMs?: number; // 500 ms cooling delay per Section 7.4
}

export class MemoryGovernor {
  private checker: CapabilityChecker;
  private pacingDelayMs: number;
  private activeHeavyModel: string | null = null;
  private lastInferenceTime = 0;

  constructor(options: MemoryGovernorOptions = {}) {
    this.checker = options.capabilityChecker ?? new CapabilityChecker();
    this.pacingDelayMs = options.pacingDelayMs ?? 500;
  }

  getActiveHeavyModel(): string | null {
    return this.activeHeavyModel;
  }

  /**
   * Attempts to acquire an execution lease for a model.
   * Throws or returns false if resource check fails or another heavy model is running.
   */
  async acquireLease(model: ModelDefinition): Promise<{ acquired: boolean; reason?: string }> {
    // 1. Check capability headroom
    const check = this.checker.canRunModel(model);
    if (!check.canRun) {
      return { acquired: false, reason: check.reason };
    }

    // 2. Enforce single heavy model at a time invariant (models > 2 GB)
    const isHeavy = model.memoryRequirementBytes > 2 * 1024 * 1024 * 1024;
    if (isHeavy && this.activeHeavyModel && this.activeHeavyModel !== model.id) {
      return {
        acquired: false,
        reason: `Cannot load ${model.id}: heavy model ${this.activeHeavyModel} is currently active. One heavy model invariant enforced.`,
      };
    }

    // 3. Apply cooling pacing delay if back-to-back calls
    const now = Date.now();
    const elapsed = now - this.lastInferenceTime;
    if (elapsed < this.pacingDelayMs) {
      const waitTime = this.pacingDelayMs - elapsed;
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }

    if (isHeavy) {
      this.activeHeavyModel = model.id;
    }

    return { acquired: true };
  }

  releaseLease(modelId: string): void {
    if (this.activeHeavyModel === modelId) {
      this.activeHeavyModel = null;
    }
    this.lastInferenceTime = Date.now();
  }

  getChecker(): CapabilityChecker {
    return this.checker;
  }
}
