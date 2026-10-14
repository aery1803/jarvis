import { CapabilityChecker, type CapabilityCheckResult } from './capability.js';
import type { ModelDefinition } from './registry.js';

const HEAVY_THRESHOLD_BYTES = 2 * 1024 * 1024 * 1024;

export interface MemoryGovernorOptions {
  capabilityChecker?: CapabilityChecker;
  pacingDelayMs?: number; // 500 ms cooling delay per Section 7.4
  /** Injectable clock and sleep so pacing is testable without real delays. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface WithLeaseOptions {
  /** Longest wait for another heavy model to finish. Default 120 s. */
  timeoutMs?: number;
}

export class LeaseTimeoutError extends Error {
  readonly code = 'LEASE_TIMEOUT';
  constructor(
    readonly modelId: string,
    readonly waitedMs: number,
    readonly activeModel: string | null,
  ) {
    super(`Timed out after ${waitedMs} ms waiting to load ${modelId}; heavy model ${activeModel ?? 'unknown'} still holds the lease.`);
    this.name = 'LeaseTimeoutError';
  }
}

export class LeaseDeniedError extends Error {
  readonly code = 'LEASE_DENIED';
  constructor(
    readonly modelId: string,
    readonly reason: string,
  ) {
    super(`Cannot run ${modelId}: ${reason}`);
    this.name = 'LeaseDeniedError';
  }
}

interface Waiter {
  modelId: string;
  grant: () => void;
  timer: ReturnType<typeof setTimeout>;
}

export function isHeavyModel(model: ModelDefinition): boolean {
  return model.memoryRequirementBytes > HEAVY_THRESHOLD_BYTES;
}

export class MemoryGovernor {
  private checker: CapabilityChecker;
  private pacingDelayMs: number;
  private now: () => number;
  private sleep: (ms: number) => Promise<void>;
  private activeHeavyModel: string | null = null;
  private lastInferenceTime = 0;
  private waiters: Waiter[] = [];

  constructor(options: MemoryGovernorOptions = {}) {
    this.checker = options.capabilityChecker ?? new CapabilityChecker();
    this.pacingDelayMs = options.pacingDelayMs ?? 500;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  getActiveHeavyModel(): string | null {
    return this.activeHeavyModel;
  }

  getQueueLength(): number {
    return this.waiters.length;
  }

  /** Side-effect-free capacity check (no lease, no pacing); what the router uses to compare candidates. */
  canFit(model: ModelDefinition): CapabilityCheckResult {
    return this.checker.canRunModel(model);
  }

  private async pace(): Promise<void> {
    const elapsed = this.now() - this.lastInferenceTime;
    if (elapsed < this.pacingDelayMs) {
      await this.sleep(this.pacingDelayMs - elapsed);
    }
  }

  /**
   * Attempts to acquire an execution lease for a model without waiting.
   * Returns acquired:false if the resource check fails or another heavy model is running.
   */
  async acquireLease(model: ModelDefinition): Promise<{ acquired: boolean; reason?: string }> {
    const check = this.checker.canRunModel(model);
    if (!check.canRun) {
      return { acquired: false, reason: check.reason };
    }

    const isHeavy = isHeavyModel(model);
    if (isHeavy && this.activeHeavyModel && this.activeHeavyModel !== model.id) {
      return {
        acquired: false,
        reason: `Cannot load ${model.id}: heavy model ${this.activeHeavyModel} is currently active. One heavy model invariant enforced.`,
      };
    }

    // Reserve before the pacing await: two concurrent callers would otherwise both pass the check above.
    if (isHeavy) {
      this.activeHeavyModel = model.id;
    }
    await this.pace();
    return { acquired: true };
  }

  releaseLease(modelId: string): void {
    if (this.activeHeavyModel === modelId) {
      this.activeHeavyModel = null;
      this.grantNext();
    }
    this.lastInferenceTime = this.now();
  }

  private grantNext(): void {
    const next = this.waiters.shift();
    if (!next) return;
    clearTimeout(next.timer);
    this.activeHeavyModel = next.modelId;
    next.grant();
  }

  private waitForTurn(modelId: string, timeoutMs: number): Promise<void> {
    if (this.activeHeavyModel === null && this.waiters.length === 0) {
      this.activeHeavyModel = modelId;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const startedAt = this.now();
      const waiter: Waiter = {
        modelId,
        grant: resolve,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index !== -1) this.waiters.splice(index, 1);
          reject(new LeaseTimeoutError(modelId, this.now() - startedAt, this.activeHeavyModel));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  /**
   * Runs `fn` while holding the model's lease. A heavy model waits in a FIFO queue behind whichever heavy model
   * is active instead of failing; capacity is checked once it is that model's turn (the previous model's memory
   * is free by then). Always releases, and honours the thermal pacing gap between inferences.
   * Rejects with `LeaseTimeoutError` or `LeaseDeniedError`.
   */
  async withLease<T>(model: ModelDefinition, fn: () => Promise<T>, options: WithLeaseOptions = {}): Promise<T> {
    const heavy = isHeavyModel(model);
    if (heavy) {
      await this.waitForTurn(model.id, options.timeoutMs ?? 120_000);
    }

    try {
      const check = this.checker.canRunModel(model);
      if (!check.canRun) {
        throw new LeaseDeniedError(model.id, check.reason ?? 'insufficient memory');
      }
      await this.pace();
      return await fn();
    } finally {
      if (heavy) {
        this.releaseLease(model.id);
      } else {
        this.lastInferenceTime = this.now();
      }
    }
  }

  getChecker(): CapabilityChecker {
    return this.checker;
  }
}
