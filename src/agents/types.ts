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
}

export interface AgentTaskResponse {
  taskId: string;
  agentRole: AgentRole;
  status: 'success' | 'failed' | 'aborted';
  output: string;
  isTainted: boolean;
  stepsTaken: number;
  tokensConsumed: number;
  durationMs: number;
  error?: string;
}

export interface BlackboardItem {
  key: string;
  value: unknown;
  sourceAgent: AgentRole;
  isTainted: boolean;
  timestamp: string;
}
