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
  summary: string;
  suggestedAction: 'reply' | 'archive' | 'review';
  draftReply?: string;
  status: EmailStatus;
  isUntrusted: boolean; // Always true for external email content per Principle 2
  createdAt: string;
}

export interface SendEmailPayload {
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  ownerApprovalToken?: string;
}
