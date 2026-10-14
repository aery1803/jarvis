import { DocumentStore, Collection } from '../storage/collection.js';
import { ActionGateway } from '../devagent/action-gateway.js';
import type { EmailMessage, EmailImportance, SendEmailPayload } from './types.js';

export interface RawEmailInput {
  id?: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  date?: string;
}

export class EmailWatcher {
  private collection: Collection<EmailMessage>;

  constructor(
    private store: DocumentStore,
    private gateway?: ActionGateway
  ) {
    this.collection = this.store.getCollection<EmailMessage>('emails');
  }

  /**
   * Classifies email urgency and importance score based on subject, body, and sender.
   */
  classifyImportance(subject: string, body: string, from: string): { importance: EmailImportance; score: number } {
    const combined = `${subject} ${body}`.toLowerCase();
    let score = 0.3; // baseline normal

    const urgentKeywords = ['urgent', 'asap', 'immediately', 'security alert', 'action required', 'critical', 'breach'];
    const highKeywords = ['invoice', 'deadline', 'payment', 'contract', 'proposal', 'scheduled', 'review needed'];
    const lowKeywords = ['newsletter', 'unsubscribe', 'digest', 'promo', 'discount', 'sale', 'automated'];

    for (const kw of urgentKeywords) {
      if (combined.includes(kw)) {
        score += 0.35;
      }
    }
    for (const kw of highKeywords) {
      if (combined.includes(kw)) {
        score += 0.2;
      }
    }
    for (const kw of lowKeywords) {
      if (combined.includes(kw)) {
        score -= 0.25;
      }
    }

    score = Math.max(0.0, Math.min(1.0, score));

    let importance: EmailImportance = 'normal';
    if (score >= 0.75) {
      importance = 'urgent';
    } else if (score >= 0.55) {
      importance = 'high';
    } else if (score <= 0.25) {
      importance = 'low';
    }

    return { importance, score: parseFloat(score.toFixed(2)) };
  }

  /**
   * Ingests a new raw email message, classifies it, summarizes it, and marks as untrusted.
   */
  async ingestEmail(raw: RawEmailInput): Promise<EmailMessage> {
    const id = raw.id ?? `email-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const { importance, score } = this.classifyImportance(raw.subject, raw.body, raw.from);

    // Clean summary extraction
    const lines = raw.body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const summary = lines.slice(0, 3).join(' ') || raw.subject;

    const email: EmailMessage = {
      id,
      from: raw.from,
      to: raw.to,
      subject: raw.subject,
      date: raw.date ?? new Date().toISOString(),
      body: raw.body,
      importance,
      importanceScore: score,
      summary,
      suggestedAction: importance === 'urgent' || importance === 'high' ? 'reply' : 'archive',
      status: 'summarized',
      isUntrusted: true, // Untrusted external content per Principle 2
      createdAt: new Date().toISOString(),
    };

    await this.collection.insertOne(email);
    return email;
  }

  /**
   * Generates a context-aware draft reply (Tier 1 safe).
   */
  async generateDraft(emailId: string, customInstruction?: string): Promise<string> {
    const email = await this.collection.findOne({ id: emailId });
    if (!email) {
      throw new Error(`Email with ID ${emailId} not found.`);
    }

    const draft = `Hello,\n\nThank you for reaching out regarding "${email.subject}". ${
      customInstruction ? customInstruction : 'I have received your email and will follow up shortly.'
    }\n\nBest regards,\nJarvis Assistant (on behalf of Owner)`;

    await this.collection.updateOne(
      { id: emailId },
      { draftReply: draft, status: 'waiting_approval' }
    );

    return draft;
  }

  /**
   * Sends an email response.
   * STRICT GUARD: Autonomous sending is forbidden. Requires explicit owner approval (Tier 2).
   */
  async sendEmail(payload: SendEmailPayload, isOwnerExplicitlyApproved = false): Promise<{ sent: boolean; messageId: string }> {
    if (!isOwnerExplicitlyApproved) {
      throw new Error(
        'Action Forbidden: Autonomous email sending is strictly prohibited by Action Gateway Tier 2 policy. Explicit owner approval required.'
      );
    }

    // Enforce memory governor headroom if gateway is present
    if (this.gateway) {
      this.gateway.verifyMemoryHeadroom();
    }

    const messageId = `msg-${Date.now()}`;
    if (payload.inReplyTo) {
      await this.collection.updateOne({ id: payload.inReplyTo }, { status: 'replied' });
    }

    return { sent: true, messageId };
  }

  async listEmails(filter?: Partial<Pick<EmailMessage, 'importance' | 'status'>>): Promise<EmailMessage[]> {
    const all = await this.collection.find(filter as Record<string, unknown>);
    return all.sort((a, b) => b.importanceScore - a.importanceScore);
  }
}
