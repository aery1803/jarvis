import { ModelRegistry, type ModelDefinition, type ModelLane } from './registry.js';
import { MemoryGovernor } from './governor.js';
import { matchesWord } from './lanes.js';

export interface RouteRequest {
  prompt: string;
  taskType?: 'chat' | 'code' | 'reasoning' | 'extraction' | 'embedding' | 'auto';
  preferredLane?: ModelLane;
  /** Honoured when the model is installed (if installed info is present) and fits. */
  preferredModel?: string;
  requiredContextTokens?: number;
}

export interface RouteDecision {
  /** Null exactly when `canRun` is false: nothing installed fits, and the caller must tell the owner. */
  chosenModel: ModelDefinition | null;
  lane: ModelLane;
  rationale: string;
  isFallback: boolean;
  canRun: boolean;
  /** Why no model could run, or why the first choice was refused. */
  reason?: string;
  /** The model the governor refused when `canRun` is false. */
  refusedModel?: ModelDefinition;
  /** How the VRAM verdict was reached when it is worth telling the owner: the chosen model is resident, or others are unloaded for it. */
  fitNote?: string;
}

const CODE_WORDS = ['function', 'class', 'const', 'import', 'def', 'return', 'typescript', 'python', 'bug', 'refactor', 'test', 'tests'];
const COMPLEX_WORDS = ['analyze', 'compare', 'synthesize', 'consensus', 'plan', 'architecture', 'why'];

export class CascadeRouter {
  constructor(
    private registry: ModelRegistry,
    private governor: MemoryGovernor,
  ) {}

  /**
   * Picks the model for a request: the preferred or lane-primary model when it is installed and fits, otherwise
   * the best installed model that fits (same lane first, then smaller). Never returns a model the governor refused.
   */
  async route(request: RouteRequest): Promise<RouteDecision> {
    const lane = this.determineLane(request);
    const useInstalledOnly = this.registry.hasInstalledInfo();
    const eligible = (m: ModelDefinition): boolean => {
      if (useInstalledOnly && !this.registry.isInstalled(m.id)) return false;
      const isEmbedding = m.lane === 'embedding' || (m.lanes?.includes('embedding') ?? false);
      if (isEmbedding || lane === 'embedding') return isEmbedding && lane === 'embedding';
      if (m.lane === 'vision' && lane !== 'vision') return false;
      return true;
    };
    const pool = this.registry.listModels().filter(eligible);

    if (pool.length === 0) {
      return {
        chosenModel: null,
        lane,
        rationale: `No ${useInstalledOnly ? 'installed ' : ''}model is available for lane '${lane}'.`,
        isFallback: false,
        canRun: false,
        reason: lane === 'embedding' ? 'No embedding model is installed.' : 'No installed model is available.',
      };
    }

    const refusals: string[] = [];
    let fitNote = '';
    const tryFit = (m: ModelDefinition): boolean => {
      const check = this.governor.canFit(m);
      if (!check.canRun) refusals.push(`${m.id}: ${check.reason ?? 'insufficient memory'}`);
      // An eviction (or an already-resident model) is part of the honest rationale for the choice.
      fitNote = check.canRun && (check.evicts !== undefined || check.alreadyResident) ? (check.note ?? '') : '';
      return check.canRun;
    };

    const preferred = request.preferredModel ? this.registry.getModel(request.preferredModel) : null;
    const preferredOk = preferred !== null && pool.some((m) => m === preferred || m.id === preferred.id);
    const laneMembers = pool.filter((m) => m.lane === lane || (m.lanes?.includes(lane) ?? false));
    const first =
      (preferredOk ? preferred : null) ??
      laneMembers.find((m) => m.lane === lane && m.isPrimary) ??
      laneMembers[0] ??
      null;

    const notes: string[] = [];
    if (request.preferredModel && !preferredOk) {
      notes.push(`Requested ${request.preferredModel} is ${preferred ? 'not installed' : 'unknown'}.`);
    }

    if (first && tryFit(first)) {
      return {
        chosenModel: first,
        lane,
        rationale: [...notes, `Selected ${first.name} (${first.parameterSize}) for lane '${lane}'.`, fitNote].filter(Boolean).join(' '),
        isFallback: preferredOk ? false : notes.length > 0,
        canRun: true,
        ...(fitNote ? { fitNote } : {}),
      };
    }

    const ceiling = first?.memoryRequirementBytes ?? Infinity;
    const byQualityProxy = (a: ModelDefinition, b: ModelDefinition) => b.memoryRequirementBytes - a.memoryRequirementBytes;
    const candidates = pool.filter((m) => m !== first && m.id !== first?.id && m.memoryRequirementBytes < ceiling);
    const ordered = [
      ...candidates.filter((m) => laneMembers.includes(m)).sort(byQualityProxy),
      ...candidates.filter((m) => !laneMembers.includes(m)).sort(byQualityProxy),
    ];

    for (const fallback of ordered) {
      if (tryFit(fallback)) {
        return {
          chosenModel: fallback,
          lane: fallback.lane,
          rationale: [
            ...notes,
            first ? `${first.name} was refused (${refusals[0] ?? 'insufficient memory'}).` : `No model serves lane '${lane}'.`,
            `Cascaded to ${fallback.name}.`,
            fitNote,
          ].filter(Boolean).join(' '),
          isFallback: true,
          canRun: true,
          reason: refusals[0],
          ...(fitNote ? { fitNote } : {}),
        };
      }
    }

    const reason = refusals.length > 0 ? refusals.join('; ') : 'No model fits the current memory headroom.';
    return {
      chosenModel: null,
      lane,
      rationale: [...notes, `No installed model fits right now. ${reason}`].join(' '),
      isFallback: true,
      canRun: false,
      reason,
      ...(first ? { refusedModel: first } : {}),
    };
  }

  private determineLane(request: RouteRequest): ModelLane {
    if (request.preferredLane) {
      return request.preferredLane;
    }

    const { prompt, taskType } = request;
    if (taskType === 'code') return 'code';
    if (taskType === 'embedding') return 'embedding';
    if (taskType === 'reasoning') return 'balanced';
    if (taskType === 'extraction') return 'fast';

    if (matchesWord(prompt, CODE_WORDS)) return 'code';
    if (matchesWord(prompt, COMPLEX_WORDS) || /explain in depth/i.test(prompt) || prompt.length > 500) return 'balanced';
    return 'fast';
  }
}
