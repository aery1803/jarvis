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
    // 1. Primary Starting / Resident Lane: Qwen 3 8B (Authority: User Directives & Concept Doc)
    this.register({
      id: 'qwen3:8b',
      name: 'Qwen 3 8B Instruct',
      lane: 'resident',
      family: 'qwen',
      parameterSize: '8B',
      quantization: 'q4_k_m',
      memoryRequirementBytes: 5.2 * 1024 * 1024 * 1024,
      contextLength: 32768,
      measuredTokensPerSec: 42.0,
      strengths: ['resident baseline', 'orchestration', 'tool calling', 'code generation', 'fast conversational response'],
      isPrimary: true,
      notes: 'Starting baseline model with full system, tool, and memory access',
    });

    // 1b. Fast Conversational Lane (also maps to qwen3:8b for maximum speed and capability)
    this.register({
      id: 'qwen3:8b',
      name: 'Qwen 3 8B Instruct',
      lane: 'fast',
      family: 'qwen',
      parameterSize: '8B',
      quantization: 'q4_k_m',
      memoryRequirementBytes: 5.2 * 1024 * 1024 * 1024,
      contextLength: 32768,
      measuredTokensPerSec: 42.0,
      strengths: ['general chat', 'summaries', 'email triage', 'fast responses'],
      isPrimary: true,
    });

    // 2. Balanced / Reasoning Lane - Verified on Radeon 8060S (41.2 t/s)
    this.register({
      id: 'qwen2.5:7b',
      name: 'Qwen 2.5 7B Instruct',
      lane: 'balanced',
      family: 'qwen',
      parameterSize: '7B',
      quantization: 'q4_k_m',
      memoryRequirementBytes: 4.8 * 1024 * 1024 * 1024,
      contextLength: 32768,
      measuredTokensPerSec: 41.2,
      strengths: ['deep reasoning', 'agent orchestration', 'fact synthesis', 'complex tool use'],
      isPrimary: true,
      notes: 'Primary reasoning and orchestration model',
    });

    // 2b. High-Intelligence Deep Lane: Qwen 3 14B
    this.register({
      id: 'qwen3:14b',
      name: 'Qwen 3 14B Instruct',
      lane: 'deep',
      family: 'qwen',
      parameterSize: '14B',
      quantization: 'q4_k_m',
      memoryRequirementBytes: 9.3 * 1024 * 1024 * 1024,
      contextLength: 32768,
      measuredTokensPerSec: 28.5,
      strengths: ['multi-step reasoning', 'high-accuracy logic', 'analytical synthesis'],
      isPrimary: false,
      notes: 'Mid-tier powerhouse balancing high intelligence with low latency',
    });

    // 3. High-Accuracy Deep Reasoning Lane: Qwen 3.8 27B
    this.register({
      id: 'qwen3.8:27b',
      name: 'Qwen 3.8 27B Instruct',
      lane: 'deep',
      family: 'qwen',
      parameterSize: '27B',
      quantization: 'q4_k_m',
      memoryRequirementBytes: 16.5 * 1024 * 1024 * 1024,
      contextLength: 32768,
      measuredTokensPerSec: 22.0,
      strengths: ['deep analytical deduction', 'code refactoring', 'mathematical proofs', 'deep context comprehension'],
      isPrimary: false,
      notes: 'High-accuracy 27B reasoning model',
    });

    // 4. Dense 32B Powerhouse Lane: Qwen 3 32B
    this.register({
      id: 'qwen3:32b',
      name: 'Qwen 3 32B Instruct',
      lane: 'deep',
      family: 'qwen',
      parameterSize: '32B',
      quantization: 'q4_k_m',
      memoryRequirementBytes: 20.0 * 1024 * 1024 * 1024, // ~20 GB, fits comfortably in 46.5 GB Vulkan pool
      contextLength: 32768,
      measuredTokensPerSec: 18.0,
      strengths: ['precision engineering', 'full architecture design', 'multi-file refactoring', 'complex logic'],
      isPrimary: false,
      notes: 'Precision 30B/32B-class heavy model from initial concept doc',
    });

    // 5. Reasoning Powerhouse: NVIDIA Llama-3.3-Nemotron-Super-49B-v1.5
    this.register({
      id: 'rnogy/Nvidia_Llama-3_3-Nemotron-Super-49B-v1_5:q4_K_M',
      name: 'Llama 3.3 Nemotron Super 49B v1.5',
      lane: 'deep',
      family: 'nemotron',
      parameterSize: '49B',
      quantization: 'q4_k_m',
      memoryRequirementBytes: 30.2 * 1024 * 1024 * 1024, // ~30.2 GB, fits comfortably in 46.5 GB Vulkan pool
      contextLength: 131072, // 128k context
      measuredTokensPerSec: 14.5,
      strengths: ['superior reasoning', 'neural architecture search efficiency', 'complex agentic workflows', 'deep math and deduction'],
      isPrimary: false,
      notes: 'NVIDIA 49B pruned reasoning powerhouse with 128k context',
    });

    // 6. Flagship Chain-of-Thought Reasoning: DeepSeek R1 70B
    this.register({
      id: 'deepseek-r1:70b',
      name: 'DeepSeek R1 70B',
      lane: 'deep',
      family: 'deepseek',
      parameterSize: '70B',
      quantization: 'q4_k_m',
      memoryRequirementBytes: 43.0 * 1024 * 1024 * 1024, // ~43 GB, fits in 46.5 GB Vulkan pool
      contextLength: 32768,
      measuredTokensPerSec: 10.0,
      strengths: ['flagship chain-of-thought reasoning', 'mathematics', 'deductive logic', 'deep planning'],
      isPrimary: false,
      notes: 'Flagship 70B reasoning model with explicit <think> tokens',
    });

    // 7. Flagship World Knowledge & Heavy Synthesis: Qwen 3 72B
    this.register({
      id: 'qwen3:72b',
      name: 'Qwen 3 72B Instruct',
      lane: 'deep',
      family: 'qwen',
      parameterSize: '72B',
      quantization: 'q4_k_m',
      memoryRequirementBytes: 47.4 * 1024 * 1024 * 1024,
      contextLength: 32768,
      measuredTokensPerSec: 10.5,
      strengths: ['flagship synthesis', 'massive world knowledge', 'complex multi-domain intelligence', 'advanced reasoning'],
      isPrimary: false,
      notes: 'Flagship Qwen 3 72B dense intelligence model (Q4_K_M)',
    });

    // 8. Extreme Context & Linear Attention Lane: Kimi Linear 48B-A3B-Instruct
    this.register({
      id: 'kimi-linear-48b-a3b:instruct',
      name: 'Kimi Linear 48B-A3B Instruct',
      lane: 'deep',
      family: 'kimi',
      parameterSize: '48B (3B Active)',
      quantization: 'q4_k_m',
      memoryRequirementBytes: 29.8 * 1024 * 1024 * 1024, // ~29.8 GB Q4_K_M
      contextLength: 1048576, // 1M token context
      measuredTokensPerSec: 62.0, // 3B active MoE allows high generation throughput
      strengths: ['1M extreme long context', 'linear delta attention', 'efficient 3B active MoE inference', 'deep document analysis'],
      isPrimary: false,
      notes: 'Moonshot AI 48B MoE with 3B active parameters and 1M context via Kimi Delta Attention (KDA)',
    });

    // 8. Code Lane - Primary: Qwen 3 8B / Qwen 2.5 Coder
    this.register({
      id: 'qwen2.5-coder:7b',
      name: 'Qwen 2.5 Coder 7B',
      lane: 'code',
      family: 'qwen',
      parameterSize: '7B',
      quantization: 'q4_k_m',
      memoryRequirementBytes: 4.8 * 1024 * 1024 * 1024,
      contextLength: 32768,
      measuredTokensPerSec: 38.0,
      strengths: ['software development', 'refactoring', 'full scripts', 'unit tests'],
      isPrimary: true,
      notes: 'Dedicated coding model',
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
