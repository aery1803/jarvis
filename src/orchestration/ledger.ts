import { DocumentStore, Collection } from '../storage/collection.js';
import { newestFirst } from '../utils/ordering.js';

export interface LedgerEntry {
  _id?: string;
  id: string;
  taskId?: string;
  agentId?: string;
  modelId: string;
  lane: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
  /** End-to-end throughput: completionTokens / latencyMs. It includes model load, prompt evaluation and any hidden thinking, so it understates decode speed. */
  tokensPerSec: number;
  /** Backend `load_duration`. Absent on rows written before the backend counters were captured. */
  loadMs?: number;
  /** Backend `prompt_eval_duration`. */
  promptEvalMs?: number;
  /** Backend `eval_duration`: time spent generating the completion tokens only. */
  decodeMs?: number;
  /** Backend `done_reason` (`stop`, `length`...). */
  doneReason?: string;
  /** completionTokens / decodeMs: the real generation speed. Absent when the backend gave no decode time. */
  decodeTokensPerSec?: number;
  /** promptTokens / promptEvalMs. */
  promptEvalTokensPerSec?: number;
  timestamp: string;
}

type RecordInput = Omit<LedgerEntry, 'id' | 'totalTokens' | 'tokensPerSec' | 'decodeTokensPerSec' | 'promptEvalTokensPerSec' | 'timestamp'>;

export interface LedgerSummary {
  totalInvocations: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  avgLatencyMs: number;
  /** Mean end-to-end throughput (load, prompt evaluation and thinking included). */
  avgTokensPerSec: number;
  /** Mean decode speed over only the rows that carry it; null when no row does. */
  avgDecodeTokensPerSec: number | null;
  /** Mean model load time over only the rows that carry it; null when no row does. */
  avgLoadMs: number | null;
}

const round2 = (value: number): number => parseFloat(value.toFixed(2));

function perSecond(tokens: number, ms: number | undefined): number | undefined {
  return ms !== undefined && ms > 0 ? round2((tokens / ms) * 1000) : undefined;
}

function mean(values: number[]): number | null {
  return values.length > 0 ? round2(values.reduce((a, b) => a + b, 0) / values.length) : null;
}

export class CostLedger {
  private collection: Collection<LedgerEntry>;

  constructor(private store: DocumentStore) {
    this.collection = this.store.getCollection<LedgerEntry>('cost_ledger');
  }

  async record(entry: RecordInput): Promise<LedgerEntry> {
    const totalTokens = entry.promptTokens + entry.completionTokens;
    const tokensPerSec = entry.latencyMs > 0 ? parseFloat(((entry.completionTokens / entry.latencyMs) * 1000).toFixed(2)) : 0;
    const timestamp = new Date().toISOString();
    const decodeTokensPerSec = perSecond(entry.completionTokens, entry.decodeMs);
    const promptEvalTokensPerSec = perSecond(entry.promptTokens, entry.promptEvalMs);

    const record: LedgerEntry = {
      ...entry,
      ...(decodeTokensPerSec !== undefined ? { decodeTokensPerSec } : {}),
      ...(promptEvalTokensPerSec !== undefined ? { promptEvalTokensPerSec } : {}),
      id: `ledg-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      totalTokens,
      tokensPerSec,
      timestamp,
    };

    await this.collection.insertOne(record);
    return record;
  }

  /** Chat-path convenience: clamps non-finite or negative counts to 0 so one bad usage report cannot poison the summaries. */
  async recordUsage(usage: {
    model: string;
    lane: string;
    taskId?: string;
    agentId?: string;
    promptTokens: number;
    completionTokens: number;
    latencyMs: number;
    loadMs?: number;
    promptEvalMs?: number;
    decodeMs?: number;
    doneReason?: string;
  }): Promise<LedgerEntry> {
    const clean = (n: number) => (Number.isFinite(n) && n > 0 ? Math.round(n) : 0);
    // A timing the backend did not report stays absent; clamping it to 0 would pass for a measured instant.
    const optional = (n: number | undefined) => (n !== undefined && Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined);
    const loadMs = optional(usage.loadMs);
    const promptEvalMs = optional(usage.promptEvalMs);
    const decodeMs = optional(usage.decodeMs);
    return this.record({
      modelId: usage.model,
      lane: usage.lane,
      taskId: usage.taskId,
      agentId: usage.agentId,
      promptTokens: clean(usage.promptTokens),
      completionTokens: clean(usage.completionTokens),
      latencyMs: clean(usage.latencyMs),
      ...(loadMs !== undefined ? { loadMs } : {}),
      ...(promptEvalMs !== undefined ? { promptEvalMs } : {}),
      ...(decodeMs !== undefined ? { decodeMs } : {}),
      ...(usage.doneReason ? { doneReason: usage.doneReason } : {}),
    });
  }

  async listByModel(modelId: string, limit = 20): Promise<LedgerEntry[]> {
    const rows = await this.collection.find({ modelId } as Record<string, unknown>);
    return newestFirst(rows, (entry) => entry.timestamp).slice(0, limit);
  }

  async getSummaryByModel(): Promise<Record<string, LedgerSummary>> {
    const all = await this.collection.find({});
    const modelIds = Array.from(new Set(all.map((e) => e.modelId)));
    const result: Record<string, LedgerSummary> = {};
    for (const modelId of modelIds) {
      result[modelId] = await this.getSummary({ modelId });
    }
    return result;
  }

  async listRecent(limit = 20): Promise<LedgerEntry[]> {
    const all = await this.collection.find({});
    return newestFirst(all, (entry) => entry.timestamp).slice(0, limit);
  }

  async getSummary(filter: Partial<Pick<LedgerEntry, 'agentId' | 'modelId' | 'lane'>> = {}): Promise<LedgerSummary> {
    const entries = await this.collection.find(filter as Record<string, unknown>);
    if (entries.length === 0) {
      return {
        totalInvocations: 0,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        totalTokens: 0,
        avgLatencyMs: 0,
        avgTokensPerSec: 0,
        avgDecodeTokensPerSec: null,
        avgLoadMs: null,
      };
    }

    let promptSum = 0;
    let completionSum = 0;
    let latencySum = 0;
    let speedSum = 0;

    for (const e of entries) {
      promptSum += e.promptTokens;
      completionSum += e.completionTokens;
      latencySum += e.latencyMs;
      speedSum += e.tokensPerSec;
    }

    return {
      totalInvocations: entries.length,
      totalPromptTokens: promptSum,
      totalCompletionTokens: completionSum,
      totalTokens: promptSum + completionSum,
      avgLatencyMs: parseFloat((latencySum / entries.length).toFixed(2)),
      avgTokensPerSec: parseFloat((speedSum / entries.length).toFixed(2)),
      avgDecodeTokensPerSec: mean(entries.flatMap((e) => (typeof e.decodeTokensPerSec === 'number' ? [e.decodeTokensPerSec] : []))),
      avgLoadMs: mean(entries.flatMap((e) => (typeof e.loadMs === 'number' ? [e.loadMs] : []))),
    };
  }
}
