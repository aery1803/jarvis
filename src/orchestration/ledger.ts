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
  tokensPerSec: number;
  timestamp: string;
}

export interface LedgerSummary {
  totalInvocations: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  avgLatencyMs: number;
  avgTokensPerSec: number;
}

export class CostLedger {
  private collection: Collection<LedgerEntry>;

  constructor(private store: DocumentStore) {
    this.collection = this.store.getCollection<LedgerEntry>('cost_ledger');
  }

  async record(entry: Omit<LedgerEntry, 'id' | 'totalTokens' | 'tokensPerSec' | 'timestamp'>): Promise<LedgerEntry> {
    const totalTokens = entry.promptTokens + entry.completionTokens;
    const tokensPerSec = entry.latencyMs > 0 ? parseFloat(((entry.completionTokens / entry.latencyMs) * 1000).toFixed(2)) : 0;
    const timestamp = new Date().toISOString();

    const record: LedgerEntry = {
      ...entry,
      id: `ledg-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      totalTokens,
      tokensPerSec,
      timestamp,
    };

    await this.collection.insertOne(record);
    return record;
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
    };
  }
}
