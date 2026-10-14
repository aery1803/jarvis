import { DocumentStore, Collection } from '../storage/collection.js';
import type { ReflexHint } from '../agents/cognition.js';

/**
 * A compiled reflex is a HINT for the planner: `steps` are tool names that worked for a similar request.
 * Nothing here executes anything; each step still goes through the Action Gateway like any other tool call.
 */
export interface ReflexMacro {
  id: string;
  triggerPattern: string;
  steps: string[];
  executionCount: number;
  /** Running mean of reported durations; 0 until a duration has been reported. */
  avgDurationMs: number;
  confidence: number;
  /** Owner-pinned: steps are never overwritten, confidence never decays or drops, and the reflex stays eligible. */
  isLocked: boolean;
  createdAt: string;
  lastUsedAt: string;
  failureCount?: number;
  lastDecayAt?: string;
}

/** A planner hint that also carries the evidence behind it, for prompts and UIs that want to show counts. */
export interface ReflexEvidenceHint extends ReflexHint {
  /** Times the workflow succeeded, counting the run that compiled it. */
  worked: number;
  failed: number;
}

/** Fewer recorded outcomes than this are too few to call a rate; the hint then carries no confidence at all. */
const MIN_OUTCOMES_FOR_CONFIDENCE = 3;

export type ReflexMatchKind = 'exact' | 'prefix' | 'overlap';

export interface ReflexMatch {
  macro: ReflexMacro;
  score: number;
  kind: ReflexMatchKind;
}

const STEP_NAME = /^[A-Za-z0-9_.:-]{1,64}$/;
const FILLER = new Set(['a', 'an', 'the', 'to', 'please', 'now', 'my', 'me', 'can', 'you', 'could', 'for', 'of', 'and', 'then', 'jarvis', 'hey', 'just', 'again']);
const MIN_MATCH_SCORE = 0.6;
const MIN_ACTIVE_CONFIDENCE = 0.3;
const FAILURE_FACTOR = 0.6;
const SUCCESS_BONUS = 0.05;
const COMPILE_BONUS = 0.1;
const INITIAL_CONFIDENCE = 0.8;
const DECAY_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;
const DECAY_PER_PERIOD = 0.1;

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function tokens(text: string): string[] {
  return (normalize(text).match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => !FILLER.has(t));
}

function scoreMatch(trigger: string, goal: string): { score: number; kind: ReflexMatchKind } | null {
  const normalizedTrigger = normalize(trigger);
  const normalizedGoal = normalize(goal);
  if (!normalizedTrigger || !normalizedGoal) return null;
  if (normalizedTrigger === normalizedGoal) return { score: 1, kind: 'exact' };

  const triggerTokens = tokens(trigger);
  const goalTokens = tokens(goal);
  if (triggerTokens.length === 0 || goalTokens.length === 0) return null;

  const goalSet = new Set(goalTokens);
  const triggerSet = new Set(triggerTokens);
  const shared = triggerTokens.filter((t) => goalSet.has(t)).length;
  const coverage = shared / triggerTokens.length;
  const precision = shared / goalTokens.length;

  const startsWithWords = (haystack: string[], needle: string[]): boolean => needle.length <= haystack.length && needle.every((t, i) => haystack[i] === t);
  if (precision >= 0.5 && startsWithWords(goalTokens, triggerTokens)) {
    return { score: Math.min(0.99, 0.9 + 0.09 * precision), kind: 'prefix' };
  }
  if (goalTokens.length >= 2 && startsWithWords(triggerTokens, goalTokens) && goalTokens.length / triggerTokens.length >= 0.6) {
    return { score: 0.85, kind: 'prefix' };
  }

  // A single shared word is never enough unless the trigger itself is that one word.
  if (shared < 2 && triggerSet.size > 1) return null;
  if (coverage < 0.8 || precision < 0.4) return null;
  const score = coverage * 0.7 + precision * 0.3;
  return score >= MIN_MATCH_SCORE ? { score, kind: 'overlap' } : null;
}

export class ReflexCompiler {
  private collection: Collection<ReflexMacro>;

  constructor(private store: DocumentStore) {
    this.collection = this.store.getCollection<ReflexMacro>('reflex_macros');
  }

  /**
   * Compiles a successful multi-step workflow into a reflex hint ("muscle memory"). Re-compiling the same trigger
   * strengthens it, unless it is locked, in which case the stored steps are kept.
   */
  async compileReflex(triggerPattern: string, steps: string[], durationMs?: number): Promise<ReflexMacro> {
    const trigger = normalize(triggerPattern);
    if (!trigger) throw new Error('Reflex trigger must not be empty');
    if (steps.length === 0 || !steps.every((s) => STEP_NAME.test(s))) {
      throw new Error('Reflex steps must be a non-empty list of tool names');
    }

    const existing = await this.collection.findOne({ triggerPattern: trigger });
    const now = new Date().toISOString();

    if (existing) {
      if (existing.isLocked) return existing;
      const executionCount = existing.executionCount + 1;
      const confidence = Number(Math.min(1.0, existing.confidence + COMPILE_BONUS).toFixed(4));
      const avgDurationMs = this.runningMean(existing, durationMs);
      await this.collection.updateOne({ id: existing.id }, { steps, executionCount, confidence, avgDurationMs, lastUsedAt: now });
      return { ...existing, steps, executionCount, confidence, avgDurationMs, lastUsedAt: now };
    }

    const macro: ReflexMacro = {
      id: `reflex-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      triggerPattern: trigger,
      steps,
      executionCount: 1,
      avgDurationMs: durationMs && durationMs > 0 ? Math.round(durationMs) : 0,
      confidence: INITIAL_CONFIDENCE,
      isLocked: false,
      createdAt: now,
      lastUsedAt: now,
      failureCount: 0,
    };

    await this.collection.insertOne(macro);
    return macro;
  }

  private runningMean(macro: ReflexMacro, durationMs: number | undefined): number {
    if (durationMs === undefined || durationMs <= 0) return macro.avgDurationMs;
    if (macro.avgDurationMs <= 0) return Math.round(durationMs);
    return Math.round((macro.avgDurationMs * macro.executionCount + durationMs) / (macro.executionCount + 1));
  }

  /**
   * Best reflex for an incoming goal: exact match, then prefix, then token overlap (every trigger word present, at least
   * two shared words). Reflexes whose confidence has decayed below 0.3 are ignored unless locked.
   */
  async findReflexMatch(goal: string): Promise<ReflexMatch | null> {
    const all = await this.collection.find({});
    let best: ReflexMatch | null = null;

    for (const macro of all) {
      if (!macro.isLocked && macro.confidence < MIN_ACTIVE_CONFIDENCE) continue;
      const match = scoreMatch(macro.triggerPattern, goal);
      if (!match) continue;
      const candidate: ReflexMatch = { macro, score: match.score, kind: match.kind };
      if (
        !best ||
        candidate.score > best.score ||
        (candidate.score === best.score && candidate.macro.confidence > best.macro.confidence) ||
        (candidate.score === best.score && candidate.macro.confidence === best.macro.confidence && candidate.macro.executionCount > best.macro.executionCount)
      ) {
        best = candidate;
      }
    }
    return best;
  }

  async findReflex(goal: string): Promise<ReflexMacro | null> {
    return (await this.findReflexMatch(goal))?.macro ?? null;
  }

  /**
   * The hint for a matched reflex. `confidence` is the observed success rate and appears only once there are enough
   * outcomes to call it a rate: the stored `confidence` starts at a constant 0.8 and is not evidence.
   */
  static hintFromMatch(match: ReflexMatch): ReflexEvidenceHint {
    const worked = match.macro.executionCount;
    const failed = match.macro.failureCount ?? 0;
    const total = worked + failed;
    return {
      trigger: match.macro.triggerPattern,
      steps: match.macro.steps,
      worked,
      failed,
      ...(total >= MIN_OUTCOMES_FOR_CONFIDENCE ? { confidence: Number((worked / total).toFixed(2)) } : {}),
    };
  }

  /** The matching reflex as a planner hint for `CognitionEngine.formatPrompt({ reflexHint })`, or null. */
  async hintFor(goal: string): Promise<ReflexEvidenceHint | null> {
    const match = await this.findReflexMatch(goal);
    return match ? ReflexCompiler.hintFromMatch(match) : null;
  }

  async recordSuccess(id: string, durationMs?: number): Promise<void> {
    const macro = await this.collection.findOne({ id });
    if (!macro) return;
    await this.collection.updateOne(
      { id },
      {
        executionCount: macro.executionCount + 1,
        confidence: Number(Math.min(1.0, macro.confidence + SUCCESS_BONUS).toFixed(4)),
        avgDurationMs: this.runningMean(macro, durationMs),
        lastUsedAt: new Date().toISOString(),
      }
    );
  }

  /** A failed use cuts confidence by 40% (locked reflexes only count the failure). Below 0.3 the reflex stops matching. */
  async recordFailure(id: string): Promise<void> {
    const macro = await this.collection.findOne({ id });
    if (!macro) return;
    const failureCount = (macro.failureCount ?? 0) + 1;
    if (macro.isLocked) {
      await this.collection.updateOne({ id }, { failureCount });
      return;
    }
    await this.collection.updateOne({ id }, { failureCount, confidence: Number((macro.confidence * FAILURE_FACTOR).toFixed(4)) });
  }

  /** Lowers confidence by 0.1 for every full 30 idle days since last use or last decay. Locked reflexes are exempt. */
  async decayStale(now: number = Date.now()): Promise<number> {
    let decayed = 0;
    for (const macro of await this.collection.find({})) {
      if (macro.isLocked) continue;
      const from = Math.max(Date.parse(macro.lastUsedAt) || 0, Date.parse(macro.lastDecayAt ?? '') || 0);
      const periods = Math.floor((now - from) / DECAY_PERIOD_MS);
      if (periods <= 0) continue;
      await this.collection.updateOne(
        { id: macro.id },
        {
          confidence: Math.max(0, Number((macro.confidence - DECAY_PER_PERIOD * periods).toFixed(4))),
          lastDecayAt: new Date(from + periods * DECAY_PERIOD_MS).toISOString(),
        }
      );
      decayed++;
    }
    return decayed;
  }

  async setLocked(id: string, isLocked: boolean): Promise<boolean> {
    return this.collection.updateOne({ id }, { isLocked });
  }

  async listReflexes(): Promise<ReflexMacro[]> {
    return this.collection.find({});
  }
}
