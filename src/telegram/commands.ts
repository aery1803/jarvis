/**
 * Jarvis Local AI Agent: Telegram slash commands
 *
 * One table drives both dispatch and `/help`, so the help text lists exactly the commands that exist. Handlers
 * only read and write through the shared `JarvisRuntime` (the same instances the web UI uses); anything that
 * reaches a model goes through the runtime's provider factory, registry and governor.
 */

import { approvalArgsMetadata, formatApprovalAction } from '../security/approval-text.js';
import type { JarvisRuntime } from '../runtime/runtime.js';
import { BenchmarkBusyError, type ModelBenchmarkScorecard } from '../eval/benchmark.js';
import type { JarvisSession } from '../sessions/types.js';
import { redactSensitive } from '../memory/sensitive.js';
import { code, esc, formatAge, formatBytes, oneLine } from './format.js';

/** Per-owner settings kept by the bot and saved in the document store. */
export interface UserState {
  /** The model the owner chose with `/model`; every turn uses it until `/model auto`. */
  explicitModel?: string;
  ensemble: boolean;
}

/** Work the kill switch must be able to stop: `signal` aborts on `/kill`; call `done()` when finished. */
export interface WorkHandle {
  signal: AbortSignal;
  done(): void;
}

export interface CommandContext {
  rt: JarvisRuntime;
  chatId: number | string;
  /** The Telegram sender, as the key for per-user settings and audit actors. */
  senderId: string;
  /** The user all sessions and memory are stored under (shared with the web UI). */
  storeUserId: string;
  args: string[];
  rawArgs: string;
  state: UserState;
  updateState(patch: Partial<UserState>): Promise<void>;
  /** A bot-authored message; dynamic values must already be escaped with `esc` or `code`. */
  reply(markdown: string): Promise<void>;
  /** Plain text, for anything that came from a model, an email, a web page or the owner's own data. */
  replyPlain(text: string): Promise<void>;
  withTyping<T>(action: () => Promise<T>): Promise<T>;
  beginWork(): WorkHandle;
  runChatTurn(prompt: string, options?: { useResearch?: boolean }): Promise<void>;
  runEnsemble(query: string): Promise<void>;
  /** The session ids the last `/sessions` showed this chat, in display order; undefined when none was shown or it expired. */
  getShownSessionIds(): string[] | undefined;
  setShownSessionIds(ids: string[]): void;
}

export interface CommandSpec {
  name: string;
  aliases?: string[];
  usage: string;
  summary: string;
  /** Runs at once, outside the per-chat queue, so a slow turn cannot delay it. */
  immediate?: boolean;
  /** Still answered while the kill switch is engaged. */
  allowedWhenKilled?: boolean;
  run(ctx: CommandContext): Promise<void>;
}

const SESSION_LIST_LIMIT = 8;
const TASK_LIST_LIMIT = 10;
const EMAIL_LIST_LIMIT = 10;
const NOTIFICATION_LIST_LIMIT = 5;
const SKILL_CODE_PREVIEW_CHARS = 1_500;
const THINK_BLOCK = /<think>[\s\S]*?<\/think>/gi;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `/switch` and `/delete` accept either a full session id or the 1-based number shown by `/sessions`. */
async function resolveSession(ctx: CommandContext, token: string): Promise<{ session: JarvisSession | null; note?: string }> {
  const sessions = await ctx.rt.sessions.listSessions(ctx.storeUserId);
  if (/^\d{1,3}$/.test(token)) {
    // A number means the row the owner saw in `/sessions`; the live list reorders whenever any turn completes.
    const shown = ctx.getShownSessionIds();
    if (!shown) return { session: null, note: 'Send /sessions first: numbers refer to the list you last saw, and there is none (or it expired).' };
    const id = shown[Number.parseInt(token, 10) - 1];
    return { session: id === undefined ? null : (sessions.find((session) => session.id === id) ?? null) };
  }
  return { session: sessions.find((session) => session.id === token) ?? null };
}

/** Runs `fn` under the model's governor lease when the registry knows the model, so a big model does not load on top of another. */
async function withModelLease<T>(rt: JarvisRuntime, tag: string, fn: () => Promise<T>): Promise<T> {
  const definition = rt.registry.getModel(tag);
  return definition ? rt.governor.withLease(definition, fn, { timeoutMs: 60_000 }) : fn();
}

function chatModelOf(ctx: CommandContext): string {
  return ctx.state.explicitModel ?? ctx.rt.config.defaultModel;
}

// --- /status, /models, /model ---

async function runStatus(ctx: CommandContext): Promise<void> {
  const inventory = await ctx.rt.refreshInventory();
  const status = ctx.rt.getStatus();
  const lines: string[] = ['*Jarvis status*', ''];
  lines.push(`- Host RAM (not the model pool): ${esc(formatBytes(status.host.freeMemoryBytes))} free of ${esc(formatBytes(status.host.totalMemoryBytes))}`);
  lines.push(`- VRAM free: ${esc(formatBytes(status.vram.freeBytes))}${status.vram.freeBytes === null ? ' (not measurable right now)' : ''}`);
  lines.push(`- Ollama: ${esc(status.inventory.status)}`);
  lines.push(
    `- Model inventory: ${status.inventory.installed.length} installed, checked ${esc(formatAge(status.inventory.ageMs))}${
      inventory.reachable ? '' : ' (stale: showing the last good list)'
    }`
  );
  if (status.loadedModels.length === 0) {
    lines.push('- Loaded in memory: none');
  } else {
    lines.push(`- Loaded in memory: ${status.loadedModels.map((model) => `${code(model.name)} ${esc(formatBytes(model.sizeBytes))}`).join(', ')}`);
  }
  lines.push(`- Chat model: ${ctx.state.explicitModel ? `${code(ctx.state.explicitModel)} (your /model choice)` : `auto (default ${code(ctx.rt.config.defaultModel)})`}`);
  lines.push(`- Ensemble mode: ${ctx.state.ensemble ? 'on' : 'off'}`);
  lines.push(
    `- Kill switch: ${status.killSwitch.engaged ? `*ENGAGED* (${esc(status.killSwitch.reason || 'no reason recorded')}), send /resume to re-arm` : 'armed (normal operation)'}`
  );
  lines.push(`- Pending approvals: ${status.pendingApprovals.length}`);
  lines.push(`- Turns in flight: ${status.inFlight}, waiting for the model: ${status.queueLength}${status.activeHeavyModel ? `, heavy model: ${code(status.activeHeavyModel)}` : ''}`);
  lines.push(`- Tools: ${status.toolCount}, MCP servers: ${status.mcp.servers.length}${status.mcp.failures.length > 0 ? `, MCP failures: ${status.mcp.failures.length}` : ''}`);
  lines.push(`- Email transport: ${status.email.transportConfigured ? 'configured' : 'not configured'}`);
  if (status.issues.length > 0) {
    lines.push('', '*Issues*');
    for (const issue of status.issues.slice(0, 8)) lines.push(`- ${esc(oneLine(issue, 200))}`);
  }
  await ctx.reply(lines.join('\n'));
}

async function runModels(ctx: CommandContext): Promise<void> {
  const inventory = await ctx.rt.refreshInventory({ force: true });
  if (inventory.lastGoodAt === null) {
    await ctx.replyPlain(`Cannot list models: ${inventory.status}`);
    return;
  }
  const loaded = new Map(inventory.loaded.map((model) => [model.name, model]));
  const lines: string[] = ['*Installed models*', ''];
  if (!inventory.reachable) {
    lines.push(`Ollama is unreachable right now (${esc(oneLine(inventory.error ?? 'no response', 120))}); this is the last good list.`, '');
  }
  const installed = [...inventory.installed].sort((a, b) => a.name.localeCompare(b.name));
  if (installed.length === 0) lines.push('Ollama reports no installed models.');
  for (const model of installed) {
    const resident = loaded.get(model.name);
    const marks: string[] = [];
    if (resident) marks.push(resident.sizeVramBytes === 0 ? 'loaded, on CPU' : 'loaded');
    if (model.name === ctx.state.explicitModel) marks.push('your choice');
    if (!ctx.state.explicitModel && model.name === ctx.rt.config.defaultModel) marks.push('auto default');
    lines.push(`- ${code(model.name)} ${esc(formatBytes(model.sizeBytes))}${marks.length > 0 ? ` (${marks.join(', ')})` : ''}`);
  }
  lines.push('', 'Pick one with `/model <name>`, or `/model auto` for automatic routing.');
  await ctx.reply(lines.join('\n'));
}

async function runModel(ctx: CommandContext): Promise<void> {
  const requested = ctx.args[0]?.trim();
  if (!requested) {
    await ctx.reply(
      ctx.state.explicitModel
        ? `Chat model: ${code(ctx.state.explicitModel)} (your choice). Use \`/model auto\` to go back to automatic routing, or \`/models\` to see what is installed.`
        : `Chat model: automatic routing (default ${code(ctx.rt.config.defaultModel)}). Use \`/model <name>\` to pin one; \`/models\` lists what is installed.`
    );
    return;
  }
  if (requested.toLowerCase() === 'auto') {
    await ctx.updateState({ explicitModel: undefined });
    await ctx.reply('Model routing is automatic again.');
    return;
  }
  const inventory = await ctx.rt.refreshInventory({ force: true });
  if (inventory.lastGoodAt === null) {
    await ctx.replyPlain(`Cannot confirm that "${oneLine(requested, 80)}" is installed, so the model was not changed. ${inventory.status}`);
    return;
  }
  if (!inventory.installed.some((model) => model.name === requested)) {
    const names = inventory.installed.map((model) => model.name).join(', ') || 'none';
    await ctx.replyPlain(`"${oneLine(requested, 80)}" is not installed, so the model was not changed.\nInstalled: ${names}`);
    return;
  }
  await ctx.updateState({ explicitModel: requested });
  await ctx.reply(`Chat model pinned to ${code(requested)}. It is used for every message until \`/model auto\`.`);
}

async function runEnsembleCommand(ctx: CommandContext): Promise<void> {
  const sub = ctx.args[0]?.toLowerCase();
  if (sub === 'on') {
    await ctx.updateState({ ensemble: true });
    await ctx.reply('Ensemble mode is *on* for your messages. The models answer one after another, so replies are slow. `/ensemble off` turns it off.');
    return;
  }
  if (sub === 'off') {
    await ctx.updateState({ ensemble: false });
    await ctx.reply('Ensemble mode is *off*.');
    return;
  }
  if (!ctx.rawArgs) {
    await ctx.reply(
      `Ensemble mode: ${ctx.state.ensemble ? 'on' : 'off'}\n\n- \`/ensemble on\` or \`/ensemble off\`\n- \`/ensemble <question>\` asks several installed models once (sequentially, so it is slow)`
    );
    return;
  }
  await ctx.runEnsemble(ctx.rawArgs);
}

// --- /benchmark, /eval ---

function formatScorecard(card: ModelBenchmarkScorecard): string {
  if (card.status === 'error') {
    return `Benchmark of ${card.modelName}: ERROR. The model could not be benchmarked.\nReason: ${card.error ?? 'unknown'}`;
  }
  const speed = card.tokensPerSecSource === 'none' ? 'n/a' : `${card.estimatedTokensPerSec} tokens/s (${card.tokensPerSecSource})`;
  const categories = Object.values(card.categories).map((entry) =>
    entry.total === 0 ? `- ${entry.category}: no answers` : `- ${entry.category}: ${entry.percentage}% (${entry.passed}/${entry.total}), avg ${entry.avgLatencyMs} ms`
  );
  return [
    `Benchmark of ${card.modelName}`,
    `Score: ${card.overallScore}% (grade ${card.grade}), status ${card.status}`,
    ...(card.status !== 'complete' && card.error ? [`Note: ${card.error}`] : []),
    `Answered ${card.answeredCases} case(s), ${card.erroredCases} errored. Throughput ${speed}, average latency ${card.avgLatencyMs} ms.`,
    `Host RAM during the run: ${card.systemSpecs.freeMemoryGB} GB free of ${card.systemSpecs.totalMemoryGB} GB.`,
    '',
    ...categories,
    '',
    `Recommended lane: ${card.recommendedLanes.join(', ') || 'none'}`,
  ].join('\n');
}

async function runBenchmark(ctx: CommandContext): Promise<void> {
  const model = ctx.args[0]?.trim() || chatModelOf(ctx);
  const inventory = await ctx.rt.refreshInventory({ force: true });
  if (inventory.lastGoodAt === null) {
    await ctx.replyPlain(`Cannot benchmark: ${inventory.status}`);
    return;
  }
  if (!inventory.installed.some((entry) => entry.name === model)) {
    await ctx.replyPlain(`"${oneLine(model, 80)}" is not installed, so there is nothing to benchmark. Use /models to see what is.`);
    return;
  }
  if (ctx.rt.benchmark.guard.isBusy()) {
    await ctx.replyPlain(`A benchmark is already running (${ctx.rt.benchmark.guard.current()?.label ?? 'unknown'}). Only one runs at a time.`);
    return;
  }
  await ctx.reply(`Benchmarking ${code(model)} with the shared single-flight runner. Large models can take several minutes. Send /kill to stop it.`);
  const work = ctx.beginWork();
  try {
    const card = await ctx.withTyping(() =>
      withModelLease(ctx.rt, model, () =>
        ctx.rt.benchmark.suite.runExclusive(ctx.rt.providerFor(model), { signal: work.signal }, ctx.rt.benchmark.guard)
      )
    );
    await ctx.replyPlain(formatScorecard(card));
  } catch (err: unknown) {
    if (err instanceof BenchmarkBusyError) {
      await ctx.replyPlain(err.message);
    } else {
      await ctx.replyPlain(`Benchmark failed: ${errorMessage(err)}`);
    }
  } finally {
    work.done();
  }
}

let evalRunning = false;

async function runEval(ctx: CommandContext): Promise<void> {
  if (evalRunning) {
    await ctx.replyPlain('An evaluation is already running.');
    return;
  }
  evalRunning = true;
  await ctx.reply(`Running the evaluation suite against ${code(ctx.rt.config.defaultModel)}. Send /kill to stop it.`);
  const work = ctx.beginWork();
  try {
    const report = await ctx.withTyping(() => ctx.rt.evalHarness.runAll({ signal: work.signal }));
    const failed = report.results.filter((entry) => !entry.passed);
    const lines = [
      `Evaluation: ${report.passedTests}/${report.totalTests} passed (${Math.round(report.accuracyRate * 100)}%), ${report.meetsTarget ? 'meets' : 'below'} the 90% target.`,
      `Average latency ${Math.round(report.avgLatencyMs)} ms. ${report.erroredTests} case(s) could not be run at all.${report.aborted ? ' The run was aborted before every case ran.' : ''}`,
    ];
    for (const entry of failed.slice(0, 8)) {
      lines.push(`- failed ${entry.testId} (${entry.category})${entry.errored ? ': ' + oneLine(entry.notes ?? 'provider error', 100) : ''}`);
    }
    await ctx.replyPlain(lines.join('\n'));
  } catch (err: unknown) {
    await ctx.replyPlain(`Evaluation failed: ${errorMessage(err)}`);
  } finally {
    evalRunning = false;
    work.done();
  }
}

// --- /cost, /tools, /mcp, /skills, /skill, /agents ---

async function runCost(ctx: CommandContext): Promise<void> {
  const byModel = await ctx.rt.ledger.getSummaryByModel();
  const entries = Object.entries(byModel).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) {
    await ctx.replyPlain('No model usage has been recorded yet.');
    return;
  }
  const total = await ctx.rt.ledger.getSummary();
  const lines = ['Model usage (local tokens recorded in the ledger)', ''];
  for (const [model, summary] of entries) {
    lines.push(
      `- ${model}: ${summary.totalInvocations} call(s), ${summary.totalPromptTokens} prompt + ${summary.totalCompletionTokens} completion tokens, avg ${summary.avgTokensPerSec.toFixed(1)} tokens/s, avg ${Math.round(summary.avgLatencyMs)} ms`
    );
  }
  lines.push('', `Total: ${total.totalInvocations} call(s), ${total.totalTokens} tokens.`);
  await ctx.replyPlain(lines.join('\n'));
}

async function runTools(ctx: CommandContext): Promise<void> {
  const tools = [...ctx.rt.tools.getAllTools()].sort((a, b) => a.tier - b.tier || a.name.localeCompare(b.name));
  const status = ctx.rt.getStatus();
  const lines: string[] = [`Tools (${tools.length})`, ''];
  for (const tool of tools) lines.push(`- ${tool.name}: Tier ${tool.tier}${tool.tier >= 2 ? ' (needs your approval)' : ''} [${tool.source ?? 'runtime'}]`);
  if (status.mcp.failures.length > 0) {
    lines.push('', 'MCP servers that did not start:');
    for (const failure of status.mcp.failures) lines.push(`- ${failure.server}: ${oneLine(failure.error, 160)}`);
  }
  await ctx.replyPlain(lines.join('\n'));
}

async function runMcp(ctx: CommandContext): Promise<void> {
  const status = ctx.rt.getStatus();
  const mcpTools = ctx.rt.tools.getAllTools().filter((tool) => tool.source === 'mcp');
  const lines: string[] = [];
  lines.push(`MCP servers running: ${status.mcp.servers.length === 0 ? 'none' : status.mcp.servers.join(', ')}`);
  lines.push(`MCP tools registered: ${mcpTools.length}${mcpTools.length > 0 ? ` (${mcpTools.slice(0, 12).map((tool) => tool.name).join(', ')}${mcpTools.length > 12 ? ', ...' : ''})` : ''}`);
  if (status.mcp.failures.length > 0) {
    lines.push('', 'Failed to start:');
    for (const failure of status.mcp.failures) lines.push(`- ${failure.server}: ${oneLine(failure.error, 160)}`);
  }
  if (status.mcp.changed.length > 0) {
    lines.push('', 'Tool definitions that changed since you approved them (blocked until re-approved):');
    for (const change of status.mcp.changed) lines.push(`- ${change.server}/${change.name}`);
  }
  if (status.killSwitch.engaged && status.mcp.servers.length === 0) {
    lines.push('', 'The kill switch closes MCP servers; they stay closed until Jarvis is restarted.');
  }
  await ctx.replyPlain(lines.join('\n'));
}

async function runSkills(ctx: CommandContext): Promise<void> {
  const skills = await ctx.rt.skills.listSkills();
  if (skills.length === 0) {
    await ctx.replyPlain('No skills exist yet. Create one with /skill <description>.');
    return;
  }
  const lines = [`Skills (${skills.length})`, ''];
  for (const skill of skills.slice(0, 20)) {
    lines.push(`- ${skill.name} [${skill.status}] Tier ${skill.requiredTier}, ${skill.successCount} ok / ${skill.failureCount} failed\n  id: ${skill.id}`);
  }
  await ctx.replyPlain(lines.join('\n'));
}

interface GeneratedSkill {
  name: string;
  description: string;
  code: string;
  sampleInputs?: unknown[];
}

function skillPrompt(description: string): string {
  return [
    'You write small, self-contained JavaScript functions that run in a locked-down sandbox.',
    'Rules: no imports or require, no network, no file access, no timers, no eval, no process or global objects.',
    'It is a pure computation over one JSON input value. Define exactly one entry function named run(input) that returns a JSON-serialisable result.',
    `Task from the owner: ${description}`,
    'Reply with ONLY a JSON object, no commentary: {"name": "<short name>", "description": "<one sentence>", "code": "<the JavaScript source>", "sampleInputs": [<one to three JSON inputs that exercise run>]}',
  ].join('\n');
}

function parseGeneratedSkill(raw: string): GeneratedSkill | null {
  const text = raw.replace(THINK_BLOCK, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { name, description, code: source, sampleInputs } = parsed as Record<string, unknown>;
  if (typeof name !== 'string' || name.trim() === '' || name.length > 60) return null;
  if (typeof description !== 'string' || description.trim() === '' || description.length > 300) return null;
  if (typeof source !== 'string' || source.trim() === '' || source.length > 20_000) return null;
  return { name: name.trim(), description: description.trim(), code: source, sampleInputs: Array.isArray(sampleInputs) ? sampleInputs.slice(0, 3) : undefined };
}

async function promoteSkillCommand(ctx: CommandContext, skillId: string): Promise<void> {
  const skill = await ctx.rt.skills.getSkill(skillId);
  if (!skill) {
    await ctx.replyPlain(`No skill with id "${oneLine(skillId, 80)}". Use /skills to list them.`);
    return;
  }
  let ownerApproved = false;
  if (skill.requiredTier === 2) {
    // A Tier 2 skill needs a real approval from the broker (your tap on the buttons), not just this command.
    const action = formatApprovalAction('skill_promote', { skillId: skill.id, skillName: skill.name, description: skill.description }, ['skillId', 'skillName', 'description']);
    if (action.unshowable) {
      await ctx.replyPlain(`Skill "${oneLine(skill.name, 80)}" was not activated: ${action.unshowable}, so the approval prompt could not show the whole action.`);
      return;
    }
    const decision = await ctx.rt.approvals.request({
      actionType: 'SKILL_PROMOTE',
      description: action.text,
      tier: 2,
      requestedBy: `telegram:${ctx.senderId}`,
      metadata: { skillId: skill.id, args: approvalArgsMetadata(action) },
    });
    if (!decision.approved) {
      await ctx.replyPlain(`Skill "${skill.name}" was not activated: ${decision.reason ?? 'not approved'}`);
      return;
    }
    ownerApproved = true;
  }
  try {
    const promoted = await ctx.rt.skills.promoteSkill(skill.id, ownerApproved);
    await ctx.replyPlain(`Skill "${promoted.name}" is now ${promoted.status}.`);
  } catch (err: unknown) {
    await ctx.replyPlain(`Skill not activated: ${errorMessage(err)}`);
  }
}

async function runSkill(ctx: CommandContext): Promise<void> {
  if (!ctx.rawArgs) {
    await ctx.reply('Usage: `/skill <what the skill should do>` generates a skill and tests it in the sandbox.\n`/skill promote <id>` activates a skill that passed. `/skills` lists them.');
    return;
  }
  if (ctx.args[0]?.toLowerCase() === 'promote') {
    const skillId = ctx.args[1]?.trim();
    if (!skillId) {
      await ctx.reply('Usage: `/skill promote <id>`');
      return;
    }
    await promoteSkillCommand(ctx, skillId);
    return;
  }

  const model = chatModelOf(ctx);
  await ctx.reply(`Asking ${code(model)} to write the skill, then testing it in the sandbox. Nothing is activated automatically.`);
  const work = ctx.beginWork();
  try {
    const raw = await ctx.withTyping(() =>
      withModelLease(ctx.rt, model, () => ctx.rt.providerFor(model).generate(skillPrompt(ctx.rawArgs), { signal: work.signal, maxTokens: 2048 }))
    );
    const generated = parseGeneratedSkill(raw);
    if (!generated) {
      await ctx.replyPlain(`The model did not return a usable skill (expected a JSON object with name, description and code), so nothing was created.\nIt said: ${oneLine(raw.replace(THINK_BLOCK, ''), 200)}`);
      return;
    }
    const skill = await ctx.rt.skills.generateSkill({
      name: generated.name,
      description: generated.description,
      executableCode: generated.code,
      entryPoint: 'run',
    });
    const test = await ctx.rt.skills.testInSandbox(skill.id, { sampleInputs: generated.sampleInputs ?? [] });
    const lines = [
      `Skill "${skill.name}" generated: ${skill.description}`,
      `id: ${skill.id}`,
      `Sandbox: ${test.passed ? 'PASSED' : 'FAILED'} (${test.executionTimeMs} ms, ${test.samples.length} sample run(s)${test.forbiddenActionsDetected ? ', forbidden constructs found' : ''})`,
    ];
    for (const error of test.errors.slice(0, 5)) lines.push(`- error: ${oneLine(error, 200)}`);
    for (const sample of test.samples) {
      lines.push(`- sample ${oneLine(JSON.stringify(sample.input) ?? '', 60)} -> ${sample.ok ? oneLine(JSON.stringify(sample.output) ?? 'undefined', 100) : `failed: ${oneLine(sample.error ?? '', 100)}`}`);
    }
    lines.push('', 'Code (review it before activating):', generated.code.length > SKILL_CODE_PREVIEW_CHARS ? `${generated.code.slice(0, SKILL_CODE_PREVIEW_CHARS)}\n... (truncated)` : generated.code);
    lines.push('', test.passed ? `To activate it, send: /skill promote ${skill.id}` : 'It stays a draft and cannot be activated until it passes the sandbox.');
    await ctx.replyPlain(lines.join('\n'));
  } catch (err: unknown) {
    await ctx.replyPlain(`Skill generation failed: ${errorMessage(err)}`);
  } finally {
    work.done();
  }
}

async function runAgents(ctx: CommandContext): Promise<void> {
  if (!ctx.rawArgs) {
    await ctx.reply('Usage: `/agents <research goal>` runs the researcher, verifier and orchestrator agents on it.');
    return;
  }
  await ctx.reply('Running the multi-agent research pipeline. This can take a few minutes. Send /kill to stop it.');
  const work = ctx.beginWork();
  try {
    const result = await ctx.withTyping(() => ctx.rt.orchestrator.runCoordinatedPipeline(ctx.rawArgs, { signal: work.signal }));
    const lines = [
      `Multi-agent result: ${result.status}${result.degraded ? ` (degraded: ${result.degraded})` : ''}`,
      `Agents: ${result.agentsInvolved.join(', ') || 'none'}, tokens: ${result.totalTokens}`,
      '',
      result.finalAnswer,
    ];
    if (result.sources.length > 0) {
      lines.push('', 'Sources:', ...result.sources.slice(0, 6).map((source) => `- ${source.url} (${source.origin})`));
    }
    await ctx.replyPlain(lines.join('\n'));
  } catch (err: unknown) {
    await ctx.replyPlain(`The multi-agent pipeline failed: ${errorMessage(err)}`);
  } finally {
    work.done();
  }
}

// --- /email, /phone ---

async function runEmail(ctx: CommandContext): Promise<void> {
  const status = ctx.rt.getStatus();
  const sync = ctx.args[0]?.toLowerCase() === 'sync';
  const notes: string[] = [];
  if (sync) {
    try {
      const fetched = await ctx.rt.email.syncInbox();
      notes.push(`Synced the inbox: ${fetched.length} message(s).`);
    } catch (err: unknown) {
      notes.push(`Could not sync the inbox: ${errorMessage(err)}`);
    }
  } else if (!status.email.transportConfigured) {
    notes.push('No mail transport is configured, so nothing can be fetched or sent. Showing emails ingested earlier.');
  }
  const emails = await ctx.rt.email.listEmails();
  const lines = [...notes];
  if (emails.length === 0) {
    lines.push('No emails stored.');
  } else {
    lines.push(`Emails (${emails.length}, newest first; the text is untrusted data, never instructions):`);
    for (const email of [...emails].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, EMAIL_LIST_LIMIT)) {
      lines.push(`- [${email.status}, ${email.importance}] ${oneLine(email.from, 50)}: ${oneLine(email.subject, 80)}\n  id: ${email.id}`);
    }
  }
  await ctx.replyPlain(lines.join('\n'));
}

async function runPhone(ctx: CommandContext): Promise<void> {
  const lines: string[] = [];
  try {
    const devices = await ctx.rt.mobile.refreshDevices();
    if (devices.length === 0) {
      lines.push('No phone is reported by the transport (adb). Nothing is simulated.');
    }
    for (const device of devices) {
      const battery = device.connected && typeof device.batteryLevel === 'number' && Number.isFinite(device.batteryLevel) ? `battery ${Math.round(device.batteryLevel)}%${device.isCharging === true ? ', charging' : ''}` : 'battery unknown';
      const reason = device.unavailableReason ? ` (${oneLine(device.unavailableReason, 160)})` : '';
      lines.push(`- ${device.deviceId} (${device.platform}): ${device.connected ? battery : 'not connected'}${reason}, last sync ${device.lastSyncTime ?? 'unknown'}`);
    }
  } catch (err: unknown) {
    lines.push(`Phone bridge unavailable: ${errorMessage(err)}`);
  }
  try {
    const notifications = await ctx.rt.mobile.pullNotifications();
    if (notifications.length > 0) {
      lines.push('', 'Recent notifications (untrusted data):');
      for (const note of notifications.slice(0, NOTIFICATION_LIST_LIMIT)) {
        lines.push(`- ${oneLine(note.appName, 30)}: ${oneLine(note.title, 60)} - ${oneLine(note.text, 100)}`);
      }
    }
  } catch (err: unknown) {
    lines.push('', `Notifications unavailable: ${errorMessage(err)}`);
  }
  await ctx.replyPlain(lines.join('\n'));
}

// --- Memory ---

async function runMemory(ctx: CommandContext): Promise<void> {
  const facts = await ctx.rt.memory.getProfileFacts(ctx.storeUserId);
  const tags = await ctx.rt.memory.listSensitiveTags(ctx.storeUserId);
  if (facts.length === 0 && tags.length === 0) {
    await ctx.replyPlain('No profile facts saved yet. Say "remember that ..." to save one.');
    return;
  }
  const lines = ['Profile facts', ''];
  for (const fact of facts) lines.push(`- ${fact.key}: ${oneLine(redactSensitive(fact.value), 200)} (${fact.category})`);
  if (tags.length > 0) {
    lines.push('', 'Vault entries (encrypted; only the label is ever shown):');
    for (const tag of tags) lines.push(`- ${tag}`);
  }
  lines.push('', 'Remove one with /forget <key>.');
  await ctx.replyPlain(lines.join('\n'));
}

async function runForget(ctx: CommandContext): Promise<void> {
  const key = ctx.rawArgs;
  if (!key) {
    await ctx.reply('Usage: `/forget <key>`. `/memory` lists the keys.');
    return;
  }
  const hadVaultEntry = (await ctx.rt.memory.listSensitiveTags(ctx.storeUserId)).includes(key);
  const removed = await ctx.rt.memory.deleteProfileFact(ctx.storeUserId, key);
  if (!removed) {
    await ctx.replyPlain(`Nothing is stored under "${oneLine(key, 80)}".`);
    return;
  }
  await ctx.replyPlain(`Forgot "${oneLine(key, 80)}"${hadVaultEntry ? ' (including its encrypted vault entry)' : ''}.`);
}

// --- Sessions and tasks ---

async function runNew(ctx: CommandContext): Promise<void> {
  const title = ctx.rawArgs || 'New Workspace';
  const session = await ctx.rt.sessions.createSession(ctx.storeUserId, title);
  const pointed = await ctx.rt.sessions.setActiveSession(ctx.storeUserId, 'telegram', session.id);
  if (!pointed) {
    await ctx.replyPlain(`Created session "${session.title}" but could not make it active (it was removed again). Try /new once more.`);
    return;
  }
  await ctx.reply(`Created and switched to session *${esc(session.title)}* (${code(session.id)}).`);
}

async function runSessions(ctx: CommandContext): Promise<void> {
  const sessions = await ctx.rt.sessions.listSessions(ctx.storeUserId);
  if (sessions.length === 0) {
    await ctx.reply('No sessions yet. Send a message, or create one with `/new <name>`.');
    return;
  }
  const activeId = (await ctx.rt.sessions.getActiveSession(ctx.storeUserId, 'telegram'))?.id;
  const lines = ['*Recent sessions*', ''];
  ctx.setShownSessionIds(sessions.slice(0, SESSION_LIST_LIMIT).map((session) => session.id));
  sessions.slice(0, SESSION_LIST_LIMIT).forEach((session, index) => {
    lines.push(`${index + 1}. *${esc(oneLine(session.title, 60))}*${session.id === activeId ? ' (active)' : ''}\n   ${code(session.id)}`);
  });
  lines.push('', 'Use `/switch <number or id>` or `/delete <number or id>`.');
  await ctx.reply(lines.join('\n'));
}

async function runSwitch(ctx: CommandContext): Promise<void> {
  const token = ctx.args[0]?.trim();
  if (!token) {
    await ctx.reply('Usage: `/switch <number or id>` (numbers come from `/sessions`).');
    return;
  }
  const { session, note } = await resolveSession(ctx, token);
  if (!session) {
    await ctx.replyPlain(note ?? `Session not found: ${oneLine(token, 80)}`);
    return;
  }
  const pointed = await ctx.rt.sessions.setActiveSession(ctx.storeUserId, 'telegram', session.id);
  await (pointed
    ? ctx.reply(`Switched to session *${esc(oneLine(session.title, 60))}*.`)
    : ctx.replyPlain(`Could not switch to "${oneLine(session.title, 60)}": it no longer exists.`));
}

async function runDelete(ctx: CommandContext): Promise<void> {
  const token = ctx.args[0]?.trim();
  if (!token) {
    await ctx.reply('Usage: `/delete <number or id>` (numbers come from `/sessions`).');
    return;
  }
  const { session, note } = await resolveSession(ctx, token);
  if (!session) {
    await ctx.replyPlain(note ?? `Session not found: ${oneLine(token, 80)}`);
    return;
  }
  const wasActive = (await ctx.rt.sessions.getActiveSession(ctx.storeUserId, 'telegram'))?.id === session.id;
  const deleted = await ctx.rt.sessions.deleteSession(ctx.storeUserId, session.id);
  if (!deleted) {
    await ctx.replyPlain(`Session "${oneLine(session.title, 60)}" was already gone.`);
    return;
  }
  await ctx.replyPlain(`Deleted session "${oneLine(session.title, 60)}" with its messages and tasks.${wasActive ? ' Your next message starts a new session.' : ''}`);
}

async function runTasks(ctx: CommandContext): Promise<void> {
  const tasks = (await ctx.rt.sessions.listTasks({ userId: ctx.storeUserId })).sort((a, b) => b.taskNumber - a.taskNumber);
  if (tasks.length === 0) {
    await ctx.replyPlain('No tasks yet.');
    return;
  }
  const active = tasks.filter((task) => task.status === 'queued' || task.status === 'running' || task.status === 'waiting_approval').length;
  const lines = [`Tasks: ${active} active, ${tasks.length} total (newest first)`, ''];
  for (const task of tasks.slice(0, TASK_LIST_LIMIT)) {
    const detail = task.status === 'failed' || task.status === 'cancelled' ? ` - ${oneLine(task.error ?? '', 80)}` : '';
    lines.push(`- ${ctx.rt.sessions.formatTaskTag(task)} ${task.status.toUpperCase()}${detail}`);
  }
  await ctx.replyPlain(lines.join('\n'));
}

// --- /id, /kill, /resume, /research, /help ---

async function runId(ctx: CommandContext): Promise<void> {
  // Plain text: `code()` drops backslashes, which would turn the Windows path into one that does not exist.
  await ctx.replyPlain(
    `Your Telegram user ID: ${ctx.senderId}\n\nTo lock Jarvis to your account, add this line to %USERPROFILE%\\.jarvis\\settings.env:\nTELEGRAM_OWNER_ID=${ctx.senderId}\nthen restart Jarvis.`
  );
}

async function runKill(ctx: CommandContext): Promise<void> {
  const before = ctx.rt.getStatus();
  const result = await ctx.rt.killSwitch.trigger(`telegram:${ctx.senderId}`, 'Emergency stop command (/kill)');
  const lines = [
    '*Kill switch ENGAGED* (saved, so it survives a restart).',
    '',
    'Stopped just now:',
    `- ${result.tasksAborted} active task(s) cancelled`,
    `- ${before.inFlight} in-flight turn(s) aborted`,
    `- ${before.pendingApprovals.length} pending approval(s) denied`,
    `- ${before.mcp.servers.length} MCP server(s) closed`,
    '',
    'Until `/resume`, Jarvis refuses new messages and commands here, and tools and approvals refuse to run. This does not stop other programs on the machine.',
  ];
  await ctx.reply(lines.join('\n'));
}

async function runResume(ctx: CommandContext): Promise<void> {
  if (!ctx.rt.killSwitch.isKilled()) {
    await ctx.reply('The kill switch is not engaged.');
    return;
  }
  const mcpWasRunning = ctx.rt.getStatus().mcp.servers.length;
  await ctx.rt.killSwitch.reset(`telegram:${ctx.senderId}`);
  await ctx.reply(
    `Kill switch reset. Jarvis accepts work again.${mcpWasRunning > 0 ? ' MCP servers the kill switch closed stay closed until Jarvis is restarted.' : ''}`
  );
}

async function runResearch(ctx: CommandContext): Promise<void> {
  if (!ctx.rawArgs) {
    await ctx.reply('Usage: `/research <topic>`');
    return;
  }
  await ctx.runChatTurn(ctx.rawArgs, { useResearch: true });
}

async function runHelp(ctx: CommandContext): Promise<void> {
  const lines = ['*Jarvis commands*', ''];
  for (const spec of COMMANDS) lines.push(`${code(spec.usage)} - ${esc(spec.summary)}`);
  lines.push('', 'Send any other message to chat. Ensemble mode applies to plain chat only: /research always runs real web research. Send a photo to have it described by an installed vision model.');
  await ctx.reply(lines.join('\n'));
}

export const COMMANDS: CommandSpec[] = [
  { name: 'help', immediate: true, aliases: ['start'], usage: '/help', summary: 'this list', run: runHelp },
  { name: 'id', aliases: ['myid'], usage: '/id', summary: 'show your Telegram user ID (works for anyone)', immediate: true, allowedWhenKilled: true, run: runId },
  { name: 'status', usage: '/status', summary: 'RAM, VRAM, Ollama, loaded models, kill switch, approvals', immediate: true, allowedWhenKilled: true, run: runStatus },
  { name: 'kill', usage: '/kill', summary: 'emergency stop: abort turns, deny approvals, block new work', immediate: true, allowedWhenKilled: true, run: runKill },
  { name: 'resume', usage: '/resume', summary: 'reset the kill switch (owner only)', immediate: true, allowedWhenKilled: true, run: runResume },
  { name: 'models', immediate: true, usage: '/models', summary: 'installed models with sizes and which are loaded', run: runModels },
  { name: 'model', immediate: true, usage: '/model <name|auto>', summary: 'pin the chat model, or go back to auto routing', run: runModel },
  { name: 'ensemble', usage: '/ensemble [on|off|<question>]', summary: 'ask several installed models one after another (plain chat only; /research is never ensembled)', run: runEnsembleCommand },
  { name: 'research', usage: '/research <topic>', summary: 'web research answered with sources', run: runResearch },
  { name: 'agents', usage: '/agents <goal>', summary: 'multi-agent research pipeline', run: runAgents },
  { name: 'benchmark', usage: '/benchmark [model]', summary: 'benchmark the active or a named model', run: runBenchmark },
  { name: 'eval', usage: '/eval', summary: 'run the evaluation suite', run: runEval },
  { name: 'cost', immediate: true, usage: '/cost', summary: 'token usage and speed per model', run: runCost },
  { name: 'tools', immediate: true, usage: '/tools', summary: 'tools with their tiers', run: runTools },
  { name: 'mcp', immediate: true, usage: '/mcp', summary: 'MCP servers, tools and failures', run: runMcp },
  { name: 'skills', immediate: true, usage: '/skills', summary: 'list skills', run: runSkills },
  { name: 'skill', usage: '/skill <description> | /skill promote <id>', summary: 'generate and sandbox-test a skill, then activate it', run: runSkill },
  { name: 'email', immediate: true, usage: '/email [sync]', summary: 'list stored emails (untrusted text)', run: runEmail },
  { name: 'phone', immediate: true, usage: '/phone', summary: 'phone status and notifications via adb', run: runPhone },
  { name: 'memory', immediate: true, usage: '/memory', summary: 'profile facts and vault labels', run: runMemory },
  { name: 'forget', usage: '/forget <key>', summary: 'delete a profile fact or vault entry', run: runForget },
  { name: 'new', usage: '/new [name]', summary: 'start a new session', run: runNew },
  { name: 'sessions', immediate: true, usage: '/sessions', summary: 'list recent sessions', run: runSessions },
  { name: 'switch', usage: '/switch <number|id>', summary: 'switch session', run: runSwitch },
  { name: 'delete', usage: '/delete <number|id>', summary: 'delete a session', run: runDelete },
  { name: 'tasks', immediate: true, usage: '/tasks', summary: 'task list with real statuses', run: runTasks },
];

const COMMAND_INDEX = new Map<string, CommandSpec>();
for (const spec of COMMANDS) {
  COMMAND_INDEX.set(spec.name, spec);
  for (const alias of spec.aliases ?? []) COMMAND_INDEX.set(alias, spec);
}

export function findCommand(name: string): CommandSpec | undefined {
  return COMMAND_INDEX.get(name);
}

export interface ParsedCommand {
  name: string;
  args: string[];
  rawArgs: string;
  /** The `@botname` suffix, without the `@`; undefined when the command was not addressed to a specific bot. */
  target?: string;
}

/** `/status@my_bot args` -> `{ name: 'status', args, target: 'my_bot' }`; null for text that is not a command. */
export function parseCommand(text: string): ParsedCommand | null {
  const match = /^\/([A-Za-z_]+)(?:@(\w+))?(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  const rawArgs = (match[3] ?? '').trim();
  return { name: match[1].toLowerCase(), args: rawArgs ? rawArgs.split(/\s+/) : [], rawArgs, ...(match[2] ? { target: match[2] } : {}) };
}
