/**
 * Jarvis Local AI: Dynamic Model Provisioner & Task Dispatcher
 * Authority: Initial Concept Document (PHASE_0_SPEC.md & jarvis-master-context.md)
 * 
 * Rules:
 * 1. Default Baseline: Always run resident 7B parameter models (qwen2.5:7b / qwen2.5-coder:7b)
 *    which have complete access to memory, tools, filesystem, devagent, and system stats.
 * 2. Precision Escalation: For precise work, complex multi-file engineering, mathematical proofs,
 *    or heavy architecture, escalate to the 30B/32B-class model (qwen2.5-coder:32b).
 * 3. On-Demand Auto-Pull: Auto-downloads missing models on-demand, executes, and returns.
 */

import { LLMProvider } from '../services/provider.js';
import { logger } from '../utils/logger.js';

export interface ProvisionRequest {
  prompt: string;
  taskType?: 'chat' | 'code' | 'reasoning' | 'precision' | 'vision' | 'embedding' | 'auto';
  onProgress?: (message: string) => Promise<void> | void;
}

export interface ProvisionDecision {
  targetModel: string;
  category: 'precision' | 'code' | 'reasoning' | 'chat' | 'vision';
  is30BClass: boolean;
  wasInstalledOnDemand: boolean;
  rationale: string;
}

export class ModelProvisioner {
  constructor(private provider: LLMProvider) {}

  /**
   * Determine the best specialized model for the given task prompt.
   * Default baseline: Always run Qwen 3 8B model which has full access to memory, tools, and system state.
   * Escalate to 32B/49B/70B only for precise/heavy analytical and architecture work.
   */
  classifyTask(prompt: string, explicitType?: string): { model: string; category: 'precision' | 'code' | 'reasoning' | 'chat' | 'vision'; is30BClass: boolean; rationale: string } {
    const lower = prompt.toLowerCase();

    // 0. Flagship Deep Reasoning & Math -> DeepSeek R1 70B or Nemotron 49B
    const deepReasoningRegex = /\b(deepseek|r1|70b|nemotron|49b|deep math|rigorous proof|symbolic logic|formal proof|complex deduction)\b/i;
    if (explicitType === 'deepseek' || explicitType === '70b' || explicitType === 'nemotron' || deepReasoningRegex.test(lower)) {
      return {
        model: 'deepseek-r1:70b',
        category: 'reasoning',
        is30BClass: true,
        rationale: 'Flagship 70B deep reasoning model with chain-of-thought verification.',
      };
    }

    // 1. Precision & Heavy Engineering Work -> 30B/32B-Class Model (Qwen 3 32B)
    const precisionRegex = /\b(precise|precision|30b|32b|full architecture|system blueprint|heavy refactor|multi-file|production grade)\b/i;
    if (explicitType === 'precision' || explicitType === '30b' || explicitType === '32b' || precisionRegex.test(lower)) {
      return {
        model: 'qwen3:32b',
        category: 'precision',
        is30BClass: true,
        rationale: 'Heavy 32B-class precision model for complex architecture and multi-file engineering.',
      };
    }

    // 2. Mid-Tier Analytical Reasoning -> Qwen 3 14B or Qwen 3.8 27B
    const midReasoningRegex = /\b(analyze|compare|evaluate|deduce|strategy|synthesis|deep analysis)\b/i;
    if (explicitType === 'reasoning' || midReasoningRegex.test(lower)) {
      return {
        model: 'qwen3:14b',
        category: 'reasoning',
        is30BClass: false,
        rationale: 'High-intelligence 14B reasoning model for analytical synthesis.',
      };
    }

    // 3. Standard Code / Script Tasks -> Resident Qwen 3 8B
    const codeRegex = /\b(code|coding|script|scripts|function|def|python|typescript|javascript|powershell|bash|sql|bug|debug|fix|refactor|rewrite|tests?|implement|database|endpoints?|git)\b/i;
    if (explicitType === 'code' || codeRegex.test(lower)) {
      return {
        model: 'qwen3:8b',
        category: 'code',
        is30BClass: false,
        rationale: 'Resident Qwen 3 8B coding engine with full tool and filesystem access.',
      };
    }

    // 4. Vision / Image
    const visionKeywords = ['image', 'photo', 'picture', 'screenshot', 'diagram', 'ocr'];
    if (explicitType === 'vision' || visionKeywords.some((k) => lower.includes(k))) {
      return {
        model: 'llava:7b',
        category: 'vision',
        is30BClass: false,
        rationale: 'Vision-language model for multimodal image understanding.',
      };
    }

    // 5. Default Always-Running Resident Model: Qwen 3 8B (Starting Model with Access to Everything)
    return {
      model: 'qwen3:8b',
      category: 'chat',
      is30BClass: false,
      rationale: 'Resident Qwen 3 8B starting orchestrator model with full access to memory, tools, and system state.',
    };
  }

  /**
   * Resolves the target model, verifies installation in Ollama, and auto-pulls on-demand if missing.
   */
  async ensureAndDispatch(request: ProvisionRequest): Promise<ProvisionDecision> {
    const classification = this.classifyTask(request.prompt, request.taskType);
    const targetModel = classification.model;

    // Check installed models
    const installedModels = this.provider.listModels ? await this.provider.listModels() : [];
    const isInstalled = installedModels.some((m) => m === targetModel || m.startsWith(`${targetModel}:`));

    if (isInstalled) {
      if (this.provider.setModel) {
        this.provider.setModel(targetModel);
      }
      return {
        targetModel,
        category: classification.category,
        is30BClass: classification.is30BClass,
        wasInstalledOnDemand: false,
        rationale: `${classification.rationale} (Already installed).`,
      };
    }

    // If not installed, trigger on-demand auto-pull
    if (this.provider.pullModel) {
      logger.info(`[ModelProvisioner] Target model ${targetModel} not found. Triggering on-demand auto-pull...`);
      const pullLabel = classification.is30BClass
        ? `📥 *Precision work detected:* Escalating to 30B-class model (\`${targetModel}\`) from concept doc.\nAuto-downloading to Radeon 8060S GPU (fits in 46.5 GB Vulkan pool)...`
        : `📥 *Specialized model needed:* \`${targetModel}\` for ${classification.category} task.\nAuto-downloading on-demand to your Radeon 8060S GPU...`;

      await request.onProgress?.(pullLabel);

      const pullSuccess = await this.provider.pullModel(targetModel);
      if (pullSuccess) {
        if (this.provider.setModel) {
          this.provider.setModel(targetModel);
        }
        await request.onProgress?.(`✅ *Model installed successfully:* \`${targetModel}\`. Executing precise task now...`);
        return {
          targetModel,
          category: classification.category,
          is30BClass: classification.is30BClass,
          wasInstalledOnDemand: true,
          rationale: `${classification.rationale} (Installed on-demand).`,
        };
      }
    }

    // Fallback: If 30B pull fails or not ready, fallback to resident 7B coder/reasoner
    const fallback = classification.category === 'code' || classification.category === 'precision'
      ? 'qwen2.5-coder:7b'
      : 'qwen2.5:7b';

    if (this.provider.setModel) {
      this.provider.setModel(fallback);
    }
    return {
      targetModel: fallback,
      category: classification.category,
      is30BClass: false,
      wasInstalledOnDemand: false,
      rationale: `${classification.rationale} (Fallback to resident 7B ${fallback}).`,
    };
  }
}
