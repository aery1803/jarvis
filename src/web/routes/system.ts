/**
 * Jarvis Local AI Agent: Web routes for runtime state, models, tools, approvals, kill switch, phone and media
 * Authority: FEAT-004, CODING_RULES.md section 5
 */

import { z } from 'zod';
import { estimateRequirementBytes } from '../../orchestration/registry.js';
import { MAX_IMAGE_BYTES } from '../../media/service.js';
import { errorMessage, refuseIfKilled, refuseUnlessSameOriginBrowser, type Route, type RouteContext } from './types.js';

const MAX_LEDGER_ROWS = 100;
const MAX_NOTIFICATIONS = 20;
/** A 10 MiB image grows by a third as base64, and the JSON envelope adds a little. */
const MEDIA_BODY_LIMIT_BYTES = Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 64 * 1024;

const ApprovalDecisionSchema = z.object({ approved: z.boolean() });
const KillRequestSchema = z.object({ reason: z.string().optional() });
const MediaDescribeSchema = z.object({
  imageBase64: z.string().min(1),
  prompt: z.string().optional(),
});
const MAX_PROMPT_CHARS = 2000;
const MAX_KILL_REASON_CHARS = 300;

function parseLimit(raw: string | null, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, MAX_LEDGER_ROWS) : fallback;
}

async function handleModels(ctx: RouteContext): Promise<void> {
  const { rt } = ctx;
  const inventory = await rt.refreshInventory();
  if (inventory.lastGoodAt === null) {
    ctx.json(503, {
      error: `Ollama is unreachable at ${rt.config.ollamaBaseUrl}${inventory.error ? `: ${inventory.error}` : ''}`,
      models: [],
      active: ctx.defaultModel,
      status: inventory.status,
    });
    return;
  }

  const loadedByName = new Map(inventory.loaded.map((model) => [model.name, model]));
  const names = inventory.installed.map((model) => model.name);
  const modelDetails = inventory.installed.map((model) => {
    const loaded = loadedByName.get(model.name);
    const definition = rt.registry.getModel(model.name);
    // A resident model's weights are already out of the free-VRAM figure, so comparing them again would call it too big.
    let fits: boolean | null = null;
    let fitReason: string | undefined;
    if (loaded) {
      fits = true;
    } else if (definition) {
      const check = rt.capability.canRunModel(definition);
      fits = check.canRun;
      fitReason = check.reason;
    } else if (model.sizeBytes !== null && inventory.vramFreeBytes !== null) {
      fits = inventory.vramFreeBytes >= estimateRequirementBytes(model.sizeBytes);
    }
    return {
      name: model.name,
      sizeBytes: model.sizeBytes,
      parameterSize: model.parameterSize,
      quantization: model.quantization,
      family: model.family,
      loaded: loaded !== undefined,
      sizeVramBytes: loaded?.sizeVramBytes ?? null,
      fits,
      ...(fitReason ? { fitReason } : {}),
    };
  });

  ctx.json(200, {
    models: names,
    modelDetails,
    loaded: inventory.loaded.map((model) => model.name),
    active: ctx.defaultModel,
    activeInstalled: names.includes(ctx.defaultModel),
    vramFreeBytes: inventory.vramFreeBytes,
    status: inventory.status,
    // The list is the last good one when Ollama stopped answering since.
    stale: !inventory.reachable,
    ...(inventory.reachable ? {} : { error: inventory.error }),
  });
}

async function handleLedger(ctx: RouteContext): Promise<void> {
  const { ledger } = ctx.rt;
  const [summary, byModel, recent] = await Promise.all([
    ledger.getSummary(),
    ledger.getSummaryByModel(),
    ledger.listRecent(parseLimit(ctx.query.get('limit'), 25)),
  ]);
  ctx.json(200, { summary, byModel, recent });
}

function handleTools(ctx: RouteContext): void {
  const { rt } = ctx;
  const status = rt.getStatus();
  ctx.json(200, {
    tools: rt.tools
      .getAllTools()
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        tier: tool.tier,
        source: tool.source ?? 'runtime',
        // MCP descriptions come from a third-party server; clients must show them as text.
        untrusted: (tool.source ?? 'runtime') === 'mcp',
        parameters: tool.parameters,
        timeoutMs: tool.timeoutMs ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    mcp: status.mcp,
  });
}

function handleMcp(ctx: RouteContext): void {
  const { rt } = ctx;
  const status = rt.getStatus();
  ctx.json(200, {
    ...status.mcp,
    tools: rt.tools
      .getAllTools()
      .filter((tool) => tool.source === 'mcp')
      .map((tool) => ({ name: tool.name, tier: tool.tier })),
  });
}

async function handlePhone(ctx: RouteContext): Promise<void> {
  const { mobile } = ctx.rt;
  const problems: string[] = [];
  try {
    await mobile.refreshDevices();
  } catch (err: unknown) {
    problems.push(`Devices could not be read: ${errorMessage(err)}`);
  }
  try {
    await mobile.pullNotifications();
  } catch (err: unknown) {
    problems.push(`Notifications could not be read: ${errorMessage(err)}`);
  }
  ctx.json(200, {
    devices: mobile.listDevices(),
    // Notification text comes from other apps and is untrusted; clients show it as plain text.
    notifications: mobile.listNotifications(MAX_NOTIFICATIONS).reverse(),
    ...(problems.length > 0 ? { problems } : {}),
  });
}

/** Recorded as the actor so the audit log says the decision came over the web UI, not from a stronger channel. */
const WEB_UI_ACTOR = 'web-ui';

async function handleApprovalDecision(ctx: RouteContext): Promise<void> {
  if (refuseUnlessSameOriginBrowser(ctx)) return;
  const body = ApprovalDecisionSchema.safeParse(await ctx.readBody());
  if (!body.success) {
    ctx.json(400, { error: 'Send {"approved": true|false}.' });
    return;
  }
  const id = ctx.params[0] ?? '';
  // The one place `resolve` is called for the web. It is guarded by the same-origin check and `X-Jarvis-Client`
  // only, which keeps out cross-site pages but not a local process that forges both headers; see `refuseUnlessSameOriginBrowser`.
  const found = ctx.rt.approvals.resolve(id, body.data.approved, WEB_UI_ACTOR);
  if (!found) {
    ctx.json(404, { error: 'That approval request is unknown, expired or already decided.' });
    return;
  }
  ctx.json(200, { id, approved: body.data.approved, decidedBy: WEB_UI_ACTOR });
}

async function handleKill(ctx: RouteContext): Promise<void> {
  if (refuseUnlessSameOriginBrowser(ctx)) return;
  const body = KillRequestSchema.safeParse(await ctx.readBody());
  const reason = ((body.success ? body.data.reason?.trim() : '') ?? '').slice(0, MAX_KILL_REASON_CHARS) || 'Emergency stop from the web UI';
  const { tasksAborted } = await ctx.rt.killSwitch.trigger(WEB_UI_ACTOR, reason);
  ctx.json(200, { engaged: true, reason, tasksAborted });
}

async function handleKillReset(ctx: RouteContext): Promise<void> {
  if (refuseUnlessSameOriginBrowser(ctx)) return;
  await ctx.rt.killSwitch.reset(WEB_UI_ACTOR);
  ctx.json(200, { engaged: false, reason: '' });
}

async function handleMediaDescribe(ctx: RouteContext): Promise<void> {
  if (refuseIfKilled(ctx)) return;
  const body = MediaDescribeSchema.safeParse(await ctx.readBody(MEDIA_BODY_LIMIT_BYTES));
  if (!body.success || (body.data.prompt?.length ?? 0) > MAX_PROMPT_CHARS) {
    ctx.json(400, { error: 'Send {"imageBase64": "...", "prompt": "..."} (prompt up to 2000 characters).' });
    return;
  }
  const encoded = body.data.imageBase64.replace(/^data:[^;,]*;base64,/i, '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    ctx.json(400, { error: 'imageBase64 is not valid base64.' });
    return;
  }
  // Checked on the encoded length first, so an oversized upload is refused before it is decoded.
  if (Math.floor((encoded.length * 3) / 4) > MAX_IMAGE_BYTES) {
    ctx.json(413, { error: `The image is over the ${MAX_IMAGE_BYTES}-byte limit.`, maxBytes: MAX_IMAGE_BYTES });
    return;
  }
  const image = Buffer.from(encoded, 'base64');
  // Tied to the runtime (kill switch) and to the HTTP connection, so neither leaves a vision request running.
  const { signal: clientGone, dispose } = ctx.disconnectSignal();
  const stop = new AbortController();
  ctx.rt.registerAbort(stop);
  const onClientAbort = (): void => stop.abort('Client disconnected');
  clientGone.addEventListener('abort', onClientAbort, { once: true });
  let description: Awaited<ReturnType<typeof ctx.rt.media.describeImage>>;
  try {
    description = await ctx.rt.media.describeImage(image, body.data.prompt, { signal: stop.signal });
  } finally {
    clientGone.removeEventListener('abort', onClientAbort);
    dispose();
    ctx.rt.unregisterAbort(stop);
  }
  if (!description.available) {
    ctx.json(200, { available: false, reason: description.reason });
    return;
  }
  // The text is untrusted vision-model output: the client shows it as text and the chat pipeline fences it.
  ctx.json(200, { available: true, text: description.text, model: description.model, untrusted: true });
}

export function createSystemRoutes(): Route[] {
  return [
    { method: 'GET', pattern: /^\/api\/status$/, handler: async (ctx) => ctx.json(200, { ...ctx.rt.getStatus(), defaultModel: ctx.defaultModel }) },
    { method: 'GET', pattern: /^\/api\/models$/, handler: handleModels },
    { method: 'GET', pattern: /^\/api\/ledger$/, handler: handleLedger },
    { method: 'GET', pattern: /^\/api\/tools$/, handler: async (ctx) => handleTools(ctx) },
    { method: 'GET', pattern: /^\/api\/mcp$/, handler: async (ctx) => handleMcp(ctx) },
    { method: 'GET', pattern: /^\/api\/phone$/, handler: handlePhone },
    {
      method: 'GET',
      pattern: /^\/api\/approvals$/,
      handler: async (ctx) => ctx.json(200, { pending: ctx.rt.approvals.pending(), hasNotifier: ctx.rt.approvals.hasNotifier() }),
    },
    { method: 'POST', pattern: /^\/api\/approvals\/([^/]+)$/, handler: handleApprovalDecision },
    { method: 'POST', pattern: /^\/api\/kill$/, handler: handleKill },
    { method: 'POST', pattern: /^\/api\/kill\/reset$/, handler: handleKillReset },
    { method: 'POST', pattern: /^\/api\/media\/describe$/, handler: handleMediaDescribe },
  ];
}
