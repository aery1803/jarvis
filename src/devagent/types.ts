/**
 * Jarvis Local AI Agent: Dev Agent Type Definitions
 * Authority: jarvis-master-context.md Section 6.2, 17.6-17.12
 */

export type ProjectColumn = 'Concept' | 'Ready for Dev' | 'Code Review' | 'QA' | 'Done';

export type TicketType = 'Feature' | 'Story' | 'Bug';

export type GatewayTier = 1 | 2 | 3;

export type ActionType =
  | 'COMMENT'
  | 'CARD_MOVE'
  | 'BRANCH_CREATE'
  | 'PR_CREATE'
  | 'PR_MERGE'
  | 'PR_APPROVE'
  | 'LABEL_ADD'
  | 'LABEL_REMOVE'
  | 'SHELL_EXEC'
  | 'EMAIL_SEND';

export interface OwnActionRecord {
  id: string;
  actionType: ActionType;
  targetId: string;
  signature?: string;
  createdAt: string;
  metadata?: string;
}

export interface GatewayActionRequest {
  tier: GatewayTier;
  actionType: ActionType;
  targetId: string;
  description: string;
  metadata?: Record<string, unknown>;
}

export interface ProjectBoardItem {
  itemId: string;
  issueNumber: number;
  title: string;
  body: string;
  status: ProjectColumn;
  ticketType?: TicketType;
  labels: string[];
  url: string;
}

export interface TicketDirective {
  isDirective: boolean;
  command?: string;
  args?: string[];
  rawComment: string;
  author: string;
  commentId: string;
}

export interface ConceptPlan {
  understanding: string;
  proposedStories: Array<{ title: string; criteria: string[] }>;
  risksAndLimitations: string[];
  questions: Array<{
    id: number;
    question: string;
    options: string[];
    recommendation: string;
  }>;
}
