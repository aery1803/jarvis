export type ModelLane = 'resident' | 'fast' | 'balanced' | 'deep' | 'vision' | 'code' | 'embedding';

export const GIB = 1024 * 1024 * 1024;

/** Ollama's `/api/tags` entry, or the `OllamaModelInfo` that `src/web/diagnostics.ts` derives from it. */
export interface InstalledModelInfo {
  name: string;
  size?: number | null;
  sizeBytes?: number | null;
  details?: {
    family?: string | null;
    parameter_size?: string | null;
    quantization_level?: string | null;
  } | null;
  family?: string | null;
  parameterSize?: string | null;
  quantization?: string | null;
}

/**
 * Canonical comparison key for an Ollama tag: Ollama treats `name` and `name:latest` as the same model and
 * accepts `hf.co/` / registry prefixes, so none of those may make two spellings of one model look different.
 */
export function normalizeTag(tag: string): string {
  let t = tag.trim().toLowerCase();
  t = t.replace(/^(?:https?:\/\/)?(?:registry\.ollama\.ai\/library\/|hf\.co\/|huggingface\.co\/)/, '');
  if (t.endsWith(':latest')) t = t.slice(0, -':latest'.length);
  return t;
}

/** The fleet downloader installs the Kimi model from a bartowski HF repo, so its tag never equals the registry id. */
export const KIMI_REGISTRY_ID = 'kimi-linear-48b-a3b:instruct';

const TAG_ALIASES: Array<{ pattern: RegExp; canonical: string }> = [
  { pattern: /kimi[-_ ]?linear/, canonical: KIMI_REGISTRY_ID },
];

/** Maps an installed tag onto the registry id it stands for; unaliased tags come back normalized. */
export function canonicalizeTag(tag: string): string {
  const normalized = normalizeTag(tag);
  for (const alias of TAG_ALIASES) {
    if (alias.pattern.test(normalized)) return alias.canonical;
  }
  return normalized;
}

/** Parses '8B', '48B (3B Active)', '137M' and tag fragments like 'qwen3:14b' into a billions-of-parameters figure. */
export function parseParameterBillions(text: string): number | null {
  const match = /(?<![a-z0-9.])(\d+(?:\.\d+)?)\s?([bm])(?![a-z0-9])/i.exec(text);
  if (!match) return null;
  const value = Number.parseFloat(match[1]);
  return match[2].toLowerCase() === 'm' ? value / 1000 : value;
}

export function inferFamily(name: string, reported?: string | null): string {
  if (reported) return reported.toLowerCase();
  const n = normalizeTag(name);
  const known = ['qwen', 'llama', 'deepseek', 'nemotron', 'kimi', 'mistral', 'gemma', 'phi', 'llava', 'nomic'];
  return known.find((k) => n.includes(k)) ?? (n.split(/[/:]/)[0] ?? 'unknown');
}

/** Heuristic lane for an installed model the registry did not know: name first, then on-disk size. */
export function inferLane(name: string, sizeBytes: number | null): ModelLane {
  const n = normalizeTag(name);
  if (/embed|nomic|bge-|minilm|mxbai|e5-|gte-/.test(n)) return 'embedding';
  if (/llava|vision|(?:^|[-_:/])vl(?:[-_:]|$)|minicpm-v|moondream|bakllava/.test(n)) return 'vision';
  if (/coder|codellama|starcoder|codestral|codegemma/.test(n)) return 'code';
  if (sizeBytes === null) {
    const billions = parseParameterBillions(n);
    if (billions === null) return 'balanced';
    return billions <= 9 ? 'fast' : billions <= 16 ? 'balanced' : 'deep';
  }
  if (sizeBytes <= 6 * GIB) return 'fast';
  if (sizeBytes <= 12 * GIB) return 'balanced';
  return 'deep';
}

/** Whole-word keyword test; plain `includes` matched 'ocr' inside 'microcrack' and 'test' inside 'latest'. */
export function matchesWord(text: string, words: readonly string[]): boolean {
  const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`\\b(?:${escaped.join('|')})\\b`, 'i').test(text);
}
