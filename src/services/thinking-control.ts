/**
 * Decides whether a call sends Ollama's top-level `think` field.
 * `qwen3` emits a hidden reasoning block before every reply (about 120 tokens for the word "OK"), which costs
 * seconds and, under a tight `num_predict`, truncates the visible answer before it appears.
 */

export type ThinkingMode = 'off' | 'auto' | 'on';

export const THINKING_MODES: readonly ThinkingMode[] = ['off', 'auto', 'on'];

const QWEN3_FAMILY = /^(rnogy\/)?qwen3|^qwen3\./i;
const REASONING_MODELS = /deepseek-r1|nemotron/i;
const REASONING_CATEGORIES = new Set(['reasoning', 'precision']);

export function isQwen3Family(model: string): boolean {
  return QWEN3_FAMILY.test(model.trim());
}

export function parseThinkingMode(raw: string | undefined): ThinkingMode | undefined {
  const value = raw?.trim().toLowerCase();
  return value === 'off' || value === 'auto' || value === 'on' ? value : undefined;
}

/**
 * `on` always thinks and `auto` leaves the model's own default. `off` turns thinking off for the qwen3 family unless
 * the task is genuinely reasoning (category `reasoning` or `precision`) or the model is a reasoning lane
 * (`deepseek-r1`, Nemotron), where `undefined` keeps the model's default.
 */
export function resolveThink(mode: ThinkingMode, model: string, category?: string): boolean | undefined {
  if (mode === 'on') return true;
  if (mode === 'auto') return undefined;
  if (category !== undefined && REASONING_CATEGORIES.has(category)) return undefined;
  if (REASONING_MODELS.test(model)) return undefined;
  return isQwen3Family(model) ? false : undefined;
}
