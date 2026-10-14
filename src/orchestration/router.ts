import { ModelRegistry, ModelDefinition, ModelLane } from './registry.js';
import { MemoryGovernor } from './governor.js';

export interface RouteRequest {
  prompt: string;
  taskType?: 'chat' | 'code' | 'reasoning' | 'extraction' | 'embedding' | 'auto';
  preferredLane?: ModelLane;
  requiredContextTokens?: number;
}

export interface RouteDecision {
  chosenModel: ModelDefinition;
  lane: ModelLane;
  rationale: string;
  isFallback: boolean;
}

export class CascadeRouter {
  constructor(
    private registry: ModelRegistry,
    private governor: MemoryGovernor
  ) {}

  /**
   * Evaluates prompt complexity and returns the optimal model meeting quality and memory constraints.
   */
  async route(request: RouteRequest): Promise<RouteDecision> {
    const determinedLane = this.determineLane(request);
    let candidate = this.registry.getPrimaryModelForLane(determinedLane);

    if (!candidate) {
      candidate = this.registry.getPrimaryModelForLane('fast')!;
    }

    // Check capability headroom
    const leaseCheck = await this.governor.acquireLease(candidate);
    if (leaseCheck.acquired) {
      this.governor.releaseLease(candidate.id); // release check lease
      return {
        chosenModel: candidate,
        lane: determinedLane,
        rationale: `Selected primary ${candidate.name} (${candidate.parameterSize}) for lane '${determinedLane}' based on task profile.`,
        isFallback: false,
      };
    }

    // Cascade Fallback: Check lighter models in ascending order of memory requirement
    const lighterModels = this.registry
      .listModels()
      .filter((m) => m.id !== candidate.id)
      .sort((a, b) => a.memoryRequirementBytes - b.memoryRequirementBytes);

    for (const fallbackModel of lighterModels) {
      const fallbackCheck = await this.governor.acquireLease(fallbackModel);
      if (fallbackCheck.acquired) {
        this.governor.releaseLease(fallbackModel.id);
        return {
          chosenModel: fallbackModel,
          lane: fallbackModel.lane,
          rationale: `Memory constrained for ${candidate.name} (${leaseCheck.reason}). Cascaded down to lightweight ${fallbackModel.name}.`,
          isFallback: true,
        };
      }
    }

    // Ultimate fallback to candidate
    return {
      chosenModel: candidate,
      lane: determinedLane,
      rationale: `Defaulting to ${candidate.name} (insufficient headroom for preferred lane).`,
      isFallback: true,
    };
  }

  private determineLane(request: RouteRequest): ModelLane {
    if (request.preferredLane) {
      return request.preferredLane;
    }

    const { prompt, taskType } = request;
    if (taskType === 'code') {
      return 'code';
    }
    if (taskType === 'embedding') {
      return 'resident';
    }
    if (taskType === 'reasoning') {
      return 'balanced';
    }
    if (taskType === 'extraction') {
      return 'fast';
    }

    // Auto-detection from prompt heuristics
    const lower = prompt.toLowerCase();
    const codeKeywords = ['function', 'class', 'const ', 'import ', 'def ', 'return ', 'typescript', 'python', 'bug', 'refactor', 'test'];
    const hasCode = codeKeywords.some((k) => lower.includes(k));
    if (hasCode) {
      return 'code';
    }

    const complexKeywords = ['analyze', 'compare', 'synthesize', 'consensus', 'plan', 'architecture', 'why', 'explain in depth'];
    const hasComplex = complexKeywords.some((k) => lower.includes(k));
    if (hasComplex || prompt.length > 500) {
      return 'balanced';
    }

    return 'fast';
  }
}
