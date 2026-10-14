/**
 * Jarvis Local AI: Model Provisioner & Task Dispatcher
 * Authority: Initial Concept Document (PHASE_0_SPEC.md & jarvis-master-context.md)
 *
 * Rules:
 * 1. Default baseline: the resident qwen3:8b, which has complete access to memory, tools and system stats.
 * 2. Precision escalation: heavy engineering, proofs and architecture escalate to the 30B+ installed models.
 * 3. An explicitly requested model that is not installed is never swapped for a heavier lane: the resident default
 *    answers (or the smallest installed model that fits) and the rationale says the requested one is missing.
 * 4. Only installed models are chosen. Downloading a multi-GB model is Tier 2 (CODING_RULES section 5): it
 *    happens only when the caller opts in with `allowPull` and `confirmPull` answers yes for that model.
 */

import type { LLMProvider } from '../services/provider.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { CapabilityChecker } from './capability.js';
import { MemoryGovernor } from './governor.js';
import { KIMI_REGISTRY_ID, GIB, canonicalizeTag, matchesWord, parseParameterBillions, type InstalledModelInfo } from './lanes.js';
import { ModelRegistry, type ModelDefinition, type ModelLane } from './registry.js';
import { CascadeRouter } from './router.js';
import { getSharedVramProbe } from './vram.js';

export type TaskCategory = 'precision' | 'code' | 'reasoning' | 'chat' | 'vision';

export const NEMOTRON_REGISTRY_ID = 'rnogy/Nvidia_Llama-3_3-Nemotron-Super-49B-v1_5:q4_K_M';

export interface ProvisionRequest {
  prompt: string;
  taskType?: 'chat' | 'code' | 'reasoning' | 'precision' | 'vision' | 'embedding' | 'auto';
  /** The owner's UI or Telegram choice. Honoured without reclassifying the prompt. */
  explicitModel?: string;
  /** Pulling is Tier 2: it needs this flag AND a `confirmPull` that answers true for the specific model. */
  allowPull?: boolean;
  /** `sizeBytes` is 0 when the size is unknown. */
  confirmPull?: (modelId: string, sizeBytes: number) => Promise<boolean>;
  /** Status lines for the owner, including download progress while a model is pulled. */
  onProgress?: (message: string) => Promise<void> | void;
  /** Aborts an in-flight model download (the kill switch and a stopped turn use it). */
  signal?: AbortSignal;
  /** Overrides the provider's own download time limit. */
  pullTimeoutMs?: number;
}

export interface ProvisionDecision {
  /** The tag to hand to Ollama. Empty string when `canRun` is false. */
  targetModel: string;
  category: TaskCategory;
  is30BClass: boolean;
  wasInstalledOnDemand: boolean;
  rationale: string;
  lane: ModelLane;
  /** True when the model that runs is not the one that was wanted. */
  isFallback: boolean;
  /** False when nothing installed can run; the caller must tell the owner `reason` instead of chatting. */
  canRun: boolean;
  reason?: string;
  requestedModel?: string;
}

export interface Classification {
  /** Registry id wanted for the task; empty for the vision lane, where the installed vision model is resolved at dispatch. */
  model: string;
  category: TaskCategory;
  lane: ModelLane;
  is30BClass: boolean;
  rationale: string;
}

export interface ProvisionerOptions {
  registry?: ModelRegistry;
  capabilityChecker?: CapabilityChecker;
  governor?: MemoryGovernor;
  /** Free VRAM in bytes, null when unknown. Defaults to a cached `probeGpu()` when the provisioner owns its checker. */
  getVramFreeBytes?: () => Promise<number | null>;
  /** Installed models with sizes. Defaults to names from `provider.listModels()`, which carry no sizes. */
  listInstalled?: () => Promise<InstalledModelInfo[]>;
  /** Resident model answering when the owner's explicit model is not installed. Defaults to `config.defaultModel`. */
  defaultModel?: string;
}

const KIMI_WORDS = /\b(kimi|linear attention|1m context|million tokens|massive document|book analysis)\b/i;
const NEMOTRON_WORDS = /\b(nemotron|49b)\b/i;
const DEEPSEEK_WORDS = /\b(deepseek(?:[-\s]?r1)?|deep math|rigorous proof|symbolic logic|formal proof|complex deduction)\b/i;
const PRECISION_WORDS = /\b(precise|precision|30b|32b|full architecture|system blueprint|heavy refactor|multi-file|production grade)\b/i;
const MID_REASONING_WORDS = /\b(analyze|compare|evaluate|deduce|strategy|synthesis|deep analysis)\b/i;
const CODE_WORDS = /\b(code|coding|script|scripts|function|def|python|typescript|javascript|powershell|bash|sql|bug|debug|fix|refactor|rewrite|tests?|implement|database|endpoints?|git)\b/i;
const VISION_WORDS = ['image', 'images', 'photo', 'photos', 'picture', 'pictures', 'screenshot', 'screenshots', 'diagram', 'diagrams', 'ocr'];

function categoryFor(lane: ModelLane): TaskCategory {
  if (lane === 'code') return 'code';
  if (lane === 'vision') return 'vision';
  if (lane === 'deep') return 'precision';
  if (lane === 'balanced') return 'reasoning';
  return 'chat';
}

export class ModelProvisioner {
  private registry: ModelRegistry;
  private governor: MemoryGovernor;
  private router: CascadeRouter;
  private getVram: (() => Promise<number | null>) | null;

  constructor(
    private provider: LLMProvider,
    private options: ProvisionerOptions = {},
  ) {
    this.registry = options.registry ?? new ModelRegistry();
    // Unknown VRAM must not turn the host-RAM comparison (wrong pool for this box) into a hard refusal.
    this.governor =
      options.governor ??
      new MemoryGovernor({
        capabilityChecker: options.capabilityChecker ?? new CapabilityChecker({ unknownVramPolicy: 'allow' }),
        pacingDelayMs: 0,
      });
    this.router = new CascadeRouter(this.registry, this.governor);
    const ownsChecker = !options.capabilityChecker && !options.governor;
    this.getVram = options.getVramFreeBytes ?? (ownsChecker ? getSharedVramProbe() : null);
  }

  getRegistry(): ModelRegistry {
    return this.registry;
  }

  /**
   * Pure prompt classification. `model` is the registry id wanted for the task (it may not be installed).
   * Default baseline is qwen3:8b; 14B/27B/32B/49B/70B only for explicitly analytical, precise or flagship work.
   */
  classifyTask(prompt: string, explicitType?: string): Classification {
    const lower = prompt.toLowerCase();

    if (explicitType === 'kimi' || explicitType === 'linear' || KIMI_WORDS.test(lower)) {
      return {
        model: KIMI_REGISTRY_ID,
        category: 'reasoning',
        lane: 'deep',
        is30BClass: true,
        rationale: 'Kimi Linear 48B-A3B with 1M context window and fast 3B active linear attention.',
      };
    }

    if (explicitType === 'nemotron' || explicitType === '49b' || NEMOTRON_WORDS.test(lower)) {
      return {
        model: NEMOTRON_REGISTRY_ID,
        category: 'reasoning',
        lane: 'deep',
        is30BClass: true,
        rationale: 'Nemotron Super 49B reasoning model with 128k context.',
      };
    }

    if (explicitType === 'deepseek' || explicitType === '70b' || DEEPSEEK_WORDS.test(lower)) {
      return {
        model: 'deepseek-r1:70b',
        category: 'reasoning',
        lane: 'deep',
        is30BClass: true,
        rationale: 'Flagship 70B deep reasoning model with chain-of-thought verification.',
      };
    }

    if (explicitType === 'precision' || explicitType === '30b' || explicitType === '32b' || PRECISION_WORDS.test(lower)) {
      return {
        model: 'qwen3:32b',
        category: 'precision',
        lane: 'deep',
        is30BClass: true,
        rationale: 'Heavy 32B-class precision model for complex architecture and multi-file engineering.',
      };
    }

    if (explicitType === 'reasoning' || MID_REASONING_WORDS.test(lower)) {
      return {
        model: 'qwen3:14b',
        category: 'reasoning',
        lane: 'balanced',
        is30BClass: false,
        rationale: 'High-intelligence 14B reasoning model for analytical synthesis.',
      };
    }

    if (explicitType === 'code' || CODE_WORDS.test(lower)) {
      return {
        model: 'qwen3:8b',
        category: 'code',
        lane: 'code',
        is30BClass: false,
        rationale: 'Resident Qwen 3 8B coding engine with full tool and filesystem access.',
      };
    }

    if (explicitType === 'vision' || matchesWord(lower, VISION_WORDS)) {
      return {
        model: '',
        category: 'vision',
        lane: 'vision',
        is30BClass: false,
        rationale: 'Vision-language model for multimodal image understanding.',
      };
    }

    return {
      model: 'qwen3:8b',
      category: 'chat',
      lane: 'resident',
      is30BClass: false,
      rationale: 'Resident Qwen 3 8B starting orchestrator model with full access to memory, tools, and system state.',
    };
  }

  private classifyExplicit(modelId: string): Classification {
    const def = this.registry.getModel(modelId);
    const lane = def?.lane ?? 'balanced';
    const billions = parseParameterBillions(def?.parameterSize ?? modelId) ?? 0;
    return {
      model: def?.id ?? modelId,
      category: categoryFor(lane),
      lane,
      is30BClass: billions >= 30,
      rationale: `Explicitly selected ${def?.name ?? modelId}.`,
    };
  }

  private async refreshInstalled(): Promise<void> {
    try {
      const list = this.options.listInstalled
        ? await this.options.listInstalled()
        : this.provider.listModels
          ? (await this.provider.listModels()).map((name) => ({ name }))
          : null;
      if (list) this.registry.reconcileInstalled(list);
    } catch (err: unknown) {
      logger.warn(`[ModelProvisioner] Could not read installed models: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private unavailable(classification: Classification, reason: string, requested?: string): ProvisionDecision {
    return {
      targetModel: '',
      category: classification.category,
      is30BClass: classification.is30BClass,
      wasInstalledOnDemand: false,
      rationale: `${classification.rationale} Cannot run: ${reason}`,
      lane: classification.lane,
      isFallback: false,
      canRun: false,
      reason,
      requestedModel: requested,
    };
  }

  /**
   * The owner named a model that is not installed. Re-routing would pick a lane-mate (often a heavier model with a
   * long cold load), so the resident default answers instead, or the smallest installed model that fits.
   */
  private fallbackForMissingExplicit(requested: string, classification: Classification, notes: string[]): ProvisionDecision {
    const defaultId = this.options.defaultModel ?? config.defaultModel;
    const defaultDef = this.registry.getModel(defaultId);
    let chosen: ModelDefinition | null = null;
    let why = '';
    let fitNote = '';
    const tryFit = (model: ModelDefinition): boolean => {
      const check = this.governor.canFit(model);
      fitNote = check.canRun && (check.evicts !== undefined || check.alreadyResident) ? (check.note ?? '') : '';
      return check.canRun;
    };

    if (defaultDef && this.registry.isInstalled(defaultDef.id) && tryFit(defaultDef)) {
      chosen = defaultDef;
      why = 'the configured default resident model';
    } else {
      const isUsableForChat = (m: ModelDefinition): boolean =>
        ![m.lane, ...(m.lanes ?? [])].some((lane) => lane === 'embedding' || lane === 'vision');
      const smallestFirst = this.registry
        .listInstalled()
        .filter(isUsableForChat)
        .sort((a, b) => a.memoryRequirementBytes - b.memoryRequirementBytes);
      chosen = smallestFirst.find(tryFit) ?? null;
      why = `the smallest installed model that fits (the default ${defaultId} is not installed or does not fit)`;
    }

    if (!chosen) {
      return this.unavailable(
        classification,
        `${requested} is not installed, and no installed model fits the current memory headroom. Pulling ${requested} is a Tier 2 action that needs your approval.`,
        requested
      );
    }

    const targetModel = this.registry.getInstalledTag(chosen.id) ?? chosen.id;
    this.provider.setModel?.(targetModel);
    const rationale = [
      `Requested model ${requested} is not installed.`,
      ...notes.filter((note) => !note.includes('downloading is a Tier 2 action')),
      `${targetModel} is answering instead (${why}).`,
      fitNote,
      `Pulling ${requested} is a Tier 2 action that needs your approval.`,
    ]
      .filter(Boolean)
      .join(' ');

    return {
      targetModel,
      category: categoryFor(chosen.lane),
      is30BClass: (parseParameterBillions(chosen.parameterSize) ?? 0) >= 30,
      wasInstalledOnDemand: false,
      rationale,
      lane: chosen.lane,
      isFallback: true,
      canRun: true,
      requestedModel: requested,
    };
  }

  /**
   * Resolves the target model among INSTALLED models and points the provider at it. Never downloads without
   * `allowPull` plus an affirmative `confirmPull`; otherwise it falls back to the best installed model that fits
   * and says so in `rationale`.
   */
  async ensureAndDispatch(request: ProvisionRequest): Promise<ProvisionDecision> {
    await this.refreshInstalled();
    if (this.getVram) {
      this.governor.getChecker().setVramFree(await this.getVram().catch(() => null));
    }

    let classification = request.explicitModel ? this.classifyExplicit(request.explicitModel) : this.classifyTask(request.prompt, request.taskType);
    const notes: string[] = [];
    let wanted = classification.model;

    if (classification.lane === 'vision' && wanted === '') {
      const vision = this.registry.getInstalledPrimaryForLane('vision');
      if (vision && this.registry.isInstalled(vision.id)) {
        wanted = vision.id;
      } else if (request.taskType === 'vision') {
        return this.unavailable(classification, 'no vision model is installed.');
      } else {
        notes.push('No vision model is installed, so this text model cannot see images.');
        classification = this.classifyTask('', undefined);
        wanted = classification.model;
      }
    }

    const wantedDef = this.registry.getModel(wanted);
    const missing = this.registry.hasInstalledInfo() && !this.registry.isInstalled(wanted);
    let installedOnDemand = false;

    if (missing) {
      const sizeBytes = wantedDef?.diskSizeBytes ?? wantedDef?.memoryRequirementBytes ?? 0;
      const sizeLabel = sizeBytes > 0 ? `${(sizeBytes / GIB).toFixed(1)} GB` : 'unknown size';
      const pullable = canonicalizeTag(wanted) !== KIMI_REGISTRY_ID;
      if (!pullable) {
        notes.push(`${wanted} is not installed and has no Ollama library tag; install it with the fleet downloader.`);
      } else if (request.allowPull && request.confirmPull && this.provider.pullModel) {
        const approved = await request.confirmPull(wanted, sizeBytes);
        if (approved) {
          logger.info(`[ModelProvisioner] Pulling ${wanted} with owner approval (${sizeLabel}).`);
          await request.onProgress?.(`Downloading \`${wanted}\` (${sizeLabel}) with your approval. This can take a while.`);
          let lastReported = -Infinity;
          const pulled = await this.provider.pullModel(wanted, {
            signal: request.signal,
            timeoutMs: request.pullTimeoutMs,
            onProgress: (progress) => {
              // Ollama emits a line per chunk; report at most one status per 5% step to keep the stream readable.
              if (progress.percent === undefined || progress.percent < lastReported + 5) return;
              lastReported = progress.percent;
              void Promise.resolve(request.onProgress?.(`Downloading \`${wanted}\`: ${progress.percent}%`)).catch(() => undefined);
            },
          });
          if (request.signal?.aborted) {
            notes.push(`Downloading ${wanted} was stopped.`);
          } else if (pulled) {
            this.registry.markInstalled(wanted, wantedDef?.diskSizeBytes ?? null);
            installedOnDemand = true;
            await request.onProgress?.(`Model installed: \`${wanted}\`.`);
          } else {
            notes.push(`Downloading ${wanted} failed.`);
          }
        } else {
          notes.push(`${wanted} (${sizeLabel}) is not installed and downloading was not approved.`);
        }
      } else {
        notes.push(`${wanted} (${sizeLabel}) is not installed; downloading is a Tier 2 action that needs your approval, so an installed model is used instead.`);
      }
    }

    if (request.explicitModel && this.registry.hasInstalledInfo() && !this.registry.isInstalled(wanted)) {
      return this.fallbackForMissingExplicit(request.explicitModel, classification, notes);
    }

    const route = await this.router.route({
      prompt: request.prompt,
      taskType: request.taskType === 'precision' || request.taskType === 'vision' || request.taskType === 'auto' ? undefined : request.taskType,
      preferredModel: wanted || undefined,
      preferredLane: classification.lane,
    });

    if (!route.canRun || !route.chosenModel) {
      return this.unavailable(classification, route.reason ?? route.rationale, wanted || undefined);
    }

    const chosen: ModelDefinition = route.chosenModel;
    const sameAsWanted = wanted !== '' && canonicalizeTag(chosen.id) === canonicalizeTag(wanted);
    const targetModel = this.registry.getInstalledTag(chosen.id) ?? chosen.id;
    this.provider.setModel?.(targetModel);

    const rationale = sameAsWanted
      ? [...notes, `${classification.rationale}${installedOnDemand ? ' (Installed on-demand with approval).' : this.registry.hasInstalledInfo() ? ' (Already installed).' : ''}`, route.fitNote ?? ''].filter(Boolean).join(' ')
      : `${[...notes, route.rationale].join(' ')} Using ${chosen.name} instead of ${wanted || 'a vision model'}.`;

    return {
      targetModel,
      category: classification.category,
      is30BClass: sameAsWanted ? classification.is30BClass : (parseParameterBillions(chosen.parameterSize) ?? 0) >= 30,
      wasInstalledOnDemand: installedOnDemand && sameAsWanted,
      rationale,
      lane: route.lane,
      isFallback: !sameAsWanted,
      canRun: true,
      requestedModel: wanted || undefined,
    };
  }
}
