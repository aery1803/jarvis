/**
 * Jarvis Local AI Agent: Eval Case Runner
 *
 * Runs one case the way the chat pipeline would ask it: the same prompt scaffold, the same tool schemas the
 * selector offers, reference facts as fenced untrusted data. Latency and speed are measured and returned, but
 * only `grade` decides whether the case passed.
 */

import type { GenerationUsage, LLMProvider } from '../services/provider.js';
import { CognitionEngine, type ToolSchemaSummary } from '../agents/cognition.js';
import { stripThinking } from './answer-check.js';
import type { EvalToolbox, Grader, Judgement } from './graders.js';

/** Same cap the chat pipeline uses for the number of tools shown to a model. */
export const MAX_TOOLS_OFFERED = 10;
/** No case is run with less room than this: a verbose correct answer must not be cut off before its final line. */
export const MIN_COMPLETION_TOKENS = 768;

export interface EvalCaseSpec {
  id: string;
  category: string;
  /** What the user asks. The final-answer instruction is part of it. */
  prompt: string;
  /** Reference facts, handed over as fenced untrusted research data exactly as a chat turn's research is. */
  facts?: string;
  /** Offer the tool schemas the selector picks for `prompt`, as the pipeline does. */
  offerTools?: boolean;
  /** A tool the selector must offer for this prompt; when it does not, the case is a setup error, not a wrong answer. */
  expectsOffered?: string;
  taskType?: 'chat' | 'code';
  grade: Grader;
}

export interface CaseEnvironment {
  provider: LLMProvider;
  think: boolean | undefined;
  maxTokens: number;
  contextTokens: number;
  timeoutMs: number;
  temperature?: number;
  signal?: AbortSignal;
  toolbox?: EvalToolbox;
}

export interface CaseExecution {
  passed: boolean;
  /** The model could not be queried (HTTP failure, timeout) or the case could not be set up: not a wrong answer. */
  errored: boolean;
  /** The caller aborted while the case was running. */
  aborted: boolean;
  reason: string;
  /** The reply with any `<think>` block removed. */
  output: string;
  latencyMs: number;
  usage?: GenerationUsage;
  /** completion tokens / the backend's `eval_duration`; undefined when the backend reported no decode time. */
  decodeTokensPerSec?: number;
}

export function coerceOutput(response: unknown): string {
  if (typeof response === 'string') return response;
  if (typeof response === 'object' && response !== null && typeof (response as { text?: unknown }).text === 'string') {
    return (response as { text: string }).text;
  }
  return String(response);
}

export function decodeRate(usage: GenerationUsage | undefined): number | undefined {
  if (!usage || usage.evalDurationMs === undefined || usage.evalDurationMs <= 0) return undefined;
  return Math.round((usage.completionTokens / (usage.evalDurationMs / 1000)) * 10) / 10;
}

export async function executeCase(spec: EvalCaseSpec, env: CaseEnvironment): Promise<CaseExecution> {
  const started = Date.now();
  const failed = (reason: string, extra: Partial<CaseExecution> = {}): CaseExecution => ({
    passed: false,
    errored: true,
    aborted: false,
    reason,
    output: '',
    latencyMs: Date.now() - started,
    ...extra,
  });

  let toolSchemas: ToolSchemaSummary[] | undefined;
  if (spec.offerTools) {
    if (!env.toolbox) return failed('Not run: no tool registry was supplied, so there are no real tool schemas to offer.');
    const offered = env.toolbox.registry.selectToolsForPrompt(spec.prompt, MAX_TOOLS_OFFERED);
    if (spec.expectsOffered && !offered.some((tool) => tool.name === spec.expectsOffered)) {
      return failed(`Not run: the tool selector does not offer ${spec.expectsOffered} for this prompt, so the model could not be fairly asked to use it.`);
    }
    toolSchemas = offered.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      tier: tool.tier,
      isUntrusted: tool.source === 'mcp',
    }));
  }

  const reported: GenerationUsage[] = [];
  let raw: string;
  try {
    const prompt = CognitionEngine.formatPrompt(spec.prompt, {
      taskType: spec.taskType ?? 'chat',
      activeModel: env.provider.getModel(),
      ...(toolSchemas ? { toolSchemas } : {}),
      ...(spec.facts ? { researchFacts: spec.facts } : {}),
    });
    raw = coerceOutput(
      await env.provider.generate(prompt, {
        temperature: env.temperature ?? 0.2,
        maxTokens: Math.max(MIN_COMPLETION_TOKENS, env.maxTokens),
        think: env.think,
        contextTokens: env.contextTokens,
        signal: env.signal,
        timeoutMs: env.timeoutMs,
        onUsage: (usage) => {
          reported.push(usage);
        },
      })
    );
  } catch (err: unknown) {
    const aborted = env.signal?.aborted === true;
    return failed(`Failed: ${err instanceof Error ? err.message : String(err)}`, { aborted });
  }

  const latencyMs = Date.now() - started;
  const usage: GenerationUsage | undefined = reported[reported.length - 1];
  const output = stripThinking(raw);
  const base = { errored: false, aborted: false, output, latencyMs, usage, decodeTokensPerSec: decodeRate(usage) };

  if (output === '') {
    return { ...base, passed: false, reason: raw.trim() === '' ? 'empty answer' : 'no answer after the reasoning block (the reply was cut off while thinking)' };
  }
  let judged: Judgement;
  try {
    judged = await spec.grade(output, { prompt: spec.prompt, toolbox: env.toolbox });
  } catch (err: unknown) {
    return { ...base, passed: false, reason: `grader error: ${err instanceof Error ? err.message : String(err)}` };
  }
  const cutOff = !judged.passed && usage?.truncated === true ? ' (the reply was cut off at the completion cap)' : '';
  return { ...base, passed: judged.passed, reason: `${judged.reason}${cutOff}` };
}
