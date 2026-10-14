export type AgentRole = 'orchestrator' | 'researcher' | 'verifier' | 'watcher' | 'coder';

export interface AgentBudget {
  maxSteps: number;
  maxTokens: number;
  timeoutMs: number;
}

export interface AgentTaskRequest {
  id: string;
  assignedRole: AgentRole;
  goal: string;
  inputPayload: Record<string, unknown>;
  isTainted: boolean;
  budget?: Partial<AgentBudget>;
  /** Caller cancellation; combined with the budget timeout. */
  signal?: AbortSignal;
}

/** One piece of retrieved evidence. Always untrusted data. */
export interface AgentSource {
  url: string;
  title?: string;
  excerpt: string;
  /** `page` = fetched page text, `snippet` = search-engine snippet only. */
  origin: 'page' | 'snippet';
}

export interface AgentConsensus {
  status: 'VERIFIED' | 'DISPUTED' | 'UNCONFIRMED';
  /** Source agreement 0..1; never proof of truth. 0 with `insufficientSources` set means nothing was compared, not disagreement. */
  score: number;
  /** Set when there was nothing to agree with: no readable source, a single one, or several from one origin. */
  insufficientSources?: 'none' | 'single_source' | 'same_origin';
  independentSources: number;
  summary: string;
}

/**
 * `unavailable` = the role has no real backend here (no search engine, no model, no probe) and did nothing;
 * `aborted` = stopped by the budget, the timeout or the caller's signal.
 */
export type AgentTaskStatus = 'success' | 'failed' | 'aborted' | 'unavailable';

export interface AgentTaskResponse {
  taskId: string;
  agentRole: AgentRole;
  status: AgentTaskStatus;
  output: string;
  isTainted: boolean;
  stepsTaken: number;
  /** Real prompt + completion tokens reported by the model backend (estimated only when `tokenCountsEstimated`). */
  tokensConsumed: number;
  durationMs: number;
  error?: string;
  /** Model that served the LLM calls of this task, when any were made. */
  modelId?: string;
  tokenCountsEstimated?: boolean;
  sources?: AgentSource[];
  consensus?: AgentConsensus;
  /** Set when the role degraded to a deterministic result because no model was available. */
  degraded?: string;
}

export interface BlackboardItem {
  key: string;
  value: unknown;
  sourceAgent: AgentRole;
  isTainted: boolean;
  timestamp: string;
}
