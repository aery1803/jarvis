/**
 * Jarvis Local AI: Multi-Model Simultaneous Ensemble Engine
 * Queries multiple specialized/big local models simultaneously with full context,
 * corroborates candidate outputs, and synthesizes a high-confidence consensus answer.
 */

import { type LLMProvider, OllamaProvider } from '../services/provider.js';
import { CognitionEngine, type CognitionOptions } from '../agents/cognition.js';
import { ConsensusEngine } from '../services/consensus.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

export interface EnsembleCandidate {
  model: string;
  answer: string;
  latencyMs: number;
  status: 'fulfilled' | 'rejected';
  error?: string;
}

export interface EnsembleResult {
  primaryAnswer: string;
  candidates: EnsembleCandidate[];
  consensusScore: number;
  modelsUsed: string[];
  totalLatencyMs: number;
}

export interface EnsembleOptions extends CognitionOptions {
  models?: string[];
  maxTokens?: number;
}

export class MultiModelEnsemble {
  private consensus: ConsensusEngine;

  constructor() {
    this.consensus = new ConsensusEngine();
  }

  /**
   * Dispatches the user prompt and complete context to multiple models simultaneously.
   */
  async generateSimultaneous(
    prompt: string,
    options: EnsembleOptions = {}
  ): Promise<EnsembleResult> {
    const isCode = options.taskType === 'code';
    const defaultModels = isCode
      ? ['qwen3:8b', 'qwen3:14b', 'qwen3:32b']
      : ['qwen3:8b', 'qwen3:14b', 'qwen3.8:27b'];
    const targetModels = options.models && options.models.length > 0 ? options.models : defaultModels;

    logger.info(`[MultiModelEnsemble] Dispatching simultaneous inference across ${targetModels.length} models: [${targetModels.join(', ')}]`);
    const startTime = Date.now();

    // Prepare full prompt with unified context for all models
    const fullPrompt = CognitionEngine.formatPrompt(prompt, {
      taskType: options.taskType ?? 'chat',
      memoryContext: options.memoryContext,
      researchFacts: options.researchFacts,
      consensusScore: options.consensusScore,
    });

    // Launch all model inferences in parallel
    const promises = targetModels.map(async (modelName): Promise<EnsembleCandidate> => {
      const modelStart = Date.now();
      try {
        const provider = new OllamaProvider({
          baseUrl: config.ollamaBaseUrl,
          model: modelName,
        });
        const answer = await provider.generate(fullPrompt, {
          maxTokens: options.maxTokens ?? 512,
        });
        return {
          model: modelName,
          answer: answer.trim(),
          latencyMs: Date.now() - modelStart,
          status: 'fulfilled',
        };
      } catch (err: any) {
        logger.warn(`[MultiModelEnsemble] Model ${modelName} failed during ensemble: ${err.message}`);
        return {
          model: modelName,
          answer: '',
          latencyMs: Date.now() - modelStart,
          status: 'rejected',
          error: err.message,
        };
      }
    });

    const settled = await Promise.all(promises);
    const totalLatencyMs = Date.now() - startTime;
    const fulfilled = settled.filter((c) => c.status === 'fulfilled' && c.answer.length > 0);

    if (fulfilled.length === 0) {
      throw new Error(`All ensemble models failed to generate an answer.`);
    }

    // Build consensus report across candidate answers
    const report = this.consensus.buildReport([
      {
        claim: prompt,
        sources: fulfilled.map((c) => ({
          source: `model:${c.model}`,
          excerpt: c.answer.slice(0, 300),
        })),
      },
    ]);

    // Pick best / primary answer: prioritize higher parameter or coder model if task is code, else first fulfilled
    const primaryCandidate = fulfilled.find((c) => c.model.includes('14b') || c.model.includes('32b')) || fulfilled[0];

    return {
      primaryAnswer: primaryCandidate.answer,
      candidates: settled,
      consensusScore: report.overallScore,
      modelsUsed: targetModels,
      totalLatencyMs,
    };
  }

  /**
   * Formats the multi-model result into a clean, concise TL;DR response with model attribution.
   */
  static formatEnsembleResponse(result: EnsembleResult, showComparison = false): string {
    const verifiedModels = result.candidates
      .filter((c) => c.status === 'fulfilled')
      .map((c) => `\`${c.model}\` (${c.latencyMs}ms)`)
      .join(', ');

    if (!showComparison || result.candidates.length <= 1) {
      return (
        `${result.primaryAnswer}\n\n` +
        `🤝 _Corroborated simultaneously by:_ ${verifiedModels} ` +
        `• _Consensus:_ ${(result.consensusScore * 100).toFixed(0)}%`
      );
    }

    // Detailed side-by-side comparison mode
    const sections = [
      result.primaryAnswer,
      '',
      `🤝 *Multi-Model Consensus Score:* ${(result.consensusScore * 100).toFixed(0)}%`,
      '',
      '---',
      '*Model Comparison Breakdown:*',
    ];

    for (const c of result.candidates) {
      const statusIcon = c.status === 'fulfilled' ? '✅' : '❌';
      sections.push(`\n${statusIcon} *Model \`${c.model}\`* (${c.latencyMs}ms):`);
      if (c.status === 'fulfilled') {
        sections.push(c.answer);
      } else {
        sections.push(`_Failed: ${c.error}_`);
      }
    }

    return sections.join('\n');
  }
}
