/**
 * Jarvis Local AI: Multi-Model Ensemble Engine
 * Queries several local models one at a time (the governor allows a single heavy model), scores how much their
 * answers actually agree, and returns the answer the others agree with most.
 */

import { type LLMProvider, OllamaProvider } from '../services/provider.js';
import { CognitionEngine, type CognitionOptions } from '../agents/cognition.js';
import { ConsensusEngine } from '../services/consensus.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { probeOllama } from '../web/diagnostics.js';
import { CapabilityChecker } from './capability.js';
import { LeaseDeniedError, MemoryGovernor } from './governor.js';
import type { InstalledModelInfo } from './lanes.js';
import { ModelRegistry, type ModelDefinition } from './registry.js';
import { getSharedVramProbe, installedFromDiagnostics } from './vram.js';

export interface EnsembleCandidate {
  model: string;
  answer: string;
  latencyMs: number;
  status: 'fulfilled' | 'rejected' | 'skipped';
  error?: string;
  /** Mean lexical similarity of this answer to the other answers, 0..1; absent when fewer than two answered. */
  agreement?: number;
}

export interface EnsembleResult {
  primaryAnswer: string;
  candidates: EnsembleCandidate[];
  /** Lexical agreement between the answers, 0..1. 0 when fewer than two models answered (nothing to compare). */
  consensusScore: number;
  /** Models that actually produced an answer. */
  modelsUsed: string[];
  totalLatencyMs: number;
  primaryModel?: string;
  /** True only when at least two models answered. */
  corroborated?: boolean;
  skipped?: Array<{ model: string; reason: string }>;
}

export interface EnsembleOptions extends CognitionOptions {
  models?: string[];
  maxTokens?: number;
  /** Per-model wait for the heavy-model lease. */
  leaseTimeoutMs?: number;
}

export interface MultiModelEnsembleOptions {
  registry?: ModelRegistry;
  governor?: MemoryGovernor;
  providerFactory?: (modelTag: string) => LLMProvider;
  /** Installed models with sizes; defaults to Ollama's `/api/tags` via `probeOllama`. Null/throw means unknown. */
  getInstalled?: () => Promise<InstalledModelInfo[] | null>;
  getVramFreeBytes?: () => Promise<number | null>;
  consensus?: ConsensusEngine;
}

function tokenSet(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

/** Jaccard similarity of word sets: 1 for identical vocabulary, 0 for disjoint. */
export function lexicalSimilarity(a: string, b: string): number {
  const sa = tokenSet(a);
  const sb = tokenSet(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  let shared = 0;
  for (const t of sa) if (sb.has(t)) shared += 1;
  return shared / (sa.size + sb.size - shared);
}

export class MultiModelEnsemble {
  private consensus: ConsensusEngine;
  private registry: ModelRegistry;
  private governor: MemoryGovernor;
  private manageVram: boolean;

  constructor(private options: MultiModelEnsembleOptions = {}) {
    this.consensus = options.consensus ?? new ConsensusEngine();
    this.registry = options.registry ?? new ModelRegistry();
    this.governor = options.governor ?? new MemoryGovernor({ capabilityChecker: new CapabilityChecker({ unknownVramPolicy: 'allow' }) });
    this.manageVram = options.getVramFreeBytes !== undefined || !options.governor;
  }

  private async refreshInstalled(): Promise<void> {
    try {
      let list: InstalledModelInfo[] | null;
      if (this.options.getInstalled) {
        list = await this.options.getInstalled();
      } else {
        const probe = await probeOllama(config.ollamaBaseUrl);
        list = probe.reachable ? installedFromDiagnostics(probe.installed) : null;
      }
      if (list) this.registry.reconcileInstalled(list);
    } catch (err: unknown) {
      logger.warn(`[MultiModelEnsemble] Could not read installed models: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Runs each candidate model in turn through the governor and scores agreement between the answers. */
  async generateSimultaneous(prompt: string, options: EnsembleOptions = {}): Promise<EnsembleResult> {
    const isCode = options.taskType === 'code';
    const defaultModels = isCode ? ['qwen3:8b', 'qwen3:14b', 'qwen3:32b'] : ['qwen3:8b', 'qwen3:14b', 'qwen3.8:27b'];
    const targetModels = options.models && options.models.length > 0 ? options.models : defaultModels;
    const startTime = Date.now();

    await this.refreshInstalled();
    if (this.manageVram) {
      const probe = this.options.getVramFreeBytes ?? getSharedVramProbe();
      this.governor.getChecker().setVramFree(await probe().catch(() => null));
    }

    const fullPrompt = CognitionEngine.formatPrompt(prompt, {
      taskType: options.taskType ?? 'chat',
      memoryContext: options.memoryContext,
      researchFacts: options.researchFacts,
      consensusScore: options.consensusScore,
    });

    const settled: EnsembleCandidate[] = [];
    const definitions = new Map<string, ModelDefinition>();
    const skipped: Array<{ model: string; reason: string }> = [];
    const skip = (model: string, reason: string) => {
      skipped.push({ model, reason });
      settled.push({ model, answer: '', latencyMs: 0, status: 'skipped', error: reason });
    };

    for (const modelName of targetModels) {
      const def = this.registry.getModel(modelName);
      if (!def) {
        skip(modelName, 'unknown model: its memory requirement cannot be budgeted');
        continue;
      }
      if (this.registry.hasInstalledInfo() && !this.registry.isInstalled(def.id)) {
        skip(modelName, 'not installed');
        continue;
      }
      definitions.set(modelName, def);

      const tag = this.registry.getInstalledTag(def.id) ?? def.id;
      const modelStart = Date.now();
      try {
        const provider = this.options.providerFactory
          ? this.options.providerFactory(tag)
          : new OllamaProvider({ baseUrl: config.ollamaBaseUrl, model: tag });
        const answer = await this.governor.withLease(def, () => provider.generate(fullPrompt, { maxTokens: options.maxTokens ?? 512 }), {
          timeoutMs: options.leaseTimeoutMs,
        });
        settled.push({ model: modelName, answer: answer.trim(), latencyMs: Date.now() - modelStart, status: 'fulfilled' });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof LeaseDeniedError) {
          definitions.delete(modelName);
          skip(modelName, err.reason);
          continue;
        }
        logger.warn(`[MultiModelEnsemble] Model ${modelName} failed during ensemble: ${message}`);
        settled.push({
          model: modelName,
          answer: '',
          latencyMs: Date.now() - modelStart,
          status: 'rejected',
          error: message,
        });
      }
    }

    const totalLatencyMs = Date.now() - startTime;
    const fulfilled = settled.filter((c) => c.status === 'fulfilled' && c.answer.length > 0);

    if (fulfilled.length === 0) {
      const detail = settled.map((c) => `${c.model}: ${c.error ?? 'empty answer'}`).join('; ');
      throw new Error(`All ensemble models failed to generate an answer. ${detail}`);
    }

    let agreementScore = 0;
    if (fulfilled.length >= 2) {
      let pairSum = 0;
      let pairs = 0;
      for (let i = 0; i < fulfilled.length; i += 1) {
        let rowSum = 0;
        for (let j = 0; j < fulfilled.length; j += 1) {
          if (i === j) continue;
          const sim = lexicalSimilarity(fulfilled[i].answer, fulfilled[j].answer);
          rowSum += sim;
          if (j > i) {
            pairSum += sim;
            pairs += 1;
          }
        }
        fulfilled[i].agreement = rowSum / (fulfilled.length - 1);
      }
      agreementScore = pairSum / pairs;

      try {
        const report = this.consensus.buildReport([
          {
            claim: prompt,
            sources: fulfilled.map((c) => ({ source: `model:${c.model}`, excerpt: c.answer.slice(0, 300) })),
          },
        ]);
        if (report.disputedClaimsCount > 0 && Number.isFinite(report.overallScore)) {
          agreementScore = Math.min(agreementScore, Math.max(0, Math.min(1, report.overallScore)));
        }
      } catch (err: unknown) {
        logger.warn(`[MultiModelEnsemble] Consensus report unavailable: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Highest agreement with the other answers wins; ties go to the larger model, then to the earlier one.
    const memoryOf = (c: EnsembleCandidate) => definitions.get(c.model)?.memoryRequirementBytes ?? 0;
    const primary = fulfilled.reduce((best, c) => {
      const a = c.agreement ?? 0;
      const b = best.agreement ?? 0;
      if (a > b + 1e-9) return c;
      if (Math.abs(a - b) <= 1e-9 && memoryOf(c) > memoryOf(best)) return c;
      return best;
    });

    return {
      primaryAnswer: primary.answer,
      primaryModel: primary.model,
      candidates: settled,
      consensusScore: Number(agreementScore.toFixed(2)),
      corroborated: fulfilled.length >= 2,
      modelsUsed: fulfilled.map((c) => c.model),
      skipped,
      totalLatencyMs,
    };
  }

  /** Formats the multi-model result with model attribution; shows an agreement figure only when two or more models answered. */
  static formatEnsembleResponse(result: EnsembleResult, showComparison = false): string {
    const answered = result.candidates.filter((c) => c.status === 'fulfilled');
    const verifiedModels = answered.map((c) => `\`${c.model}\` (${c.latencyMs}ms)`).join(', ');
    const corroborated = result.corroborated ?? answered.length >= 2;
    const agreement = corroborated
      ? `Answer agreement: ${(result.consensusScore * 100).toFixed(0)}% (word overlap between models, not a fact check)`
      : 'Not corroborated: only one model answered';
    const skippedNote = (result.skipped ?? []).map((s) => `\`${s.model}\` skipped (${s.reason})`).join(', ');

    if (!showComparison || result.candidates.length <= 1) {
      return (
        `${result.primaryAnswer}\n\n` +
        `Answered in turn by: ${verifiedModels} - ${agreement}` +
        (skippedNote ? `\n_${skippedNote}_` : '')
      );
    }

    const sections = [result.primaryAnswer, '', agreement, '', '---', '*Model Comparison Breakdown:*'];

    for (const c of result.candidates) {
      if (c.status === 'fulfilled') {
        sections.push(`\n*Model \`${c.model}\`* (${c.latencyMs}ms):`);
        sections.push(c.answer);
      } else if (c.status === 'skipped') {
        sections.push(`\n*Model \`${c.model}\`* skipped: _${c.error}_`);
      } else {
        sections.push(`\n*Model \`${c.model}\`* (${c.latencyMs}ms) failed: _${c.error}_`);
      }
    }

    return sections.join('\n');
  }
}
