import { DocumentStore, Collection } from '../storage/collection.js';
import {
  MemoryTier,
  OwnerProfileFact,
  SessionSummary,
  EpisodicMemory,
  KnowledgeItem,
  EncryptedItem,
  PromptContextOptions,
  PromptContextResult,
} from './types.js';
import { encryptSensitive, decryptSensitive } from './crypto.js';

export class MemoryManager {
  private profileCollection: Collection<OwnerProfileFact>;
  private summaryCollection: Collection<SessionSummary>;
  private episodicCollection: Collection<EpisodicMemory>;
  private knowledgeCollection: Collection<KnowledgeItem>;
  private vaultCollection: Collection<EncryptedItem>;

  constructor(private store: DocumentStore) {
    this.profileCollection = this.store.getCollection<OwnerProfileFact>('owner_profile');
    this.summaryCollection = this.store.getCollection<SessionSummary>('session_summaries');
    this.episodicCollection = this.store.getCollection<EpisodicMemory>('episodic_memories');
    this.knowledgeCollection = this.store.getCollection<KnowledgeItem>('knowledge_items');
    this.vaultCollection = this.store.getCollection<EncryptedItem>('sensitive_vault');
  }

  // --- T1: Owner Profile ---

  async setProfileFact(
    userId: string,
    key: string,
    value: string,
    category: OwnerProfileFact['category'] = 'preference',
    confidence = 1.0
  ): Promise<OwnerProfileFact> {
    const existing = await this.profileCollection.findOne({ userId, key });
    const now = new Date().toISOString();

    if (existing) {
      await this.profileCollection.updateOne(
        { userId, key },
        { value, category, confidence, updatedAt: now }
      );
      return { ...existing, value, category, confidence, updatedAt: now };
    }

    const doc: OwnerProfileFact = {
      userId,
      key,
      value,
      category,
      confidence,
      updatedAt: now,
    };
    await this.profileCollection.insertOne(doc);
    return doc;
  }

  async getProfileFacts(userId: string, category?: OwnerProfileFact['category']): Promise<OwnerProfileFact[]> {
    const filter: Record<string, unknown> = { userId };
    if (category) {
      filter.category = category;
    }
    return this.profileCollection.find(filter);
  }

  async formatProfileForPrompt(userId: string, maxChars = 1500): Promise<string> {
    const facts = await this.getProfileFacts(userId);
    if (facts.length === 0) {
      return '';
    }

    const lines = ['### Owner Profile & Style Preferences'];
    let currentLength = lines[0].length;

    for (const fact of facts) {
      const line = `- **${fact.key}** (${fact.category}): ${fact.value}`;
      if (currentLength + line.length > maxChars) {
        break;
      }
      lines.push(line);
      currentLength += line.length + 1;
    }

    return lines.join('\n');
  }

  // --- T2: Session Summaries ---

  async saveSessionSummary(
    userId: string,
    sessionId: string,
    summary: string,
    turnCount: number,
    keyFacts: string[] = []
  ): Promise<SessionSummary> {
    const doc: SessionSummary = {
      id: `summary-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      userId,
      sessionId,
      summary,
      turnCount,
      keyFacts,
      createdAt: new Date().toISOString(),
    };
    await this.summaryCollection.insertOne(doc);
    return doc;
  }

  async getSessionSummaries(userId: string, sessionId?: string, limit = 5): Promise<SessionSummary[]> {
    const filter: Record<string, unknown> = { userId };
    if (sessionId) {
      filter.sessionId = sessionId;
    }
    const all = await this.summaryCollection.find(filter);
    return all.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, limit);
  }

  // --- T3: Episodic Memory ---

  async recordEpisode(episode: Omit<EpisodicMemory, 'id' | 'createdAt'>): Promise<EpisodicMemory> {
    const doc: EpisodicMemory = {
      ...episode,
      id: `ep-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      createdAt: new Date().toISOString(),
    };
    await this.episodicCollection.insertOne(doc);
    return doc;
  }

  async queryEpisodes(filter: Partial<Pick<EpisodicMemory, 'userId' | 'sessionId' | 'feedback'>>, limit = 10): Promise<EpisodicMemory[]> {
    const all = await this.episodicCollection.find(filter as Record<string, unknown>);
    return all.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, limit);
  }

  // --- T4: Knowledge Memory ---

  async saveKnowledge(item: Omit<KnowledgeItem, 'id' | 'createdAt'>): Promise<KnowledgeItem> {
    const doc: KnowledgeItem = {
      ...item,
      id: `know-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      createdAt: new Date().toISOString(),
    };
    await this.knowledgeCollection.insertOne(doc);
    return doc;
  }

  async searchKnowledge(userId: string, keyword: string, limit = 5): Promise<KnowledgeItem[]> {
    const all = await this.knowledgeCollection.find({ userId });
    const lower = keyword.toLowerCase();
    const matches = all.filter(
      (k) =>
        k.title.toLowerCase().includes(lower) ||
        k.content.toLowerCase().includes(lower) ||
        k.tags.some((t) => t.toLowerCase().includes(lower))
    );
    return matches.slice(0, limit);
  }

  // --- Sensitive Item Vault ---

  async storeSensitive(userId: string, tag: string, plaintextSecret: string): Promise<void> {
    const encrypted = encryptSensitive(plaintextSecret);
    const existing = await this.vaultCollection.findOne({ userId, tag });
    const now = new Date().toISOString();

    if (existing) {
      await this.vaultCollection.updateOne(
        { userId, tag },
        { ...encrypted, createdAt: now }
      );
    } else {
      await this.vaultCollection.insertOne({
        id: `vault-${Date.now()}`,
        userId,
        tag,
        ...encrypted,
        createdAt: now,
      });
    }
  }

  async retrieveSensitive(userId: string, tag: string): Promise<string | null> {
    const record = await this.vaultCollection.findOne({ userId, tag });
    if (!record) {
      return null;
    }
    try {
      return decryptSensitive({
        ciphertext: record.ciphertext,
        iv: record.iv,
        authTag: record.authTag,
      });
    } catch {
      return null;
    }
  }

  async deleteSensitive(userId: string, tag: string): Promise<boolean> {
    const res = await this.vaultCollection.deleteOne({ userId, tag });
    return res > 0;
  }

  // --- Prompt Context Assembly & Token Budgeting ---

  async buildPromptContext(options: PromptContextOptions): Promise<PromptContextResult> {
    const { userId, sessionId, maxTokens = 1200, includeTiers = ['T0', 'T1', 'T2'], workingContext } = options;
    const includedTiers: MemoryTier[] = [];
    const promptSections: string[] = [];
    let estimatedTokens = 0;

    // T1: Owner Profile (~300 tokens budget)
    if (includeTiers.includes('T1')) {
      const profileSection = await this.formatProfileForPrompt(userId, 1000);
      if (profileSection) {
        promptSections.push(profileSection);
        const tokens = Math.ceil(profileSection.length / 4);
        estimatedTokens += tokens;
        includedTiers.push('T1');
      }
    }

    // T2: Session Summaries (~300 tokens budget)
    if (includeTiers.includes('T2')) {
      const summaries = await this.getSessionSummaries(userId, sessionId, 2);
      if (summaries.length > 0) {
        const summaryText = [
          '### Past Conversation Context',
          ...summaries.map((s) => `- ${s.summary}`),
        ].join('\n');
        promptSections.push(summaryText);
        const tokens = Math.ceil(summaryText.length / 4);
        estimatedTokens += tokens;
        includedTiers.push('T2');
      }
    }

    // T0: Working Context
    let workingContextFormatted = '';
    if (includeTiers.includes('T0') && workingContext) {
      const parts: string[] = [];
      if (workingContext.currentTask) {
        parts.push(`Current Task: ${workingContext.currentTask}`);
      }
      if (workingContext.activePlan) {
        parts.push(`Active Plan: ${workingContext.activePlan}`);
      }
      if (workingContext.recentTurns.length > 0) {
        parts.push(
          'Recent Turns:\n' +
            workingContext.recentTurns
              .map((t) => `${t.role.toUpperCase()}: ${t.content}`)
              .join('\n')
        );
      }
      workingContextFormatted = parts.join('\n\n');
      const tokens = Math.ceil(workingContextFormatted.length / 4);
      estimatedTokens += tokens;
      includedTiers.push('T0');
    }

    return {
      systemPromptAdditions: promptSections.join('\n\n'),
      workingContextFormatted,
      totalEstimatedTokens: estimatedTokens,
      includedTiers,
    };
  }
}
