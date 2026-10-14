/**
 * Jarvis Local AI Agent: Web routes for generated skills
 * Authority: Section 6.2, CODING_RULES.md section 5
 *
 * A skill is model-written code. It is generated as a draft, tested in the sandbox (`SkillGenerator.testInSandbox`),
 * and becomes usable only after the owner's explicit `POST /api/skills/:id/promote`.
 */

import { z } from 'zod';
import type { SkillManifest } from '../../skills/types.js';
import { HttpError, refuseIfKilled, type Route, type RouteContext } from './types.js';
import { cleanModelText, withInstalledModel } from './llm.js';
import type { ApprovalFlow } from './approval-flow.js';
import { approvalArgsMetadata, formatApprovalAction } from '../../security/approval-text.js';

const MODEL_NAME_PATTERN = /^[\w.:/@+-]{1,200}$/;
const MAX_CODE_CHARS = 20_000;

const GenerateSkillSchema = z.object({
  description: z.string(),
  name: z.string().optional(),
  model: z.string().optional(),
});
const MIN_DESCRIPTION_CHARS = 5;
const MAX_DESCRIPTION_CHARS = 2000;
const MAX_NAME_CHARS = 60;
const TestSkillSchema = z.object({ sampleInput: z.unknown().optional() });

function skillPrompt(description: string): string {
  return [
    'You write small JavaScript skills that run in a locked sandbox. Reply in exactly this format and nothing else:',
    'NAME: <short-kebab-case-name>',
    'SAMPLE_INPUT: <one line of JSON that the function can be called with>',
    '```js',
    'function run(input) {',
    '  // return a JSON-serialisable value',
    '}',
    '```',
    'Rules: one synchronous function named run(input); pure and deterministic; no require, import, fetch, network, timers, process, global objects, eval or file access.',
    `Skill the owner wants: ${description}`,
  ].join('\n');
}

export interface ParsedSkill {
  name: string | null;
  code: string;
  sampleInput: unknown;
  hasSampleInput: boolean;
}

/** Reads the model's reply; returns null when it contains no code block. */
export function parseSkillReply(raw: string): ParsedSkill | null {
  const text = cleanModelText(raw);
  const fence = text.match(/```(?:js|javascript|ts|typescript)?[^\n]*\n([\s\S]*?)```/i);
  const code = fence?.[1]?.trim();
  if (!code) return null;
  const name = text.match(/^NAME:\s*(.+)$/im)?.[1]?.trim() ?? null;
  const sampleLine = text.match(/^SAMPLE_INPUT:\s*(.+)$/im)?.[1]?.trim();
  let sampleInput: unknown;
  let hasSampleInput = false;
  if (sampleLine) {
    try {
      sampleInput = JSON.parse(sampleLine);
      hasSampleInput = true;
    } catch {
      // A sample the model wrote badly is dropped; the sandbox then only compiles and loads the code.
    }
  }
  return { name, code: code.slice(0, MAX_CODE_CHARS), sampleInput, hasSampleInput };
}

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug.length >= 3 ? slug : 'skill';
}

function skillView(skill: SkillManifest): Record<string, unknown> {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    version: skill.version,
    requiredTier: skill.requiredTier,
    author: skill.author,
    status: skill.status,
    successCount: skill.successCount,
    failureCount: skill.failureCount,
    createdAt: skill.createdAt,
    entryPoint: skill.entryPoint ?? null,
    lastSandboxAt: skill.lastSandboxAt ?? null,
    executableCode: (skill.executableCode ?? '').slice(0, MAX_CODE_CHARS),
  };
}

export function createSkillRoutes(flow: ApprovalFlow): Route[] {
  const listSkills = async (ctx: RouteContext): Promise<void> => {
    const skills = await ctx.rt.skills.listSkills();
    skills.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    ctx.json(200, { skills: skills.map(skillView), approvals: flow.list('skill_promote') });
  };

  const generateSkill = async (ctx: RouteContext): Promise<void> => {
    if (refuseIfKilled(ctx)) return;
    const parsed = GenerateSkillSchema.safeParse(await ctx.readBody());
    const description = parsed.success ? parsed.data.description.trim() : '';
    if (description.length < MIN_DESCRIPTION_CHARS || description.length > MAX_DESCRIPTION_CHARS) {
      ctx.json(400, { error: 'Send {"description": "what the skill should do"} (5 to 2000 characters).' });
      return;
    }
    const model = (parsed.success ? parsed.data.model?.trim() : undefined) || ctx.defaultModel;
    const requestedName = parsed.success ? parsed.data.name?.trim().slice(0, MAX_NAME_CHARS) : undefined;
    if (!MODEL_NAME_PATTERN.test(model)) {
      ctx.json(400, { error: 'Invalid model name' });
      return;
    }
    const { rt } = ctx;
    const { signal, dispose } = ctx.disconnectSignal();
    const stop = new AbortController();
    rt.registerAbort(stop);
    const onClientAbort = (): void => stop.abort('Client disconnected');
    signal.addEventListener('abort', onClientAbort, { once: true });
    try {
      const startedAt = Date.now();
      const rawReply = await withInstalledModel(ctx, model, () =>
        rt.providerFor(model).generate(skillPrompt(description), {
          temperature: 0.2,
          maxTokens: 1500,
          signal: stop.signal,
          onUsage: (usage) => {
            void rt.ledger
              .recordUsage({ model: usage.model || model, lane: 'skills', promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, latencyMs: usage.totalDurationMs ?? Date.now() - startedAt })
              .catch(() => undefined);
          },
        })
      );
      const reply = parseSkillReply(rawReply);
      if (!reply) {
        ctx.json(502, { error: `Model ${model} did not return a code block, so no skill was created.` });
        return;
      }
      const name = slugify(requestedName || reply.name || description);
      // The tier is never taken from the model: a generated skill starts at Tier 1 and the sandbox forbids anything riskier.
      const skill = await rt.skills.generateSkill({ name, description, executableCode: reply.code, requiredTier: 1 });
      const sandbox = await rt.skills.testInSandbox(skill.id, { sampleInputs: reply.hasSampleInput ? [reply.sampleInput] : [] });
      const stored = (await rt.skills.getSkill(skill.id)) ?? skill;
      ctx.json(201, { skill: skillView(stored), sandbox, model, sampleInputUsed: reply.hasSampleInput });
    } finally {
      signal.removeEventListener('abort', onClientAbort);
      rt.unregisterAbort(stop);
      dispose();
    }
  };

  const testSkill = async (ctx: RouteContext): Promise<void> => {
    if (refuseIfKilled(ctx)) return;
    const id = ctx.params[0] ?? '';
    const body = TestSkillSchema.safeParse(await ctx.readBody());
    if (!body.success) {
      ctx.json(400, { error: 'Invalid request' });
      return;
    }
    if (!(await ctx.rt.skills.getSkill(id))) {
      ctx.json(404, { error: `Skill ${id} not found.` });
      return;
    }
    const sandbox = await ctx.rt.skills.testInSandbox(id, { sampleInputs: body.data.sampleInput === undefined ? [] : [body.data.sampleInput] });
    const stored = await ctx.rt.skills.getSkill(id);
    ctx.json(200, { skill: stored ? skillView(stored) : null, sandbox });
  };

  const promoteSkill = async (ctx: RouteContext): Promise<void> => {
    if (refuseIfKilled(ctx)) return;
    const { rt } = ctx;
    const id = ctx.params[0] ?? '';
    const skill = await rt.skills.getSkill(id);
    if (!skill) {
      ctx.json(404, { error: `Skill ${id} not found.` });
      return;
    }
    if (skill.requiredTier === 2) {
      // A Tier 2 skill needs the owner's approval on top of this explicit click.
      const action = formatApprovalAction('skill_promote', { skillId: id, skillName: skill.name, description: skill.description }, ['skillId', 'skillName', 'description']);
      if (action.unshowable) {
        ctx.json(400, { error: `Refused before asking: ${action.unshowable}.` });
        return;
      }
      const requestId = flow.start(rt, {
        kind: 'skill_promote',
        description: action.text,
        metadata: { skillId: id, args: approvalArgsMetadata(action) },
        run: async () => {
          await rt.skills.promoteSkill(id, true);
          return `Skill ${skill.name} is active.`;
        },
      });
      ctx.json(202, { requestId, status: 'pending_approval' });
      return;
    }
    try {
      const promoted = await rt.skills.promoteSkill(id);
      ctx.json(200, { skill: skillView(promoted) });
    } catch (err: unknown) {
      throw new HttpError(409, err instanceof Error ? err.message : String(err));
    }
  };

  return [
    { method: 'GET', pattern: /^\/api\/skills$/, handler: listSkills },
    { method: 'POST', pattern: /^\/api\/skills$/, handler: generateSkill },
    { method: 'POST', pattern: /^\/api\/skills\/([\w-]+)\/test$/, handler: testSkill },
    { method: 'POST', pattern: /^\/api\/skills\/([\w-]+)\/promote$/, handler: promoteSkill },
  ];
}
