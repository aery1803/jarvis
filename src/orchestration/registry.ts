import {
  GIB,
  KIMI_REGISTRY_ID,
  canonicalizeTag,
  inferFamily,
  inferLane,
  normalizeTag,
  parseParameterBillions,
  type InstalledModelInfo,
  type ModelLane,
} from './lanes.js';

export type { ModelLane, InstalledModelInfo } from './lanes.js';

export interface ModelDefinition {
  id: string;
  name: string;
  /** Home lane. A model that serves further lanes lists them all (home included) in `lanes`. */
  lane: ModelLane;
  lanes?: ModelLane[];
  family: string;
  parameterSize: string;
  quantization: string;
  /** Pool the weights load into plus KV/overhead margin; see `estimateRequirementBytes`. */
  memoryRequirementBytes: number;
  /** Real on-disk size once `reconcileInstalled` has seen the model; otherwise undefined. */
  diskSizeBytes?: number;
  contextLength: number;
  /** 0 means never measured on this box. */
  measuredTokensPerSec: number;
  strengths: string[];
  isPrimary: boolean;
  notes?: string;
}

export interface ReconcileReport {
  /** Registry ids that Ollama reports as installed. */
  matched: string[];
  /** Installed models the registry did not know, now registered with an inferred lane. */
  added: string[];
  /** Registry ids with no installed counterpart. */
  notInstalled: string[];
}

/**
 * Runtime memory for a model whose weights occupy `diskBytes`: the weights themselves plus KV cache and compute
 * buffers. Ollama's default context keeps the KV cache to a few percent of the weights, so the margin is the
 * larger of 0.5 GiB and 4% of the weights. Raise `num_ctx` far past the default and this underestimates.
 */
export function estimateRequirementBytes(diskBytes: number): number {
  return Math.round(diskBytes + Math.max(0.5 * GIB, diskBytes * 0.04));
}

function servesLane(model: ModelDefinition, lane: ModelLane): boolean {
  return model.lane === lane || (model.lanes?.includes(lane) ?? false);
}

export class ModelRegistry {
  /** Keyed by `canonicalizeTag(id)` so `:latest`, case and the Kimi HF alias cannot create duplicates. */
  private models: Map<string, ModelDefinition> = new Map();
  private installed: Map<string, { tag: string; sizeBytes: number | null }> = new Map();
  private installedKnown = false;

  constructor() {
    this.registerDefaults();
  }

  private registerDefaults(): void {
    // Real on-disk sizes measured from the owner's Ollama (`/api/tags`); `reconcileInstalled` refreshes them.
    const sized = (diskBytes: number) => ({ diskSizeBytes: diskBytes, memoryRequirementBytes: estimateRequirementBytes(diskBytes) });

    this.register({
      id: 'qwen3:8b',
      name: 'Qwen 3 8B',
      lane: 'resident',
      lanes: ['resident', 'fast', 'code'],
      family: 'qwen',
      parameterSize: '8B',
      quantization: 'q4_k_m',
      ...sized(5225388164),
      contextLength: 32768,
      measuredTokensPerSec: 42.0,
      strengths: ['resident baseline', 'orchestration', 'tool calling', 'code generation', 'fast conversational response', 'summaries', 'email triage'],
      isPrimary: true,
      notes: 'Resident baseline with full system, tool, and memory access; also serves the fast and code lanes',
    });

    this.register({
      id: 'qwen3:14b',
      name: 'Qwen 3 14B',
      lane: 'balanced',
      lanes: ['balanced', 'code'],
      family: 'qwen',
      parameterSize: '14B',
      quantization: 'q4_k_m',
      ...sized(9276198565),
      contextLength: 32768,
      measuredTokensPerSec: 28.5,
      strengths: ['multi-step reasoning', 'high-accuracy logic', 'analytical synthesis'],
      isPrimary: true,
      notes: 'Mid-tier model balancing intelligence with latency',
    });

    this.register({
      id: 'qwen3.8:27b',
      name: 'Qwen 3.8 27B',
      lane: 'deep',
      family: 'qwen',
      parameterSize: '27B',
      quantization: 'q4_k_m',
      ...sized(17741872154),
      contextLength: 32768,
      measuredTokensPerSec: 22.0,
      strengths: ['deep analytical deduction', 'code refactoring', 'mathematical proofs', 'deep context comprehension'],
      isPrimary: true,
    });

    this.register({
      id: 'qwen3:32b',
      name: 'Qwen 3 32B',
      lane: 'deep',
      lanes: ['deep', 'code'],
      family: 'qwen',
      parameterSize: '32B',
      quantization: 'q4_k_m',
      ...sized(20201253829),
      contextLength: 32768,
      measuredTokensPerSec: 18.0,
      strengths: ['precision engineering', 'full architecture design', 'multi-file refactoring', 'complex logic'],
      isPrimary: false,
    });

    this.register({
      id: 'rnogy/Nvidia_Llama-3_3-Nemotron-Super-49B-v1_5:q4_K_M',
      name: 'Llama 3.3 Nemotron Super 49B v1.5',
      lane: 'deep',
      family: 'nemotron',
      parameterSize: '49B',
      quantization: 'q4_k_m',
      ...sized(30215578984),
      contextLength: 131072,
      measuredTokensPerSec: 14.5,
      strengths: ['superior reasoning', 'complex agentic workflows', 'deep math and deduction'],
      isPrimary: false,
    });

    this.register({
      id: 'deepseek-r1:70b',
      name: 'DeepSeek R1 70B',
      lane: 'deep',
      family: 'deepseek',
      parameterSize: '70B',
      quantization: 'q4_k_m',
      ...sized(42520397873),
      contextLength: 32768,
      measuredTokensPerSec: 10.0,
      strengths: ['flagship chain-of-thought reasoning', 'mathematics', 'deductive logic', 'deep planning'],
      isPrimary: false,
      notes: 'Emits <think> tokens',
    });

    this.register({
      id: 'qwen3:72b',
      name: 'Qwen 3 72B',
      lane: 'deep',
      family: 'qwen',
      parameterSize: '72B',
      quantization: 'q4_k_m',
      ...sized(47415724625),
      contextLength: 32768,
      measuredTokensPerSec: 10.5,
      strengths: ['flagship synthesis', 'massive world knowledge', 'advanced reasoning'],
      isPrimary: false,
      notes: 'Barely fits the ~47.8 GiB Vulkan pool; the capability check refuses it whenever other weights are resident',
    });

    this.register({
      id: KIMI_REGISTRY_ID,
      name: 'Kimi Linear 48B-A3B Instruct',
      lane: 'deep',
      family: 'kimi',
      parameterSize: '48B (3B Active)',
      quantization: 'q4_k_m',
      // The downloader reports ~29.8 GB; no `/api/tags` size has been measured yet.
      diskSizeBytes: Math.round(29.8 * GIB),
      memoryRequirementBytes: estimateRequirementBytes(Math.round(29.8 * GIB)),
      contextLength: 1048576,
      measuredTokensPerSec: 0,
      strengths: ['1M extreme long context', 'efficient 3B active MoE inference', 'deep document analysis'],
      isPrimary: false,
      notes: 'Installed from a bartowski HF repo, so the Ollama tag differs from this id; see `canonicalizeTag`',
    });
  }

  /**
   * Registers a model. Registering an id that already exists never discards the earlier entry: from another
   * lane it only adds that lane; from the same lane it updates the entry's fields in place.
   */
  register(model: ModelDefinition): void {
    const key = canonicalizeTag(model.id);
    const existing = this.models.get(key);
    const incomingLanes = model.lanes ?? [model.lane];

    if (!existing) {
      this.models.set(key, { ...model, lanes: Array.from(new Set([model.lane, ...incomingLanes])) });
      return;
    }

    const lanes = Array.from(new Set([...(existing.lanes ?? [existing.lane]), model.lane, ...incomingLanes]));
    if (model.lane === existing.lane) {
      this.models.set(key, {
        ...model,
        strengths: Array.from(new Set([...existing.strengths, ...model.strengths])),
        isPrimary: existing.isPrimary || model.isPrimary,
        lanes,
      });
      return;
    }
    this.models.set(key, {
      ...existing,
      strengths: Array.from(new Set([...existing.strengths, ...model.strengths])),
      isPrimary: existing.isPrimary || model.isPrimary,
      lanes,
    });
  }

  getModel(id: string): ModelDefinition | null {
    return this.models.get(canonicalizeTag(id)) ?? null;
  }

  listModels(lane?: ModelLane): ModelDefinition[] {
    const list = Array.from(this.models.values());
    return lane ? list.filter((m) => servesLane(m, lane)) : list;
  }

  getPrimaryModelForLane(lane: ModelLane): ModelDefinition | null {
    return this.pickPrimary(this.listModels(lane), lane);
  }

  getAlternateModelForLane(lane: ModelLane, currentModelId: string): ModelDefinition | null {
    const current = canonicalizeTag(currentModelId);
    return this.listModels(lane).find((m) => canonicalizeTag(m.id) !== current) ?? null;
  }

  private pickPrimary(candidates: ModelDefinition[], lane: ModelLane): ModelDefinition | null {
    return candidates.find((m) => m.lane === lane && m.isPrimary) ?? candidates[0] ?? null;
  }

  /** True once a live installed list has been supplied; before that nothing can be called installed or missing. */
  hasInstalledInfo(): boolean {
    return this.installedKnown;
  }

  isInstalled(id: string): boolean {
    return this.installed.has(canonicalizeTag(id));
  }

  /** The tag Ollama knows the model by (differs from the registry id for aliased models such as Kimi). */
  getInstalledTag(id: string): string | null {
    return this.installed.get(canonicalizeTag(id))?.tag ?? null;
  }

  listInstalled(lane?: ModelLane): ModelDefinition[] {
    return this.listModels(lane).filter((m) => this.isInstalled(m.id));
  }

  getInstalledPrimaryForLane(lane: ModelLane): ModelDefinition | null {
    return this.pickPrimary(this.listInstalled(lane), lane);
  }

  /**
   * Replaces the installed snapshot with Ollama's real list: marks which registry models are installed,
   * overrides their memory requirement with the real on-disk size, registers unknown installed models with an
   * inferred lane, and maps aliased tags (Kimi) onto their registry entry.
   */
  reconcileInstalled(list: InstalledModelInfo[]): ReconcileReport {
    this.installed.clear();
    this.installedKnown = true;
    const matched: string[] = [];
    const added: string[] = [];

    for (const info of list) {
      if (!info.name) continue;
      const outcome = this.applyInstalled(info);
      (outcome.added ? added : matched).push(outcome.id);
    }

    const notInstalled = Array.from(this.models.values())
      .filter((m) => !this.isInstalled(m.id))
      .map((m) => m.id);
    return { matched, added, notInstalled };
  }

  /** Records one model as installed (e.g. right after an approved pull) without discarding the rest of the snapshot. */
  markInstalled(tag: string, sizeBytes?: number | null): ModelDefinition {
    this.installedKnown = true;
    const outcome = this.applyInstalled({ name: tag, size: sizeBytes ?? null });
    return this.models.get(canonicalizeTag(outcome.id))!;
  }

  private applyInstalled(info: InstalledModelInfo): { id: string; added: boolean } {
    const key = canonicalizeTag(info.name);
    const reportedSize = info.size ?? info.sizeBytes ?? null;
    const sizeBytes = typeof reportedSize === 'number' && Number.isFinite(reportedSize) && reportedSize > 0 ? reportedSize : null;
    this.installed.set(key, { tag: info.name, sizeBytes });

    const existing = this.models.get(key);
    if (existing) {
      if (sizeBytes !== null) {
        this.models.set(key, { ...existing, diskSizeBytes: sizeBytes, memoryRequirementBytes: estimateRequirementBytes(sizeBytes) });
      }
      return { id: existing.id, added: false };
    }

    const parameterSize = info.details?.parameter_size ?? info.parameterSize ?? null;
    const billions = parseParameterBillions(parameterSize ?? '') ?? parseParameterBillions(normalizeTag(info.name));
    const disk = sizeBytes ?? Math.round((billions ?? 7) * 0.6 * GIB);
    const lane = inferLane(info.name, sizeBytes);
    this.models.set(key, {
      id: info.name,
      name: info.name,
      lane,
      lanes: [lane],
      family: inferFamily(info.name, info.details?.family ?? info.family),
      parameterSize: parameterSize ?? (billions !== null ? `${billions}B` : 'unknown'),
      quantization: (info.details?.quantization_level ?? info.quantization ?? 'unknown').toLowerCase(),
      memoryRequirementBytes: estimateRequirementBytes(disk),
      diskSizeBytes: sizeBytes ?? undefined,
      contextLength: 8192,
      measuredTokensPerSec: 0,
      strengths: [],
      isPrimary: false,
      notes: sizeBytes === null ? 'Discovered from Ollama without a reported size; memory requirement is estimated' : 'Discovered from Ollama; lane inferred from name and size',
    });
    return { id: info.name, added: true };
  }
}
