/**
 * Jarvis Local AI Agent: Runtime Tool Registration
 * Authority: Section 5.3 (tool calling), CODING_RULES.md section 5 (action tiers)
 *
 * Registers the real tools into the shared `ToolRegistry`. `system_stats`, `web_search` and `file_read` come from
 * `registerBuiltinTools`; the ones here need subsystems that only the runtime holds.
 *
 * Tiers: the executor runs every call through the Action Gateway as `TOOL_CALL` with the tool's own tier, so a
 * Tier 2 tool waits for a real owner approval from the `ApprovalBroker`. `host_command` and `run_skill` are
 * registered as Tier 1 because their tier depends on the arguments (the command line, the skill); their handlers
 * ask the owner through the gateway themselves when the tier turns out to be 2. A tool whose backend is missing
 * returns an explicit `unavailable` reason, never made-up data. Everything a tool returns is untrusted and is
 * fenced again by `fenceToolResult` before it reaches a prompt.
 */

import type { ToolDefinition, ToolHandlerContext } from '../tools/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { MemoryManager } from '../memory/manager.js';
import type { SkillGenerator } from '../skills/generator.js';
import type { MultiAgentOrchestrator } from '../agents/orchestrator.js';
import type { HostBridge } from '../bridge/host.js';
import type { MobileBridge } from '../bridge/mobile.js';
import type { MobileDeviceStatus } from '../bridge/types.js';
import type { EmailWatcher } from '../email/watcher.js';
import { EmailTransportUnavailableError } from '../email/watcher.js';
import type { EmailStatus } from '../email/types.js';
import type { BrowserAutomationEngine } from '../browser/automation.js';
import type { ActionGateway } from '../devagent/action-gateway.js';
import { fenceUntrusted } from '../bridge/untrusted.js';
import { clampText } from '../memory/context-builder.js';
import { ActionApprovalDeniedError } from '../devagent/action-gateway.js';
import { approvalArgsMetadata, formatApprovalAction } from '../security/approval-text.js';
import { detectSensitive } from '../memory/sensitive.js';
import type { ApprovalBroker } from '../security/approvals.js';
import { SignalBoundBroker } from './signal-broker.js';

export interface RuntimeToolDeps {
  tools: ToolRegistry;
  ownerUserId: string;
  memory: MemoryManager;
  skills: SkillGenerator;
  orchestrator: MultiAgentOrchestrator;
  host: HostBridge;
  mobile: MobileBridge;
  email: EmailWatcher;
  /** Whether a real mail backend exists; without one `email_send` reports that nothing was sent. */
  emailTransportConfigured: boolean;
  browser: BrowserAutomationEngine;
  gateway: ActionGateway;
  /** The owner-approval broker the gateway asks; a tool's own approval wait is bound to its turn's signal. */
  broker: ApprovalBroker;
  /** How long the broker waits for the owner; a tool that can ask must not time out before then. */
  approvalTimeoutMs: number;
}

/** Longest query a model may send to the search engine, and longest URL it may send a page fetch to. */
export const MAX_SEARCH_QUERY_CHARS = 300;
export const MAX_FETCH_URL_CHARS = 2048;

/**
 * Model-chosen text that leaves the machine (a search query, a page URL) could carry something private it was shown
 * earlier in the turn. Detected secrets are refused and lengths are capped; the owner sees the exact text in the
 * tool event. Residual risk: a name, an address or a sentence from memory or email is not a pattern this can detect,
 * so it can still be sent to the search engine or to the page's host.
 */
function assertSafeOutbound(label: string, value: string, maxChars: number): void {
  if (value.length > maxChars) throw new Error(`Refused: the ${label} is ${value.length} characters long (limit ${maxChars}).`);
  const scan = detectSensitive(value);
  if (scan.sensitive) throw new Error(`Refused: the ${label} contains what looks like a secret (${scan.kinds.join(', ')}); it was not sent anywhere.`);
}

/** Why a Tier 2 step must stop: the turn that asked for it was stopped, timed out or killed. */
function assertTurnLive(context: ToolHandlerContext | undefined, what: string): void {
  if (context?.signal.aborted) throw new Error(`${what} was not run: the turn that asked for it was stopped before it could start.`);
}

const EMAIL_STATUSES: EmailStatus[] = ['unread', 'summarized', 'waiting_approval', 'replied', 'archived'];
const MAX_LISTED_EMAILS = 20;
const MAX_LISTED_NOTIFICATIONS = 10;
const MAX_KNOWLEDGE_CHARS = 800;

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * What a nested Tier 2 gateway call shows the owner: every argument, security-relevant ones first, never a clamped
 * preview. An action whose security-relevant value is too long to show in full is refused without asking.
 */
function approvalPrompt(
  tool: string,
  args: Record<string, unknown>,
  order: readonly string[],
  note?: string
): { description: string; metadata: Record<string, unknown> } {
  const action = formatApprovalAction(tool, args, order);
  if (action.unshowable) {
    throw new ActionApprovalDeniedError(`Refused before asking the owner: ${action.unshowable}, so the approval prompt could not show the whole action.`);
  }
  return {
    description: note ? `${action.text}\n${note}` : action.text,
    metadata: { tool, args: approvalArgsMetadata(action), ...(note ? { reason: note } : {}) },
  };
}

/** Registers every runtime-backed tool; a tool that cannot be registered is reported, never thrown. */
export function registerRuntimeTools(deps: RuntimeToolDeps): { registered: string[]; rejected: Array<{ name: string; reason: string }> } {
  const { memory, skills, orchestrator, host, mobile, email, browser, gateway, ownerUserId } = deps;
  // The tool timeout also covers an approval wait inside the handler, so it must outlast the broker's own timeout.
  const approvalAllowanceMs = deps.approvalTimeoutMs;

  const definitions: ToolDefinition[] = [
    {
      name: 'browse_page',
      description: 'Fetch a public web page by URL and return its readable text (private and local addresses are blocked).',
      tier: 1,
      source: 'runtime',
      timeoutMs: 30_000,
      maxResultChars: 12_000,
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'http(s) URL of the page', minLength: 8, maxLength: MAX_FETCH_URL_CHARS } },
        required: ['url'],
      },
      handler: async (args: { url: string }) => {
        assertSafeOutbound('URL', args.url, MAX_FETCH_URL_CHARS);
        const result = await browser.executeAction({ type: 'navigate', url: args.url });
        if (!result.success || !result.pageView) {
          throw new Error(result.message ?? `Could not load ${args.url}`);
        }
        const view = result.pageView;
        return {
          url: view.url,
          title: view.title,
          content: view.fencedText ?? fenceUntrusted('web', view.extractedText, { url: view.url }),
          estimatedTokens: view.estimatedTokens,
        };
      },
    },
    {
      name: 'memory_search',
      description: "Search the owner's saved research knowledge (earlier web research) by keywords.",
      tier: 1,
      source: 'runtime',
      maxResultChars: 8_000,
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keywords to look for', minLength: 1, maxLength: 300 },
          limit: { type: 'integer', description: 'Most items to return (default 5)', minimum: 1, maximum: 10 },
        },
        required: ['query'],
      },
      handler: async (args: { query: string; limit?: number }) => {
        const items = await memory.searchKnowledge(ownerUserId, args.query, args.limit ?? 5);
        return {
          count: items.length,
          items: items.map((item) => ({
            title: item.title,
            sourceUrl: item.sourceUrl,
            savedAt: item.createdAt,
            untrusted: item.untrusted === true,
            content: clampText(item.content, MAX_KNOWLEDGE_CHARS),
          })),
        };
      },
    },
    {
      name: 'list_skills',
      description: 'List the active, sandbox-tested skills Jarvis can run, with their ids, descriptions and required tier.',
      tier: 1,
      source: 'runtime',
      maxResultChars: 8_000,
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        const active = await skills.listSkills({ status: 'active' });
        return {
          count: active.length,
          skills: active.map((skill) => ({
            id: skill.id,
            name: skill.name,
            description: skill.description,
            requiredTier: skill.requiredTier,
            parametersSchema: skill.parametersSchema,
            author: skill.author,
          })),
        };
      },
    },
    {
      name: 'run_skill',
      description: 'Run an active skill by id inside the sandbox. A Tier 2 skill needs the owner approval every time it runs.',
      tier: 1,
      source: 'runtime',
      timeoutMs: 60_000 + approvalAllowanceMs,
      maxResultChars: 8_000,
      parameters: {
        type: 'object',
        properties: {
          skillId: { type: 'string', description: 'Id from list_skills', minLength: 1, maxLength: 200 },
          input: { description: 'JSON input handed to the skill' },
        },
        required: ['skillId'],
      },
      handler: async (args: { skillId: string; input?: unknown }, context?: ToolHandlerContext) => {
        const skill = await skills.getSkill(args.skillId);
        if (!skill) throw new Error(`Skill ${args.skillId} not found`);

        const run = (ownerApproved: boolean) => skills.runSkill(skill.id, args.input, { ownerApproved, isTainted: true });
        const outcome =
          skill.requiredTier === 2
            ? // `ownerApproved` is only true inside the gateway handler, which runs after the broker approved this run.
              await gateway.executeAction(
                {
                  tier: 2,
                  actionType: 'TOOL_CALL',
                  targetId: skill.id,
                  ...approvalPrompt('run_skill', { skillId: skill.id, skillName: skill.name, input: args.input }, ['skillId', 'skillName', 'input']),
                },
                () => {
                  // An approval that arrives after the turn was stopped or timed out must not run the skill.
                  assertTurnLive(context, `Skill '${skill.name}'`);
                  return run(true);
                },
                { requestedBy: 'jarvis', broker: new SignalBoundBroker(deps.broker, context?.signal) }
              )
            : await run(false);
        return {
          ok: outcome.ok,
          output: outcome.output,
          error: outcome.error,
          durationMs: outcome.durationMs,
          isTainted: outcome.isTainted,
          logs: outcome.logs.slice(0, 20),
        };
      },
    },
    {
      name: 'research',
      description: 'Research a question on the web with sources, verification and a source-agreement score (slow: searches, reads pages, cross-checks).',
      tier: 1,
      source: 'runtime',
      timeoutMs: 240_000,
      maxResultChars: 12_000,
      parameters: {
        type: 'object',
        properties: { goal: { type: 'string', description: 'What to find out', minLength: 3, maxLength: 1000 } },
        required: ['goal'],
      },
      handler: async (args: { goal: string }, context) => {
        const result = await orchestrator.runCoordinatedPipeline(args.goal, { signal: context?.signal });
        return {
          status: result.status,
          ...(result.status === 'unavailable' ? { unavailable: result.finalAnswer } : { answer: result.finalAnswer }),
          sources: result.sources.map((source) => ({ url: source.url, title: source.title, origin: source.origin })),
          consensus: result.consensus,
          degraded: result.degraded,
          isTainted: true,
        };
      },
    },
    {
      name: 'host_command',
      description:
        'Run a command on the owner\'s computer. Read-only commands (git status/log/diff, ls, cat inside the workspace, node -v) run directly; anything else needs the owner approval.',
      tier: 1,
      source: 'runtime',
      timeoutMs: 120_000 + approvalAllowanceMs,
      maxResultChars: 8_000,
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command or command line', minLength: 1, maxLength: 500 },
          args: { type: 'array', description: 'Arguments, one per item', items: { type: 'string', maxLength: 500 } },
        },
        required: ['command'],
      },
      handler: async (args: { command: string; args?: string[] }, context?: ToolHandlerContext) => {
        const command = { command: args.command, args: args.args };
        const classification = host.classifyCommand(command);
        // The gateway call below is the one approval and the one audit entry; the bridge must not repeat either.
        const run = (approved: boolean) => host.executeCommand(command, approved, { approvalAuditedByCaller: approved });
        const result =
          classification.tier === 2
            ? await gateway.executeAction(
                {
                  tier: 2,
                  actionType: 'HOST_COMMAND',
                  targetId: (args.command.trim().split(/\s+/)[0] ?? 'host').slice(0, 64),
                  ...approvalPrompt('host_command', { command: args.command, args: args.args }, ['command', 'args'], `Needs approval because: ${classification.reason}`),
                },
                () => {
                  assertTurnLive(context, 'The host command');
                  return run(true);
                },
                { requestedBy: 'jarvis', broker: new SignalBoundBroker(deps.broker, context?.signal) }
              )
            : await run(false);
        return { tier: classification.tier, ...result };
      },
    },
    {
      name: 'phone_status',
      description: "Battery and connection status of the owner's connected phone (read-only, over adb).",
      tier: 1,
      source: 'runtime',
      maxResultChars: 4_000,
      parameters: {
        type: 'object',
        properties: { deviceId: { type: 'string', description: 'Device serial; omit for every connected phone', maxLength: 64 } },
      },
      handler: async (args: { deviceId?: string }) => {
        let devices: MobileDeviceStatus[];
        try {
          devices = await mobile.refreshDevices();
        } catch (err: unknown) {
          return { available: false, reason: `The phone transport failed: ${errorMessage(err)}` };
        }
        if (devices.length === 0) {
          return { available: false, reason: 'No phone is connected: adb reported no devices (adb may not be installed, or USB debugging is off).' };
        }
        const selected = args.deviceId ? devices.filter((device) => device.deviceId === args.deviceId) : devices;
        if (selected.length === 0) {
          return { available: false, reason: `Device ${args.deviceId} is not among the connected devices.` };
        }
        // A device that was seen but not read must not pass its nulls through as a working phone.
        const readable = selected.filter((device) => device.connected && typeof device.batteryLevel === 'number');
        const unreadable = selected
          .filter((device) => !readable.includes(device))
          .map((device) => ({ deviceId: device.deviceId, state: device.state ?? (device.connected ? 'unknown' : 'disconnected'), reason: device.unavailableReason ?? 'The device did not report a battery level.' }));
        if (readable.length === 0) {
          return { available: false, reason: unreadable.map((device) => `${device.deviceId}: ${device.reason}`).join(' '), devices: unreadable };
        }
        return { available: true, devices: readable, ...(unreadable.length > 0 ? { unavailableDevices: unreadable } : {}) };
      },
    },
    {
      name: 'phone_notifications',
      description: "Recent notifications from the owner's phone (read-only).",
      tier: 1,
      source: 'runtime',
      maxResultChars: 8_000,
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        try {
          await mobile.pullNotifications();
        } catch (err: unknown) {
          return { available: false, reason: `The phone transport failed: ${errorMessage(err)}` };
        }
        const notifications = mobile.listNotifications(MAX_LISTED_NOTIFICATIONS);
        return {
          available: true,
          count: notifications.length,
          note: 'An empty list means the transport reported none; the built-in adb transport cannot read notifications yet.',
          notifications: fenceUntrusted(
            'phone',
            notifications.map((n) => `- [${n.appName}] ${n.title}: ${n.text}`).join('\n')
          ),
        };
      },
    },
    {
      name: 'email_list',
      description: "List the owner's stored emails with sender, subject, importance, status and a summary or excerpt.",
      tier: 1,
      source: 'runtime',
      maxResultChars: 10_000,
      parameters: {
        type: 'object',
        properties: { status: { type: 'string', description: 'Only emails in this status', enum: EMAIL_STATUSES } },
      },
      handler: async (args: { status?: EmailStatus }) => {
        const emails = (await email.listEmails(args.status ? { status: args.status } : undefined)).slice(0, MAX_LISTED_EMAILS);
        const lines = emails.map((message) => {
          const text = message.summary ? `summary: ${message.summary}` : `excerpt (not a summary): ${message.excerpt}`;
          return `id=${message.id} | ${message.importance} | ${message.status} | from ${message.from} | subject: ${message.subject} | ${oneLine(text)}`;
        });
        return { count: emails.length, emails: fenceUntrusted('email', lines.join('\n')) };
      },
    },
    {
      name: 'email_draft',
      description: 'Draft (never send) a reply to a stored email, optionally following an instruction from the owner.',
      tier: 1,
      source: 'runtime',
      timeoutMs: 120_000,
      maxResultChars: 8_000,
      parameters: {
        type: 'object',
        properties: {
          emailId: { type: 'string', description: 'Id from email_list', minLength: 1, maxLength: 200 },
          instruction: { type: 'string', description: 'What the reply should say', maxLength: 1000 },
        },
        required: ['emailId'],
      },
      handler: async (args: { emailId: string; instruction?: string }) => {
        const result = await email.generateDraftDetailed(args.emailId, args.instruction);
        return {
          kind: result.kind,
          ...(result.fallbackReason ? { fallbackReason: result.fallbackReason } : {}),
          draft: fenceUntrusted('email-draft', result.draft),
          note: 'This is a draft only; nothing was sent.',
        };
      },
    },
    {
      name: 'email_send',
      description: 'Send an email. Needs the owner approval every time, and a configured mail transport.',
      tier: 2,
      source: 'runtime',
      timeoutMs: 60_000,
      maxResultChars: 2_000,
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient address', minLength: 3, maxLength: 320 },
          subject: { type: 'string', description: 'Single-line subject', minLength: 1, maxLength: 300 },
          body: { type: 'string', description: 'Message body', minLength: 1, maxLength: 20_000 },
          inReplyTo: { type: 'string', description: 'Id of the stored email this answers', maxLength: 200 },
        },
        required: ['to', 'subject', 'body'],
      },
      // Reached only after the executor's gateway call obtained a real owner approval from the broker.
      handler: async (args: { to: string; subject: string; body: string; inReplyTo?: string }) => {
        if (!deps.emailTransportConfigured) throw new EmailTransportUnavailableError();
        return email.sendEmail({ to: args.to, subject: args.subject, body: args.body, inReplyTo: args.inReplyTo }, true);
      },
    },
  ];

  // `web_search` comes from the builtin registration; the same outbound limits apply to it.
  const builtinSearch = deps.tools.getTool('web_search');
  if (builtinSearch) {
    deps.tools.unregister('web_search');
    definitions.push({
      ...builtinSearch,
      parameters: {
        ...builtinSearch.parameters,
        properties: {
          ...builtinSearch.parameters.properties,
          query: { ...builtinSearch.parameters.properties.query, maxLength: MAX_SEARCH_QUERY_CHARS },
        },
      },
      handler: async (args: { query: string }, context?: ToolHandlerContext) => {
        assertSafeOutbound('search query', args.query, MAX_SEARCH_QUERY_CHARS);
        return builtinSearch.handler(args, context);
      },
    });
  }

  return deps.tools.registerTools(definitions);
}
