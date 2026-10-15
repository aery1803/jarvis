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

/**
 * The value on the last `ANSWER: <value>` line, with markdown emphasis removed, or null when the output has none.
 * Formatting is forgiven (`**ANSWER:** 12:00 PM`, lower case, a bullet); the line has to start with the label.
 */
export function extractFinalAnswer(output: string): string | null {
  const lines = output.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = /^[\s>*_#`-]*answer[\s*_`]*[:：][\s*_`]*(.*)$/i.exec(lines[i]);
    if (!match) continue;
    const value = match[1].replace(/[*_`]+/g, '').trim();
    if (value !== '') return value;
  }
  return null;
}

/** Minutes after midnight for an answer that is exactly one clock time; null when it is anything else or ambiguous. */
export function parseClockTime(answer: string): number | null {
  const cleaned = answer
    .toLowerCase()
    .replace(/[*_`]/g, '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim()
    .replace(/[.!]+$/, '')
    .replace(/^(?:at|about|around|approximately)\s+/, '')
    .trim();
  if (cleaned === 'noon' || cleaned === 'midday') return 12 * 60;
  if (cleaned === 'midnight') return 0;
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(?:(a|p)\.?\s?m\.?)?$/.exec(cleaned);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = match[2] === undefined ? 0 : Number(match[2]);
  if (minute > 59) return null;
  const meridiem = match[3];
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    return ((hour % 12) + (meridiem === 'p' ? 12 : 0)) * 60 + minute;
  }
  // Without am/pm only a 24-hour time is unambiguous: "12:00" or "1:30" could be either half of the day.
  return match[2] !== undefined && hour >= 13 && hour <= 23 ? hour * 60 + minute : null;
}

const UNIT_ALIASES: Record<string, string> = {
  gigabytes: 'gb', gigabyte: 'gb', gb: 'gb',
  megabytes: 'mb', megabyte: 'mb', mb: 'mb',
  hours: 'hour', hour: 'hour', hrs: 'hour', hr: 'hour', h: 'hour',
  minutes: 'minute', minute: 'minute', mins: 'minute', min: 'minute',
  miles: 'mile', mile: 'mile', mi: 'mile',
  mph: 'mph', tokens: 'token', token: 'token',
};

/** A number with an optional unit (`31.65 GB`, `1,200`, `3 hours`); null when the answer is anything more than that. */
export function parseQuantity(answer: string): { value: number; unit: string | null } | null {
  const cleaned = answer.replace(/[*_`]/g, '').trim().replace(/[.!]+$/, '');
  const match = /^(-?\d[\d,]*(?:\.\d+)?)\s*([a-z]+)?$/i.exec(cleaned);
  if (!match) return null;
  const value = Number(match[1].replace(/,/g, ''));
  if (!Number.isFinite(value)) return null;
  const unit = match[2] === undefined ? null : (UNIT_ALIASES[match[2].toLowerCase()] ?? match[2].toLowerCase());
  return { value, unit };
}

/** True when the answer says it cannot be found in the context, without hedging into an invented value. */
export function isHonestUnknown(answer: string): boolean {
  if (/\d/.test(answer)) return false;
  return [
    /\bnot\s+(?:\w+\s+){0,3}(?:in|provided|mentioned|stated|given|specified|included|present|found|contained|covered|available|listed)\b/i,
    /\b(?:do\s*n['’]?t|do\s+not|does\s*n['’]?t|does\s+not|did\s+not)\s+know\b/i,
    /\b(?:does|do|did)\s+not\s+(?:say|state|specify|mention|provide|contain|include|give|list)\b/i,
    /\bunknown\b/i,
    /\bno\s+(?:information|data|mention|details)\b/i,
    /\b(?:cannot|can['’]?t|can\s+not)\s+(?:be\s+)?(?:determined|answered|found|told)\b/i,
    /\bunable\s+to\s+(?:determine|find)\b/i,
    /\binsufficient\s+(?:information|context)\b/i,
  ].some((pattern) => pattern.test(answer));
}

/** The content of every complete fenced code block, in order. An unterminated fence (a cut-off reply) is not a block. */
export function extractCodeBlocks(output: string): string[] {
  return Array.from(output.matchAll(/```[\w+#.-]*[ \t]*\r?\n([\s\S]*?)```/g), (match) => match[1]);
}

/**
 * The output with every run of `minWords` or more consecutive words that also appears in the prompt removed, so a
 * requirement copied out of the prompt does not count as the model's own words.
 */
export function stripPromptCopies(output: string, prompt: string, minWords = 5): string {
  const wordPattern = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;
  const words = Array.from(output.matchAll(wordPattern), (match) => match[0].toLowerCase());
  const promptWords = Array.from(prompt.matchAll(wordPattern), (match) => match[0].toLowerCase());
  const known = new Set<string>();
  for (let i = 0; i + minWords <= promptWords.length; i++) known.add(promptWords.slice(i, i + minWords).join(' '));
  const copied = new Array<boolean>(words.length).fill(false);
  for (let i = 0; i + minWords <= words.length; i++) {
    if (!known.has(words.slice(i, i + minWords).join(' '))) continue;
    for (let j = i; j < i + minWords; j++) copied[j] = true;
  }
  return words.filter((_, index) => !copied[index]).join(' ');
}
