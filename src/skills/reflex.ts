import { DocumentStore, Collection } from '../storage/collection.js';

export interface ReflexMacro {
  id: string;
  triggerPattern: string;
  steps: string[];
  executionCount: number;
  avgDurationMs: number;
  confidence: number;
  isLocked: boolean;
  createdAt: string;
  lastUsedAt: string;
}

export class ReflexCompiler {
  private collection: Collection<ReflexMacro>;

  constructor(private store: DocumentStore) {
    this.collection = this.store.getCollection<ReflexMacro>('reflex_macros');
  }

  /**
   * Compiles a successful multi-step workflow into a fast macro reflex ("muscle memory").
   */
  async compileReflex(triggerPattern: string, steps: string[]): Promise<ReflexMacro> {
    const existing = await this.collection.findOne({ triggerPattern });
    const now = new Date().toISOString();

    if (existing) {
      const updatedCount = existing.executionCount + 1;
      const updatedConfidence = Math.min(1.0, existing.confidence + 0.1);
      await this.collection.updateOne(
        { id: existing.id },
        {
          steps,
          executionCount: updatedCount,
          confidence: updatedConfidence,
          lastUsedAt: now,
        }
      );
      return {
        ...existing,
        steps,
        executionCount: updatedCount,
        confidence: updatedConfidence,
        lastUsedAt: now,
      };
    }

    const macro: ReflexMacro = {
      id: `reflex-${Date.now().toString(36)}`,
      triggerPattern: triggerPattern.toLowerCase().trim(),
      steps,
      executionCount: 1,
      avgDurationMs: 50,
      confidence: 0.8,
      isLocked: false,
      createdAt: now,
      lastUsedAt: now,
    };

    await this.collection.insertOne(macro);
    return macro;
  }

  /**
   * Looks up a compiled reflex for an incoming goal/trigger.
   */
  async findReflex(goal: string): Promise<ReflexMacro | null> {
    const all = await this.collection.find({});
    const normalized = goal.toLowerCase().trim();

    for (const macro of all) {
      if (normalized.includes(macro.triggerPattern) || macro.triggerPattern.includes(normalized)) {
        return macro;
      }
    }
    return null;
  }

  async listReflexes(): Promise<ReflexMacro[]> {
    return this.collection.find({});
  }
}
