import crypto from 'node:crypto';
import { DocumentStore, Collection } from '../storage/collection.js';
import type {
  MemoryTier,
  OwnerProfileFact,
  SessionSummary,
  EpisodicMemory,
  KnowledgeItem,
  EncryptedItem,
  PromptContextOptions,
  PromptContextResult,
} from './types.js';
import {
  encryptSensitive,
  tryDecryptSensitive,
  VaultCorruptError,
  VaultKeyMismatchError,
  getVaultKeyPath,
  loadVaultKey,
  type DecryptResult,
  type VaultKeyOptions,
} from './crypto.js';
import { detectSensitive, redactSensitive, type SensitiveKind } from './sensitive.js';
import { newestByCreatedAt, newestFirst } from '../utils/ordering.js';

/** A plaintext tier was asked to hold something that looks like a secret; use `rememberFact` or `storeSensitive`. */
export class SensitiveValueError extends Error {
  constructor(public readonly kinds: SensitiveKind[]) {
    super(`Refusing to store a ${kinds.join('/')} value in plaintext memory; it belongs in the encrypted vault`);
    this.name = 'SensitiveValueError';
  }
}

export interface RememberResult {
  /** `vault`: the value is encrypted and the profile holds only a pointer. */
  stored: 'profile' | 'vault';
  key: string;
  /** The vault tag, when `stored` is `vault`. */
  tag?: string;
  created: boolean;
  kinds?: SensitiveKind[];
}

export type RetrieveSensitiveResult =
  | { status: 'ok'; value: string }
  | { status: 'not-found' }
  | { status: 'key-mismatch'; message: string; payloadKeyId?: string; currentKeyId: string }
  | { status: 'corrupt'; message: string };

export interface ResearchKnowledgeInput {
  userId: string;
  title: string;
  content: string;
  sourceUrl?: string;
  tags?: string[];
}

export interface ResearchKnowledgeResult {
  status: 'created' | 'duplicate' | 'rejected';
  item?: KnowledgeItem;
  /** Items removed by this call because they had expired or the per-user cap was reached. */
  pruned: number;
}

export interface MemoryManagerOptions {
  vault?: VaultKeyOptions;
  now?: () => number;
  /** How long a research item stays searchable; default 30 days. */
  knowledgeTtlMs?: number;
  /** Most research items kept per user; the oldest go first. Default 500. */
  knowledgeMaxItems?: number;
}

const DEFAULT_KNOWLEDGE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_KNOWLEDGE_MAX_ITEMS = 500;
const MAX_KNOWLEDGE_CONTENT_CHARS = 20_000;
const PROFILE_LINE_MAX_CHARS = 400;

function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function hashText(text: string, length = 8): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, length);
}

function searchTerms(text: string): string[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) ?? [];
  return [...new Set(words.filter((w) => w.length >= 2))];
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) count++;
  return count;
}

export class MemoryManager {
  private profileCollection: Collection<OwnerProfileFact>;
  private summaryCollection: Collection<SessionSummary>;
  private episodicCollection: Collection<EpisodicMemory>;
  private knowledgeCollection: Collection<KnowledgeItem>;
  private vaultCollection: Collection<EncryptedItem>;
  private readonly now: () => number;

  constructor(
    private store: DocumentStore,
    private options: MemoryManagerOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.profileCollection = this.store.getCollection<OwnerProfileFact>('owner_profile');
    this.summaryCollection = this.store.getCollection<SessionSummary>('session_summaries');
    this.episodicCollection = this.store.getCollection<EpisodicMemory>('episodic_memories');
    this.knowledgeCollection = this.store.getCollection<KnowledgeItem>('knowledge_items');
    this.vaultCollection = this.store.getCollection<EncryptedItem>('sensitive_vault');
  }

  /** Where the vault key lives, for the diagnostics page; never the key itself. */
  getVaultKeyPath(): string {
    return getVaultKeyPath(this.options.vault);
  }

  // --- T1: Owner Profile ---

  /**
   * Inserts or updates one profile fact. Plaintext memory never holds secrets: a sensitive value throws
   * `SensitiveValueError`; `rememberFact` is the entry point that routes those to the vault instead.
   */
  async setProfileFact(
    userId: string,
    key: string,
    value: string,
    category: OwnerProfileFact['category'] = 'preference',
    confidence = 1.0
  ): Promise<OwnerProfileFact> {
    return (await this.upsertProfileFact(userId, key, value, category, confidence)).fact;
  }

  async upsertProfileFact(
    userId: string,
    key: string,
    value: string,
    category: OwnerProfileFact['category'] = 'preference',
    confidence = 1.0
  ): Promise<{ fact: OwnerProfileFact; created: boolean }> {
    const scan = detectSensitive(`${key} is ${value}`);
    if (scan.sensitive) {
      throw new SensitiveValueError(scan.kinds);
    }
    return this.writeProfileFact(userId, key, value, category, confidence);
  }

  private writeProfileFact(
    userId: string,
    key: string,
    value: string,
    category: OwnerProfileFact['category'],
    confidence: number
  ): { fact: OwnerProfileFact; created: boolean } {
    return this.store.transaction(() => {
      const existing = this.profileCollection.findOne({ userId, key });
      const updatedAt = new Date(this.now()).toISOString();
      if (existing) {
        this.profileCollection.updateOne({ userId, key }, { value, category, confidence, updatedAt });
        return { fact: { ...existing, value, category, confidence, updatedAt }, created: false };
      }
      const fact: OwnerProfileFact = { userId, key, value, category, confidence, updatedAt };
      return { fact: this.profileCollection.insertUnique(fact), created: true };
    });
  }

  /**
   * Handles an explicit "remember that ..." command. A secret (password, API key, token, card or
   * SSN-like number) is encrypted into the vault and the profile gets only a non-secret pointer;
   * anything else is an ordinary profile fact. `created` is false when the key already existed.
   */
  async rememberFact(
    userId: string,
    command: { key: string; value: string },
    category: OwnerProfileFact['category'] = 'preference'
  ): Promise<RememberResult> {
    const scan = detectSensitive(`${command.key} is ${command.value}`);
    if (!scan.sensitive) {
      const { fact, created } = await this.upsertProfileFact(userId, command.key, command.value, category);
      return { stored: 'profile', key: fact.key, created };
    }

    // A key that itself contains the secret must not become a tag or a profile key.
    const tag = detectSensitive(command.key).sensitive ? `${scan.kinds[0]}-${hashText(command.value)}` : command.key;
    const created = this.store.transaction(() => {
      const isNew = !this.vaultCollection.findOne({ userId, tag });
      this.writeVault(userId, tag, command.value);
      this.writeProfileFact(userId, tag, `stored in vault: ${tag}`, category, 1.0);
      return isNew;
    });
    return { stored: 'vault', key: tag, tag, created, kinds: scan.kinds };
  }

  async getProfileFacts(userId: string, category?: OwnerProfileFact['category']): Promise<OwnerProfileFact[]> {
    const filter: Record<string, unknown> = { userId };
    if (category) {
      filter.category = category;
    }
    return this.profileCollection.find(filter);
  }

  /** Newest facts first, so when the budget runs out it is the oldest facts that are dropped. */
  async formatProfileForPrompt(userId: string, maxChars = 1500): Promise<string> {
    const facts = newestFirst(await this.getProfileFacts(userId), (fact) => fact.updatedAt);
    if (facts.length === 0) {
      return '';
    }

    const lines = ['### Owner Profile & Style Preferences'];
    let currentLength = lines[0].length;

    for (const fact of facts) {
      // Collapsing whitespace keeps a stored value from forging extra prompt lines or headings.
      const value = redactSensitive(fact.value).replace(/\s+/g, ' ').trim();
      const line = `- **${fact.key}** (${fact.category}): ${value}`.slice(0, PROFILE_LINE_MAX_CHARS);
      if (currentLength + line.length + 1 > maxChars) {
        continue;
      }
      lines.push(line);
      currentLength += line.length + 1;
    }

    return lines.length > 1 ? lines.join('\n') : '';
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
      id: newId('summary'),
      userId,
      sessionId,
      summary: redactSensitive(summary),
      turnCount,
      keyFacts: keyFacts.map(redactSensitive),
      createdAt: new Date(this.now()).toISOString(),
    };
    this.summaryCollection.insertUnique(doc);
    return doc;
  }

  async getSessionSummaries(userId: string, sessionId?: string, limit = 5): Promise<SessionSummary[]> {
    const filter: Record<string, unknown> = { userId };
    if (sessionId) {
      filter.sessionId = sessionId;
    }
    const all = await this.summaryCollection.find(filter);
    return newestByCreatedAt(all).slice(0, limit);
  }

  // --- T3: Episodic Memory ---

  async recordEpisode(episode: Omit<EpisodicMemory, 'id' | 'createdAt'>): Promise<EpisodicMemory> {
    const doc: EpisodicMemory = {
      ...episode,
      goal: redactSensitive(episode.goal),
      outcome: redactSensitive(episode.outcome),
      steps: episode.steps.map(redactSensitive),
      id: newId('ep'),
      createdAt: new Date(this.now()).toISOString(),
    };
    this.episodicCollection.insertUnique(doc);
    return doc;
  }

  async queryEpisodes(filter: Partial<Pick<EpisodicMemory, 'userId' | 'sessionId' | 'feedback'>>, limit = 10): Promise<EpisodicMemory[]> {
    const all = await this.episodicCollection.find(filter as Record<string, unknown>);
    return newestByCreatedAt(all).slice(0, limit);
  }

  // --- T4: Knowledge Memory ---

  async saveKnowledge(item: Omit<KnowledgeItem, 'id' | 'createdAt'>): Promise<KnowledgeItem> {
    const doc: KnowledgeItem = {
      ...item,
      id: newId('know'),
      createdAt: new Date(this.now()).toISOString(),
    };
    this.knowledgeCollection.insertUnique(doc);
    return doc;
  }

  /**
   * Stores a researched page or answer. The same content (after whitespace and case folding) is kept once
   * per user: a repeat refreshes the stored item's expiry instead of adding a copy. Expired items and
   * items beyond the per-user cap are pruned in the same transaction. The text came from the web, so it
   * is stored `untrusted` and only ever shown to a model as fenced data.
   */
  async saveResearchKnowledge(input: ResearchKnowledgeInput): Promise<ResearchKnowledgeResult> {
    const content = input.content.trim().slice(0, MAX_KNOWLEDGE_CONTENT_CHARS);
    const title = input.title.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!input.userId || !content || !title) {
      return { status: 'rejected', pruned: 0 };
    }
    const contentHash = hashText(content.toLowerCase().replace(/\s+/g, ' '), 32);
    const nowMs = this.now();
    const expiresAt = new Date(nowMs + (this.options.knowledgeTtlMs ?? DEFAULT_KNOWLEDGE_TTL_MS)).toISOString();

    return this.store.transaction(() => {
      const pruned = this.pruneKnowledge(input.userId);
      const duplicate = this.knowledgeCollection.findOne({ userId: input.userId, contentHash });
      if (duplicate) {
        this.knowledgeCollection.updateOne({ id: duplicate.id }, { expiresAt });
        return { status: 'duplicate' as const, item: { ...duplicate, expiresAt }, pruned };
      }
      const item: KnowledgeItem = {
        id: newId('know'),
        userId: input.userId,
        title,
        content,
        sourceUrl: input.sourceUrl,
        tags: [...new Set((input.tags ?? []).map((tag) => tag.trim().toLowerCase()).filter(Boolean))],
        createdAt: new Date(nowMs).toISOString(),
        contentHash,
        expiresAt,
        untrusted: true,
      };
      this.knowledgeCollection.insertUnique(item);
      return { status: 'created' as const, item, pruned: pruned + this.enforceKnowledgeCap(input.userId) };
    });
  }

  /** Removes the user's expired research items; returns how many. */
  async pruneExpiredKnowledge(userId: string): Promise<number> {
    return this.store.transaction(() => this.pruneKnowledge(userId));
  }

  private pruneKnowledge(userId: string): number {
    const nowMs = this.now();
    let removed = 0;
    for (const item of this.knowledgeCollection.find({ userId })) {
      if (item.expiresAt && new Date(item.expiresAt).getTime() <= nowMs) {
        removed += this.knowledgeCollection.deleteOne({ id: item.id }) ? 1 : 0;
      }
    }
    return removed;
  }

  private enforceKnowledgeCap(userId: string): number {
    const max = this.options.knowledgeMaxItems ?? DEFAULT_KNOWLEDGE_MAX_ITEMS;
    const items = this.knowledgeCollection.find({ userId });
    let removed = 0;
    // `find()` is oldest first, so the surplus at the front is the oldest.
    for (const item of items.slice(0, Math.max(0, items.length - max))) {
      removed += this.knowledgeCollection.deleteOne({ id: item.id }) ? 1 : 0;
    }
    return removed;
  }

  /**
   * Ranks the user's unexpired knowledge by how many of the query's words it contains: a tag hit counts
   * most, then a title hit, then body occurrences (capped). Items with no hit are not returned.
   */
  async searchKnowledge(userId: string, keyword: string, limit = 5): Promise<KnowledgeItem[]> {
    const terms = searchTerms(keyword);
    if (terms.length === 0) {
      return [];
    }
    const nowMs = this.now();
    const all = this.knowledgeCollection.find({ userId });
    const scored: Array<{ item: KnowledgeItem; score: number; order: number }> = [];
    all.forEach((item, order) => {
      if (item.expiresAt && new Date(item.expiresAt).getTime() <= nowMs) return;
      const title = item.title.toLowerCase();
      const content = item.content.toLowerCase();
      const tags = item.tags.map((tag) => tag.toLowerCase());
      let score = 0;
      for (const term of terms) {
        if (tags.some((tag) => tag === term)) score += 6;
        else if (tags.some((tag) => tag.includes(term))) score += 3;
        if (title.includes(term)) score += 4;
        score += Math.min(3, countOccurrences(content, term));
      }
      if (score > 0) scored.push({ item, score, order });
    });
    return scored
      .sort((a, b) => b.score - a.score || b.order - a.order)
      .slice(0, limit)
      .map(({ item }) => item);
  }

  // --- Sensitive Item Vault ---

  /** Encrypts and stores a secret under `tag`; an existing tag is overwritten and re-keyed to the current key. */
  async storeSensitive(userId: string, tag: string, plaintextSecret: string): Promise<void> {
    this.writeVault(userId, tag, plaintextSecret);
  }

  private writeVault(userId: string, tag: string, plaintextSecret: string): void {
    const encrypted = encryptSensitive(plaintextSecret, this.options.vault);
    const now = new Date(this.now()).toISOString();
    this.store.transaction(() => {
      const existing = this.vaultCollection.findOne({ userId, tag });
      if (existing) {
        this.vaultCollection.updateOne({ id: existing.id }, { ...encrypted, updatedAt: now });
      } else {
        this.vaultCollection.insertUnique({ id: newId('vault'), userId, tag, ...encrypted, createdAt: now });
      }
    });
  }

  /**
   * Decrypts a secret on explicit request; it is never injected into prompts. Null means no such tag.
   * Throws `VaultKeyMismatchError` when the vault key changed since the secret was stored, and
   * `VaultCorruptError` when the row is damaged. A legacy row is re-encrypted under the current key.
   */
  async retrieveSensitive(userId: string, tag: string): Promise<string | null> {
    const result = await this.retrieveSensitiveResult(userId, tag);
    switch (result.status) {
      case 'ok':
        return result.value;
      case 'not-found':
        return null;
      case 'key-mismatch':
        throw new VaultKeyMismatchError(result.payloadKeyId, result.currentKeyId);
      case 'corrupt':
        throw new VaultCorruptError(result.message);
    }
  }

  async retrieveSensitiveResult(userId: string, tag: string): Promise<RetrieveSensitiveResult> {
    const record = this.vaultCollection.findOne({ userId, tag });
    if (!record) {
      return { status: 'not-found' };
    }
    const decrypted: DecryptResult = tryDecryptSensitive(
      { ciphertext: record.ciphertext, iv: record.iv, authTag: record.authTag, keyId: record.keyId },
      this.options.vault
    );
    if (!decrypted.ok) {
      return decrypted.error === 'key-mismatch'
        ? { status: 'key-mismatch', message: decrypted.message, payloadKeyId: record.keyId, currentKeyId: loadVaultKey(this.options.vault).keyId }
        : { status: 'corrupt', message: decrypted.message };
    }
    if (decrypted.legacy) {
      await this.storeSensitive(userId, tag, decrypted.plaintext);
    }
    return { status: 'ok', value: decrypted.plaintext };
  }

  /** Tags only, never values. */
  async listSensitiveTags(userId: string): Promise<string[]> {
    return this.vaultCollection.find({ userId }).map((record) => record.tag);
  }

  async deleteSensitive(userId: string, tag: string): Promise<boolean> {
    const removed = this.vaultCollection.deleteOne({ userId, tag });
    this.profileCollection.deleteOne({ userId, key: tag, value: `stored in vault: ${tag}` });
    return removed;
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
