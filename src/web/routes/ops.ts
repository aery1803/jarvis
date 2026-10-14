/**
 * Jarvis Local AI Agent: Web routes for benchmarks, evaluation and multi-agent research
 * Authority: FEAT-004, Section 16 (90% evaluation target)
 */

import { z } from 'zod';
import { BenchmarkBusyError, type ModelBenchmarkScorecard } from '../../eval/benchmark.js';
import type { EvalReport } from '../../eval/harness.js';
import { HttpError, errorMessage, refuseIfKilled, type Route, type RouteContext } from './types.js';
import { withInstalledModel } from './llm.js';

const MODEL_NAME_PATTERN = /^[\w.:/@+-]{1,200}$/;
const EVAL_TARGET_ACCURACY = 0.9;

const BenchmarkRequestSchema = z.object({ model: z.string().optional() });
const ResearchRequestSchema = z.object({ goal: z.string() });
const MIN_GOAL_CHARS = 3;
const MAX_GOAL_CHARS = 1000;

interface BenchmarkProgress {
  model: string;
  completed: number;
  total: number;
  startedAt: string;
}

interface EvalSnapshot {
  report: EvalReport;
  model: string;
  startedAt: string;
  finishedAt: string;
}

export function createOpsRoutes(): Route[] {
  let progress: BenchmarkProgress | null = null;
  let lastBenchmarkError: { model: string; error: string; at: string } | null = null;
  let evalRunning: { model: string; startedAt: string } | null = null;
  let lastEval: EvalSnapshot | null = null;

  const benchmarkStatus = (ctx: RouteContext): void => {
    const running = ctx.rt.benchmark.guard.current();
    ctx.json(200, {
      running: running ? { model: running.label, startedAt: new Date(running.startedAt).toISOString() } : null,
      progress,
      cards: ctx.rt.benchmark.cache.list(),
      lastError: lastBenchmarkError,
    });
  };

  const runBenchmark = async (ctx: RouteContext): Promise<void> => {
    if (refuseIfKilled(ctx)) return;
    const body = BenchmarkRequestSchema.safeParse(await ctx.readBody());
    const requested = body.success ? body.data.model?.trim() : undefined;
    if (!body.success || (requested !== undefined && requested !== '' && !MODEL_NAME_PATTERN.test(requested))) {
      ctx.json(400, { error: 'Invalid model name' });
      return;
    }
    const model = requested || ctx.defaultModel;
    const { rt } = ctx;
    const busy = rt.benchmark.guard.current();
    if (busy) {
      ctx.json(409, { error: `A benchmark is already running (${busy.label}). Only one runs at a time.` });
      return;
    }

    const { signal, dispose } = ctx.disconnectSignal();
    // The kill switch aborts everything registered with the runtime; the benchmark loop checks this signal between cases.
    const stopOnKill = new AbortController();
    rt.registerAbort(stopOnKill);
    const onClientAbort = (): void => stopOnKill.abort('Client disconnected');
    signal.addEventListener('abort', onClientAbort, { once: true });
    try {
      const card: ModelBenchmarkScorecard = await withInstalledModel(ctx, model, () => {
        progress = { model, completed: 0, total: 0, startedAt: new Date().toISOString() };
        return rt.benchmark.suite.runExclusive(
          rt.providerFor(model),
          {
            signal: stopOnKill.signal,
            onProgress: (completed, total) => {
              progress = { model, completed, total, startedAt: progress?.startedAt ?? new Date().toISOString() };
            },
          },
          rt.benchmark.guard
        );
      });
      if (ctx.res.destroyed || ctx.res.writableEnded) return;
      if (card.status === 'error') {
        const error = `Model ${card.modelName} could not be benchmarked: ${card.error ?? 'every case failed'}`;
        lastBenchmarkError = { model, error, at: new Date().toISOString() };
        ctx.json(502, { error, card });
        return;
      }
      if (card.status === 'aborted') {
        ctx.json(503, { error: `The benchmark was stopped${rt.killSwitch.isKilled() ? ' by the kill switch' : ''}.`, card });
        return;
      }
      lastBenchmarkError = null;
      ctx.json(200, card);
    } catch (err: unknown) {
      if (err instanceof BenchmarkBusyError) {
        ctx.json(409, { error: err.message });
        return;
      }
      if (!(err instanceof HttpError)) lastBenchmarkError = { model, error: errorMessage(err), at: new Date().toISOString() };
      throw err;
    } finally {
      signal.removeEventListener('abort', onClientAbort);
      rt.unregisterAbort(stopOnKill);
      dispose();
      progress = null;
    }
  };

  const evalStatus = (ctx: RouteContext): void => {
    ctx.json(200, {
      running: evalRunning,
      targetAccuracy: EVAL_TARGET_ACCURACY,
      model: ctx.rt.config.defaultModel,
      last: lastEval,
    });
  };

  const runEval = async (ctx: RouteContext): Promise<void> => {
    if (refuseIfKilled(ctx)) return;
    if (evalRunning) {
      ctx.json(409, { error: `An evaluation is already running (started ${evalRunning.startedAt}).` });
      return;
    }
    const { rt } = ctx;
    // The harness is bound to the runtime's default model.
    const model = rt.config.defaultModel;
    const startedAt = new Date().toISOString();
    const { signal, dispose } = ctx.disconnectSignal();
    const stop = new AbortController();
    rt.registerAbort(stop);
    const onClientAbort = (): void => stop.abort('Client disconnected');
    signal.addEventListener('abort', onClientAbort, { once: true });
    evalRunning = { model, startedAt };
    try {
      const report = await withInstalledModel(ctx, model, () => rt.evalHarness.runAll({ signal: stop.signal }));
      if (ctx.res.destroyed || ctx.res.writableEnded) return;
      lastEval = { report, model, startedAt, finishedAt: new Date().toISOString() };
      if (report.totalTests > 0 && report.erroredTests === report.totalTests) {
        ctx.json(502, { error: `Model ${model} could not answer any evaluation case: ${report.results[0]?.notes ?? 'unknown error'}`, ...lastEval, targetAccuracy: EVAL_TARGET_ACCURACY });
        return;
      }
      ctx.json(200, { ...lastEval, targetAccuracy: EVAL_TARGET_ACCURACY });
    } finally {
      signal.removeEventListener('abort', onClientAbort);
      rt.unregisterAbort(stop);
      dispose();
      evalRunning = null;
    }
  };

  const runResearch = async (ctx: RouteContext): Promise<void> => {
    if (refuseIfKilled(ctx)) return;
    const parsed = ResearchRequestSchema.safeParse(await ctx.readBody());
    const goal = parsed.success ? parsed.data.goal.trim() : '';
    if (goal.length < MIN_GOAL_CHARS || goal.length > MAX_GOAL_CHARS) {
      ctx.json(400, { error: 'Send {"goal": "what to research"} (3 to 1000 characters).' });
      return;
    }
    const { rt } = ctx;
    const { signal, dispose } = ctx.disconnectSignal();
    const stop = new AbortController();
    rt.registerAbort(stop);
    const onClientAbort = (): void => stop.abort('Client disconnected');
    signal.addEventListener('abort', onClientAbort, { once: true });
    try {
      const result = await withInstalledModel(ctx, rt.config.defaultModel, () => rt.orchestrator.runCoordinatedPipeline(goal, { signal: stop.signal }));
      if (ctx.res.destroyed || ctx.res.writableEnded) return;
      ctx.json(200, {
        goal,
        status: result.status,
        finalAnswer: result.finalAnswer,
        // Findings came from the web, so the report is tainted data whatever the synthesis says.
        isTainted: result.isTainted,
        totalTokens: result.totalTokens,
        agentsInvolved: result.agentsInvolved,
        sources: result.sources,
        consensus: result.consensus ?? null,
        degraded: result.degraded ?? null,
        steps: result.steps.map((step) => ({
          role: step.agentRole,
          status: step.status,
          tokens: step.tokensConsumed,
          durationMs: step.durationMs,
          isTainted: step.isTainted,
          ...(step.error ? { error: step.error } : {}),
          ...(step.degraded ? { degraded: step.degraded } : {}),
        })),
      });
    } finally {
      signal.removeEventListener('abort', onClientAbort);
      rt.unregisterAbort(stop);
      dispose();
    }
  };

  return [
    { method: 'GET', pattern: /^\/api\/benchmark$/, handler: async (ctx) => benchmarkStatus(ctx) },
    { method: 'POST', pattern: /^\/api\/benchmark$/, handler: runBenchmark },
    { method: 'GET', pattern: /^\/api\/eval$/, handler: async (ctx) => evalStatus(ctx) },
    { method: 'POST', pattern: /^\/api\/eval$/, handler: runEval },
    { method: 'POST', pattern: /^\/api\/agents\/research$/, handler: runResearch },
  ];
}
