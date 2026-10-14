/**
 * Jarvis Local AI Agent: Model access for web routes
 * Authority: CODING_RULES.md section 5, jarvis-master-context.md Section 7.4 (memory governor)
 *
 * Every route that runs a model outside the chat pipeline (skill generation, email summaries, evaluation,
 * benchmarks, multi-agent research) goes through `withInstalledModel`: the model must really be installed, and the
 * run holds the governor lease, so it serializes with chat turns on heavy models and is refused when it cannot fit.
 */

import { LeaseDeniedError, LeaseTimeoutError } from '../../orchestration/governor.js';
import { HttpError, errorMessage, type RouteContext } from './types.js';

export async function withInstalledModel<T>(ctx: RouteContext, model: string, work: () => Promise<T>): Promise<T> {
  const { rt } = ctx;
  const inventory = await rt.refreshInventory();
  if (inventory.lastGoodAt === null) {
    throw new HttpError(503, `Ollama is unreachable, so ${model} cannot run (${inventory.error ?? inventory.status}).`);
  }
  if (!inventory.installed.some((installed) => installed.name === model)) {
    throw new HttpError(404, `Model ${model} is not installed in Ollama.`);
  }
  const definition = rt.registry.getModel(model);
  if (!definition) throw new HttpError(409, `Model ${model} is installed but unknown to the model registry.`);
  try {
    return await rt.governor.withLease(definition, work);
  } catch (err: unknown) {
    if (err instanceof LeaseDeniedError || err instanceof LeaseTimeoutError) throw new HttpError(409, err.message);
    throw err;
  }
}

/** Strips a model's `<think>` blocks and control characters from text that will be stored or shown. */
export function cleanModelText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
}

export function describeFailure(err: unknown): string {
  return errorMessage(err);
}
