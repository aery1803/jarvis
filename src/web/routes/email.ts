/**
 * Jarvis Local AI Agent: Web routes for the email inbox
 * Authority: Principle 2 (external content is untrusted), CODING_RULES.md section 5 (sending is Tier 2)
 *
 * Mail is ingested locally (pasted or posted; there is no mailbox sync without a transport). Bodies are untrusted
 * data and only ever shown as text. Sending needs a configured transport and a real owner approval each time.
 */

import { z } from 'zod';
import type { EmailMessage } from '../../email/types.js';
import { HttpError, errorMessage, lengthProblem, refuseIfKilled, type Route, type RouteContext } from './types.js';
import { withInstalledModel } from './llm.js';
import type { ApprovalFlow } from './approval-flow.js';
import { approvalArgsMetadata, formatApprovalAction } from '../../security/approval-text.js';

const ADDRESS_PATTERN = /^[^\s@,;<>()]+@[^\s@,;<>()]+\.[^\s@,;<>()]+$/;
const BODY_PREVIEW_CHARS = 4000;
const EMAIL_BODY_LIMIT_BYTES = 1024 * 1024;

const EMAIL_ID_PATTERN = /^[\w.:@-]{1,200}$/;

const IngestSchema = z.object({
  id: z.string().optional(),
  from: z.string().min(1),
  to: z.string().min(1),
  subject: z.string(),
  body: z.string().min(1),
  date: z.string().optional(),
  summarize: z.boolean().optional(),
});
const INGEST_LIMITS = { from: 320, to: 320, subject: 500, body: 200_000, date: 100 };
const DraftSchema = z.object({ instruction: z.string().optional() });
const SendSchema = z.object({
  to: z.string().optional(),
  subject: z.string().optional(),
  body: z.string().optional(),
});
const SEND_LIMITS = { to: 320, subject: 300, body: 20_000 };
const MAX_INSTRUCTION_CHARS = 1000;

function emailView(email: EmailMessage): Record<string, unknown> {
  return {
    id: email.id,
    from: email.from,
    to: email.to,
    subject: email.subject,
    date: email.date,
    importance: email.importance,
    importanceScore: email.importanceScore,
    excerpt: email.excerpt,
    // `excerpt` is the first lines verbatim; only `summary` was written by a model.
    summary: email.summary ?? null,
    suggestedAction: email.suggestedAction,
    draftReply: email.draftReply ?? null,
    draftKind: email.draftKind ?? null,
    status: email.status,
    sentMessageId: email.sentMessageId ?? null,
    untrusted: true,
    bodyPreview: email.body.slice(0, BODY_PREVIEW_CHARS),
  };
}

function notFoundAware(err: unknown): never {
  const message = errorMessage(err);
  throw new HttpError(/not found/i.test(message) ? 404 : 500, message);
}

export function createEmailRoutes(flow: ApprovalFlow): Route[] {
  const list = async (ctx: RouteContext): Promise<void> => {
    const emails = await ctx.rt.email.listEmails();
    ctx.json(200, {
      emails: emails.map(emailView),
      transportConfigured: ctx.rt.getStatus().email.transportConfigured,
      sends: flow.list('email_send'),
    });
  };

  const ingest = async (ctx: RouteContext): Promise<void> => {
    if (refuseIfKilled(ctx)) return;
    const body = IngestSchema.safeParse(await ctx.readBody(EMAIL_BODY_LIMIT_BYTES));
    const problem = body.success ? lengthProblem(body.data, INGEST_LIMITS) : null;
    if (!body.success || problem || (body.data.id !== undefined && !EMAIL_ID_PATTERN.test(body.data.id)) || body.data.from.trim() === '' || body.data.to.trim() === '') {
      ctx.json(400, { error: problem ?? 'Send {"from","to","subject","body"} (body up to 200000 characters).' });
      return;
    }
    const { summarize, ...raw } = { ...body.data, from: body.data.from.trim(), to: body.data.to.trim() };
    const email = await ctx.rt.email.ingestEmail(raw);
    let summaryError: string | undefined;
    if (summarize !== false && email.summary === undefined) {
      try {
        await withInstalledModel(ctx, ctx.defaultModel, () => ctx.rt.email.summarize(email.id));
      } catch (err: unknown) {
        summaryError = errorMessage(err);
      }
    }
    const stored = (await ctx.rt.email.listEmails()).find((candidate) => candidate.id === email.id) ?? email;
    ctx.json(201, { email: emailView(stored), ...(summaryError ? { summaryError: `No model summary was written: ${summaryError}` } : {}) });
  };

  const draft = async (ctx: RouteContext): Promise<void> => {
    if (refuseIfKilled(ctx)) return;
    const body = DraftSchema.safeParse(await ctx.readBody());
    if (!body.success || lengthProblem(body.data, { instruction: MAX_INSTRUCTION_CHARS })) {
      ctx.json(400, { error: 'Invalid request (instruction up to 1000 characters).' });
      return;
    }
    const id = ctx.params[0] ?? '';
    try {
      // A model failure falls back to a fixed template that says so (`kind: 'template'`), never to invented prose.
      const result = await ctx.rt.email.generateDraftDetailed(id, body.data.instruction);
      ctx.json(200, { id, draft: result.draft, kind: result.kind, ...(result.fallbackReason ? { fallbackReason: result.fallbackReason } : {}) });
    } catch (err: unknown) {
      notFoundAware(err);
    }
  };

  const send = async (ctx: RouteContext): Promise<void> => {
    if (refuseIfKilled(ctx)) return;
    const { rt } = ctx;
    const body = SendSchema.safeParse(await ctx.readBody());
    if (!body.success || lengthProblem(body.data, SEND_LIMITS)) {
      ctx.json(400, { error: 'Invalid request (to up to 320, subject up to 300, body up to 20000 characters).' });
      return;
    }
    const id = ctx.params[0] ?? '';
    const email = (await rt.email.listEmails()).find((candidate) => candidate.id === id);
    if (!email) {
      ctx.json(404, { error: `Email with ID ${id} not found.` });
      return;
    }
    if (!rt.getStatus().email.transportConfigured) {
      ctx.json(503, { error: 'No email transport is configured, so nothing can be sent. Draft replies stay on this page.' });
      return;
    }
    const to = body.data.to?.trim() || email.from;
    const subject = body.data.subject || (/^re:/i.test(email.subject) ? email.subject : `Re: ${email.subject}`);
    const text = body.data.body || email.draftReply;
    if (!text) {
      ctx.json(400, { error: 'There is no reply text yet. Draft one first, or send a "body".' });
      return;
    }
    if (!ADDRESS_PATTERN.test(to)) {
      ctx.json(400, { error: `"${to.slice(0, 100)}" is not a plain recipient address.` });
      return;
    }
    if (/[\r\n]/.test(subject)) {
      ctx.json(400, { error: 'The subject must be a single line.' });
      return;
    }
    const action = formatApprovalAction('email_send', { to, subject, body: text, inReplyTo: id }, ['to', 'subject', 'body', 'inReplyTo']);
    if (action.unshowable) {
      ctx.json(400, { error: `Refused before asking: ${action.unshowable}.` });
      return;
    }
    const requestId = flow.start(rt, {
      kind: 'email_send',
      description: action.text,
      metadata: { emailId: id, args: approvalArgsMetadata(action) },
      run: async () => {
        const sent = await rt.email.sendEmail({ to, subject, body: text, inReplyTo: id }, true);
        return `Sent (message id ${sent.messageId}).`;
      },
    });
    ctx.json(202, { requestId, status: 'pending_approval', to, subject });
  };

  return [
    { method: 'GET', pattern: /^\/api\/email$/, handler: list },
    { method: 'POST', pattern: /^\/api\/email\/ingest$/, handler: ingest },
    { method: 'POST', pattern: /^\/api\/email\/([^/]+)\/draft$/, handler: draft },
    { method: 'POST', pattern: /^\/api\/email\/([^/]+)\/send$/, handler: send },
  ];
}
