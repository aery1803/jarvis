/**
 * Jarvis Local AI Agent: Eval Answer Checks
 *
 * Shared by `EvaluationHarness` and `ModelBenchmarkSuite` so a case cannot pass on the prompt's own words, on a
 * refusal, or on reasoning that was never an answer.
 */

/** Removes `<think>...</think>` reasoning; an unterminated block means the model never reached an answer. */
export function stripThinking(output: string): string {
  const withoutClosed = output.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const open = withoutClosed.search(/<think>/i);
  return (open === -1 ? withoutClosed : withoutClosed.slice(0, open)).trim();
}

const REFUSAL = /^[\s"'*_>-]*(?:i['’]?m\s+(?:sorry|unable|not able)|i\s+am\s+(?:sorry|unable|not able)|sorry\b|i\s+(?:can(?:'|’)?t|cannot|can\s+not|do\s+not\s+know|don['’]?t\s+know)|as\s+an\s+ai\b|unfortunately,?\s+i)/i;

/** True when the output opens by declining or by saying it does not know. */
export function isRefusal(output: string): boolean {
  return REFUSAL.test(output);
}

function shingles(text: string, size = 3): string[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’.:-]*/gu) ?? [];
  const out: string[] = [];
  for (let i = 0; i + size <= words.length; i++) out.push(words.slice(i, i + size).join(' '));
  return out;
}

/**
 * True when (nearly) every three-word run of the output already occurs in the prompt: the model repeated the
 * question instead of answering it. A short answer has no three-word runs and is never an echo.
 */
export function isPromptEcho(output: string, prompt: string, threshold = 0.85): boolean {
  const mine = shingles(output);
  if (mine.length < 3) return false;
  const theirs = new Set(shingles(prompt));
  return mine.filter((run) => theirs.has(run)).length / mine.length >= threshold;
}

/** Every top-level `{...}` object in the text that parses as JSON, in order. */
export function parseJsonObjects(text: string): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"' && depth > 0) inString = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          const parsed: unknown = JSON.parse(text.slice(start, i + 1));
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) found.push(parsed as Record<string, unknown>);
        } catch {
          // Half-written or invalid JSON is not a tool call.
        }
        start = -1;
      }
    }
  }
  return found;
}

/** The emitted tool call named `tool` whose `parameters` (or `args`) is an object, or null. */
export function findToolCall(output: string, tool: string): { parameters: Record<string, unknown> } | null {
  for (const object of parseJsonObjects(output)) {
    if (object.tool !== tool && object.name !== tool) continue;
    const parameters = object.parameters ?? object.args ?? object.arguments ?? {};
    if (typeof parameters === 'object' && parameters !== null && !Array.isArray(parameters)) return { parameters: parameters as Record<string, unknown> };
  }
  return null;
}
