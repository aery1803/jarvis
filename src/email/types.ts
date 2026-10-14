export type EmailImportance = 'urgent' | 'high' | 'normal' | 'low';
export type EmailStatus = 'unread' | 'summarized' | 'waiting_approval' | 'replied' | 'archived';

export interface EmailMessage {
  id: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  body: string;
  importance: EmailImportance;
  importanceScore: number; // 0.0 to 1.0
  /** First lines of the body, verbatim. Not a summary. */
  excerpt: string;
  /** A real model-written summary; absent until `summarize` has run. */
  summary?: string;
  suggestedAction: 'reply' | 'archive' | 'review';
  draftReply?: string;
  /** `template` is the offline fixed-text fallback; `llm` was written by a model. */
  draftKind?: 'template' | 'llm';
  sentMessageId?: string;
  status: EmailStatus;
  isUntrusted: boolean; // Always true for external email content per Principle 2
  createdAt: string;
}

export interface RawEmailInput {
  id?: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  date?: string;
}

export interface SendEmailPayload {
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  ownerApprovalToken?: string;
}

/** The real mail backend (Gmail API, SMTP). The watcher never pretends to send without one. */
export interface EmailTransport {
  send(payload: SendEmailPayload): Promise<{ messageId: string }>;
  fetchInbox?(): Promise<RawEmailInput[]>;
}
