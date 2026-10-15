/**
 * Jarvis Local AI Agent: Decode-speed probe route
 *
 * `POST /api/probe/speed` runs one fixed prompt against an installed model a few times and reports Ollama's own
 * timing counters as tokens per second. Nothing is estimated: a counter Ollama did not send comes back as null.
 */

import type { ResidentModelInfo, SpeedProbeCounters } from '../../services/provider.js';
import { HttpError, errorMessage, refuseIfKilled, refuseUnlessSameOriginBrowser, type Route, type RouteContext } from './types.js';
import { withInstalledModel } from './llm.js';

const MODEL_NAME_PATTERN = /^[\w.:/@+-]{1,200}$/;
/** Fixed so results compare across models, contexts and days. */
export const SPEED_PROBE_PROMPT = 'Count from 1 to 200 separated by commas.';
export const MIN_NUM_CTX = 512;
export const MAX_NUM_CTX = 131_072;
export const DEFAULT_NUM_PREDICT = 128;
export const MAX_NUM_PREDICT = 512;
export const DEFAULT_REPEAT = 3;
export const MAX_REPEAT = 5;
/** Each run may include loading the model from disk, which takes over a minute for a large one. */
const RUN_TIMEOUT_MS = 5 * 60 * 1000;

export interface SpeedRequest {
  model: string;
  numCtx: number;
  numPredict: number;
  repeat: number;
  think: boolean;
}

export interface SpeedRun {
  run: number;
  loadMs: number | null;
  promptEvalTokens: number | null;
  promptEvalTokensPerSec: number | null;
  decodeTokens: number | null;
  decodeTokensPerSec: number | null;
  /** Ollama's `done_reason` (`length` when the run hit `numPredict`, `stop` when the model finished first). */
  doneReason: string | null;
}

export interface SpeedSummary {
  /** `warm runs`: every run after the first (the first may include model load). `only run`: repeat was 1. */
  basedOn: 'warm runs' | 'only run';
  runsCounted: number;
  medianDecodeTokensPerSec: number | null;
  bestDecodeTokensPerSec: number | null;
}

const round1 = (value: number): number => Math.round(value * 10) / 10;

function perSecond(count: number | undefined, durationNs: number | undefined): number | null {
  if (count === undefined || durationNs === undefined || durationNs <= 0) return null;
  return round1(count / (durationNs / 1e9));
}

/** Ollama's counters (nanoseconds) as the figures the owner reads. A missing counter is null, never zero. */
export function convertSpeedRun(run: number, counters: SpeedProbeCounters): SpeedRun {
  return {
    run,
    loadMs: counters.loadDurationNs === undefined ? null : round1(counters.loadDurationNs / 1e6),
    promptEvalTokens: counters.promptEvalCount ?? null,
    promptEvalTokensPerSec: perSecond(counters.promptEvalCount, counters.promptEvalDurationNs),
    decodeTokens: counters.evalCount ?? null,
    decodeTokensPerSec: perSecond(counters.evalCount, counters.evalDurationNs),
    doneReason: counters.doneReason ?? null,
  };
}

export function summarizeSpeed(runs: SpeedRun[]): SpeedSummary {
  const counted = runs.length > 1 ? runs.slice(1) : runs;
  const rates = counted.map((r) => r.decodeTokensPerSec).filter((rate): rate is number => rate !== null).sort((a, b) => a - b);
  const middle = Math.floor(rates.length / 2);
  const median = rates.length === 0 ? null : rates.length % 2 === 1 ? rates[middle] : round1((rates[middle - 1] + rates[middle]) / 2);
  return {
    basedOn: runs.length > 1 ? 'warm runs' : 'only run',
    runsCounted: rates.length,
    medianDecodeTokensPerSec: median,
    bestDecodeTokensPerSec: rates.length === 0 ? null : rates[rates.length - 1],
  };
}

function boundedInteger(value: unknown, name: string, min: number, max: number, fallback: number): number | string {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) return `${name} must be a whole number from ${min} to ${max}.`;
  return value;
}

/** The validated request, or the 400 message for the first problem. */
export function parseSpeedRequest(body: unknown, defaults: { model: string; numCtx: number }): SpeedRequest | string {
  const input = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  let model = defaults.model;
  if (input.model !== undefined && input.model !== null && input.model !== '') {
    if (typeof input.model !== 'string' || !MODEL_NAME_PATTERN.test(input.model.trim())) return 'Invalid model name';
    model = input.model.trim();
  }
  const numCtx = boundedInteger(input.numCtx, 'numCtx', MIN_NUM_CTX, MAX_NUM_CTX, Math.min(MAX_NUM_CTX, Math.max(MIN_NUM_CTX, defaults.numCtx)));
  if (typeof numCtx === 'string') return numCtx;
  const numPredict = boundedInteger(input.numPredict, 'numPredict', 1, MAX_NUM_PREDICT, DEFAULT_NUM_PREDICT);
  if (typeof numPredict === 'string') return numPredict;
  const repeat = boundedInteger(input.repeat, 'repeat', 1, MAX_REPEAT, DEFAULT_REPEAT);
  if (typeof repeat === 'string') return repeat;
  if (input.think !== undefined && typeof input.think !== 'boolean') return 'think must be true or false.';
  return { model, numCtx, numPredict, repeat, think: input.think === true };
}

export interface SpeedResponse extends SpeedRequest {
  prompt: string;
  /** The first run, reported on its own: it may include loading the model from disk. */
  firstRun: SpeedRun;
  runs: SpeedRun[];
  summary: SpeedSummary;
  /** What Ollama reports for the model after the runs, or null when it did not list it. */
  resident: (ResidentModelInfo & { vramShare: number | null }) | null;
  residentError?: string;
}

export function createSpeedRoutes(): Route[] {
  const runProbe = async (ctx: RouteContext): Promise<void> => {
    if (refuseIfKilled(ctx)) return;
    if (refuseUnlessSameOriginBrowser(ctx)) return;
    const { rt } = ctx;
    const parsed = parseSpeedRequest(await ctx.readBody(), { model: ctx.defaultModel, numCtx: rt.config.contextTokens });
    if (typeof parsed === 'string') {
      ctx.json(400, { error: parsed });
      return;
    }
    const release = rt.benchmark.guard.tryAcquire(`speed probe: ${parsed.model}`);
    if (!release) {
      ctx.json(409, { error: `A benchmark is already running (${rt.benchmark.guard.current()?.label ?? 'unknown'}). Only one runs at a time.` });
      return;
    }

    const { signal, dispose } = ctx.disconnectSignal();
    const stop = new AbortController();
    rt.registerAbort(stop);
    const onClientAbort = (): void => stop.abort('Client disconnected');
    signal.addEventListener('abort', onClientAbort, { once: true });
    try {
      const response = await withInstalledModel(ctx, parsed.model, async (): Promise<SpeedResponse> => {
        const client = rt.speedProbeFor(parsed.model);
        const runs: SpeedRun[] = [];
        for (let index = 1; index <= parsed.repeat; index++) {
          try {
            const counters = await client.generateOnce({
              prompt: SPEED_PROBE_PROMPT,
              numCtx: parsed.numCtx,
              numPredict: parsed.numPredict,
              think: parsed.think,
              signal: stop.signal,
              timeoutMs: RUN_TIMEOUT_MS,
            });
            runs.push(convertSpeedRun(index, counters));
          } catch (err: unknown) {
            if (stop.signal.aborted) throw err;
            throw new HttpError(502, `Speed probe run ${index} of ${parsed.repeat} failed: ${errorMessage(err)}`);
          }
        }
        let resident: SpeedResponse['resident'] = null;
        let residentError: string | undefined;
        try {
          const info = await client.residentModel({ signal: stop.signal });
          if (info) resident = { ...info, vramShare: info.sizeBytes > 0 ? Math.round((info.sizeVramBytes / info.sizeBytes) * 1000) / 1000 : null };
        } catch (err: unknown) {
          if (stop.signal.aborted) throw err;
          residentError = errorMessage(err);
        }
        return { ...parsed, prompt: SPEED_PROBE_PROMPT, firstRun: runs[0], runs, summary: summarizeSpeed(runs), resident, ...(residentError ? { residentError } : {}) };
      });
      if (ctx.res.destroyed || ctx.res.writableEnded) return;
      ctx.json(200, response);
    } catch (err: unknown) {
      if (stop.signal.aborted && !(err instanceof HttpError)) {
        if (!ctx.res.destroyed && !ctx.res.writableEnded) ctx.json(503, { error: `The speed probe was stopped${rt.killSwitch.isKilled() ? ' by the kill switch' : ''}.` });
        return;
      }
      throw err;
    } finally {
      signal.removeEventListener('abort', onClientAbort);
      rt.unregisterAbort(stop);
      dispose();
      release();
    }
  };

  return [{ method: 'POST', pattern: /^\/api\/probe\/speed$/, handler: runProbe }];
}
