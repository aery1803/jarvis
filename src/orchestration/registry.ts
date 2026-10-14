export type ModelLane = 'resident' | 'fast' | 'balanced' | 'deep' | 'vision' | 'code';

export interface ModelDefinition {
  id: string;
  name: string;
  lane: ModelLane;
  family: string;
  parameterSize: string;
  quantization: string;
  memoryRequirementBytes: number;
  contextLength: number;
  measuredTokensPerSec: number;
  strengths: string[];
  isPrimary: boolean;
  notes?: string;
}

export class ModelRegistry {
  private models: Map<string, ModelDefinition> = new Map();

  constructor() {
    this.registerDefaults();
  }

  private registerDefaults(): void {
    // 1. Fast / Autocomplete Lane - Verified on Radeon 8060S (141 t/s)
    this.register({
      id: 'qwen2.5-coder:1.5b',
      name: 'Qwen 2.5 Coder 1.5B',
      lane: 'code',
      family: 'qwen',
      parameterSize: '1.5B',
      quantization: 'q4_k_m',
      memoryRequirementBytes: 1.2 * 1024 * 1024 * 1024, // ~1.2 GB
      contextLength: 32768,
      measuredTokensPerSec: 141.0,
      strengths: ['code autocomplete', 'fast tool extraction', 'light reasoning'],
      isPrimary: true,
      notes: 'Ultra-fast autocomplete and lightweight agent worker',
    });

    // 2. Balanced / Reasoning Lane - Verified on Radeon 8060S (41.2 t/s)
    this.register({
      id: 'qwen2.5:7b',
      name: 'Qwen 2.5 7B Instruct',
      lane: 'balanced',
      family: 'qwen',
      parameterSize: '7B',
      quantization: 'q4_k_m',
      memoryRequirementBytes: 4.8 * 1024 * 1024 * 1024, // ~4.8 GB
      contextLength: 32768,
      measuredTokensPerSec: 41.2,
      strengths: ['deep reasoning', 'agent orchestration', 'fact synthesis', 'complex tool use'],
      isPrimary: true,
      notes: 'Primary reasoning and orchestration model',
    });

    // 3. Fast General Assistant Lane
    this.register({
      id: 'qwen2.5:3b',
      name: 'Qwen 2.5 3B',
      lane: 'fast',
      family: 'qwen',
      parameterSize: '3B',
      quantization: 'q4_k_m',
      memoryRequirementBytes: 2.2 * 1024 * 1024 * 1024,
      contextLength: 32768,
      measuredTokensPerSec: 85.0,
      strengths: ['general chat', 'summaries', 'email triage'],
      isPrimary: true,
    });

    // 4. Resident Embedding / Routing Lane
    this.register({
      id: 'nomic-embed-text:latest',
      name: 'Nomic Embed Text',
      lane: 'resident',
      family: 'nomic',
      parameterSize: '137M',
      quantization: 'q8_0',
      memoryRequirementBytes: 350 * 1024 * 1024, // ~350 MB
      contextLength: 8192,
      measuredTokensPerSec: 250.0,
      strengths: ['vector embeddings', 'semantic search'],
      isPrimary: true,
    });
  }

  register(model: ModelDefinition): void {
    this.models.set(model.id, model);
  }

  getModel(id: string): ModelDefinition | null {
    return this.models.get(id) ?? null;
  }

  listModels(lane?: ModelLane): ModelDefinition[] {
    const list = Array.from(this.models.values());
    if (lane) {
      return list.filter((m) => m.lane === lane);
    }
    return list;
  }

  getPrimaryModelForLane(lane: ModelLane): ModelDefinition | null {
    const laneModels = this.listModels(lane);
    const primary = laneModels.find((m) => m.isPrimary);
    return primary ?? laneModels[0] ?? null;
  }

  getAlternateModelForLane(lane: ModelLane, currentModelId: string): ModelDefinition | null {
    const laneModels = this.listModels(lane);
    const alt = laneModels.find((m) => m.id !== currentModelId);
    return alt ?? null;
  }
}
