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
   * Default baseline: Always run 7B models. Escalate to 30B/32B only for precise/heavy work.
   */
  classifyTask(prompt: string, explicitType?: string): { model: string; category: 'precision' | 'code' | 'reasoning' | 'chat' | 'vision'; is30BClass: boolean; rationale: string } {
    const lower = prompt.toLowerCase();

    // 0. Precision & Heavy Engineering Work -> 30B-Class Model (PHASE_0_SPEC.md Section 1.1)
    const precisionRegex = /\b(precise|precision|30b|32b|full architecture|system blueprint|heavy refactor|multi-file|rigorous proof|deep math|production grade)\b/i;
    if (explicitType === 'precision' || explicitType === '30b' || precisionRegex.test(lower)) {
      return {
        model: 'qwen2.5-coder:32b',
        category: 'precision',
        is30BClass: true,
        rationale: 'Heavy 30B-class precision model from initial concept doc for complex architecture and precision engineering.',
      };
    }

    // 1. Standard Code / Script Tasks -> Resident 7B Coder
    const codeRegex = /\b(code|coding|script|scripts|function|def|python|typescript|javascript|powershell|bash|sql|bug|debug|fix|refactor|rewrite|tests?|implement|database|endpoints?|git)\b/i;
    if (explicitType === 'code' || codeRegex.test(lower)) {
      return {
        model: 'qwen2.5-coder:7b',
        category: 'code',
        is30BClass: false,
        rationale: 'Resident 7B coding engine with full tool and filesystem access.',
      };
    }

    // 2. Reasoning & Logic Tasks -> 7B Reasoning
    const reasoningRegex = /\b(why|math|calculate|deduce|deduction|logic|puzzle|prove|proof|architecture|compare|analyze|synthesize|strategy|reasoning)\b/i;
    if (explicitType === 'reasoning' || reasoningRegex.test(lower)) {
      return {
        model: 'deepseek-r1:7b',
        category: 'reasoning',
        is30BClass: false,
        rationale: '7B reasoning engine with chain-of-thought logic synthesis.',
      };
    }

    // 3. Vision / Image
    const visionKeywords = ['image', 'photo', 'picture', 'screenshot', 'diagram', 'ocr'];
    if (explicitType === 'vision' || visionKeywords.some((k) => lower.includes(k))) {
      return {
        model: 'llava:7b',
        category: 'vision',
        is30BClass: false,
        rationale: 'Vision-language model for multimodal image understanding.',
      };
    }

    // 4. Default Always-Running Resident 7B Model (Access to everything)
    return {
      model: 'qwen2.5:7b',
      category: 'chat',
      is30BClass: false,
      rationale: 'Resident 7B general orchestrator model with full access to memory, tools, and system state.',
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
