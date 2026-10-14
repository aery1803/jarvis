export type MemoryTier = 'T0' | 'T1' | 'T2' | 'T3' | 'T4';

export interface OwnerProfileFact {
  id?: string;
  _id?: string;
  userId: string;
  key: string;
  value: string;
  category: 'preference' | 'style' | 'habit' | 'rule' | 'contact';
  confidence?: number;
  updatedAt: string;
}

export interface SessionSummary {
  _id?: string;
  id: string;
  userId: string;
  sessionId: string;
  summary: string;
  turnCount: number;
  keyFacts?: string[];
  createdAt: string;
}

export interface EpisodicMemory {
  _id?: string;
  id: string;
  userId: string;
  sessionId: string;
  goal: string;
  steps: string[];
  outcome: string;
  feedback?: 'positive' | 'negative' | 'neutral' | string;
  tokensUsed?: number;
  executionTimeMs?: number;
  createdAt: string;
}

export interface KnowledgeItem {
  _id?: string;
  id: string;
  userId: string;
  title: string;
  content: string;
  sourceUrl?: string;
  tags: string[];
  createdAt: string;
  /** sha256 of the normalized content, set by `saveResearchKnowledge` to dedupe re-fetched pages. */
  contentHash?: string;
  /** Items past this ISO time are ignored by search and pruned on the next research save. */
  expiresAt?: string;
  /** True for text that came from the web; it is only ever shown to a model as fenced data. */
  untrusted?: boolean;
}

export interface EncryptedItem {
  _id?: string;
  id: string;
  userId: string;
  tag: string;
  ciphertext: string;
  iv: string;
  authTag: string;
  /** Id of the vault key that encrypted this row; absent on rows written before key ids existed. */
  keyId?: string;
  createdAt: string;
  updatedAt?: string;
}

export interface WorkingContext {
  activePlan?: string;
  currentTask?: string;
  recentTurns: Array<{ role: 'user' | 'assistant' | 'tool'; content: string }>;
}

export interface PromptContextOptions {
  userId: string;
  sessionId: string;
  maxTokens?: number;
  includeTiers?: MemoryTier[];
  workingContext?: WorkingContext;
}

export interface PromptContextResult {
  systemPromptAdditions: string;
  workingContextFormatted: string;
  totalEstimatedTokens: number;
  includedTiers: MemoryTier[];
}
