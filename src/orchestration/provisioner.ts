/**
 * Jarvis Local AI: Dynamic Model Provisioner & Task Dispatcher
 * Takes incoming requests, dynamically analyzes what specialized model is required,
 * verifies if it is installed, automatically pulls it on-demand if missing,
 * and routes execution to that model.
 */

import { LLMProvider } from '../services/provider.js';
import { logger } from '../utils/logger.js';

export interface ProvisionRequest {
  prompt: string;
  taskType?: 'chat' | 'code' | 'reasoning' | 'vision' | 'embedding' | 'auto';
  onProgress?: (message: string) => Promise<void> | void;
}

export interface ProvisionDecision {
  targetModel: string;
  category: 'code' | 'reasoning' | 'chat' | 'vision';
  wasInstalledOnDemand: boolean;
  rationale: string;
}

export class ModelProvisioner {
  constructor(private provider: LLMProvider) {}

  /**
   * Determine the best specialized model for the given task prompt.
   */
  classifyTask(prompt: string, explicitType?: string): { model: string; category: 'code' | 'reasoning' | 'chat' | 'vision'; rationale: string } {
    const lower = prompt.toLowerCase();

    // 1. Code / Script Generation / Refactoring
    const codeRegex = /\b(code|coding|script|scripts|function|def|python|typescript|javascript|powershell|bash|sql|bug|debug|fix|refactor|rewrite|tests?|implement|database|endpoints?|git)\b/i;
    if (explicitType === 'code' || codeRegex.test(lower)) {
      return {
        model: 'qwen2.5-coder:7b',
        category: 'code',
        rationale: 'Specialized 7B coding engine for script execution, refactoring, and software tasks.',
      };
    }

    // 2. Deep Reasoning / Math / Logic / Architecture
    const reasoningRegex = /\b(why|math|calculate|deduce|deduction|logic|puzzle|prove|proof|architecture|compare|analyze|synthesize|strategy|reasoning)\b/i;
    if (explicitType === 'reasoning' || reasoningRegex.test(lower)) {
      return {
        model: 'deepseek-r1:7b',
        category: 'reasoning',
        rationale: 'Deep reasoning engine with chain-of-thought logic synthesis.',
      };
    }

    // 3. Vision / Image
    const visionKeywords = ['image', 'photo', 'picture', 'screenshot', 'diagram', 'ocr'];
    if (explicitType === 'vision' || visionKeywords.some((k) => lower.includes(k))) {
      return {
        model: 'llava:7b',
        category: 'vision',
        rationale: 'Vision-language model for multimodal image understanding.',
      };
    }

    // 4. Default Balanced Assistant
    return {
      model: 'qwen2.5:7b',
      category: 'chat',
      rationale: 'Balanced general conversational and orchestration model.',
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
        wasInstalledOnDemand: false,
        rationale: `${classification.rationale} (Already installed).`,
      };
    }

    // If not installed, trigger on-demand auto-pull
    if (this.provider.pullModel) {
      logger.info(`[ModelProvisioner] Target model ${targetModel} not found. Triggering on-demand auto-pull...`);
      await request.onProgress?.(`📥 *Specialized model needed:* \`${targetModel}\` for ${classification.category} task.\nAuto-downloading on-demand to your Radeon 8060S GPU...`);

      const pullSuccess = await this.provider.pullModel(targetModel);
      if (pullSuccess) {
        if (this.provider.setModel) {
          this.provider.setModel(targetModel);
        }
        await request.onProgress?.(`✅ *Model installed successfully:* \`${targetModel}\`. Executing your task now...`);
        return {
          targetModel,
          category: classification.category,
          wasInstalledOnDemand: true,
          rationale: `${classification.rationale} (Installed on-demand).`,
        };
      }
    }

    // If pull fails or not supported, fall back to best installed alternative
    const fallback = classification.category === 'code' ? 'qwen2.5-coder:1.5b' : 'qwen2.5:7b';
    if (this.provider.setModel) {
      this.provider.setModel(fallback);
    }
    return {
      targetModel: fallback,
      category: classification.category,
      wasInstalledOnDemand: false,
      rationale: `${classification.rationale} (Fallback to ${fallback}).`,
    };
  }
}
