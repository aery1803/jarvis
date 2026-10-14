/**
 * Jarvis Local AI Agent: Sensitive Text Detection
 * Authority: Section 8.3 (encrypted sensitive items), CODING_RULES.md Section 3
 *
 * Finds secrets in free text so they go to the encrypted vault instead of plaintext memory, and so they
 * are redacted before text reaches summaries or episodes. Detection is heuristic: a miss is possible, a
 * false positive only routes a fact to the vault.
 */

export type SensitiveKind = 'password' | 'api-key' | 'token' | 'card-number' | 'ssn' | 'private-key';

export interface SensitiveMatch {
  kind: SensitiveKind;
  start: number;
  end: number;
}

export interface SensitiveScan {
  sensitive: boolean;
  kinds: SensitiveKind[];
  matches: SensitiveMatch[];
}

const TOKEN_PATTERNS: Array<{ kind: SensitiveKind; pattern: RegExp }> = [
  { kind: 'api-key', pattern: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { kind: 'token', pattern: /\bghp_[A-Za-z0-9]{20,}/g },
  { kind: 'token', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { kind: 'token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: 'token', pattern: /\bbearer\s+[A-Za-z0-9._~+/=-]{16,}/gi },
  { kind: 'api-key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'api-key', pattern: /\bAIza[0-9A-Za-z_-]{30,}/g },
  { kind: 'token', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { kind: 'ssn', pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
];

/**
 * A label (`password`, `OPENAI_API_KEY`, `client_secret`...) followed by `is`/`=`/`:` and a value. The prefix and
 * suffix groups let env-var style names match, which a `\b` boundary cannot because `_` is a word character.
 * The value is a quoted string (spaces allowed) or one unquoted token; see `passphraseEnd` for the unquoted
 * password case.
 */
const LABELLED_SECRET =
  /(?<![A-Za-z0-9])(?:[A-Za-z0-9]+[_-])*(pass(?:word|wd|phrase|code)?|pwd|pin|secret|api[ _-]?key|access[ _-]?key|auth(?:entication)?[ _-]?token|token|credentials?)(?:[_-][A-Za-z0-9]+)*(?![A-Za-z0-9])(?:\s+\w+){0,4}?\s*(?:is|are|=|:)\s*(?:"([^"\n]{3,})"|'([^'\n]{3,})'|([^\s"',;]{3,}))/gi;

/** `scheme://user:password@host`: only the password is secret. */
const URL_USERINFO = /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:([^\s@/]+)@/gi;

const PEM_PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/g;

const MAX_PASSPHRASE_CHARS = 200;

/**
 * An unquoted password or passphrase may be several words ("correct horse battery staple"), so it runs to the end
 * of the sentence or line. Over-redacting trailing words is the safe side of the trade.
 */
function passphraseEnd(text: string, valueStart: number): number {
  const rest = text.slice(valueStart, valueStart + MAX_PASSPHRASE_CHARS);
  const stop = /[.!?](?=\s|$)|\r?\n/.exec(rest);
  const end = valueStart + (stop ? stop.index : rest.length);
  return text.slice(valueStart, end).trimEnd().length + valueStart;
}

const CARD_CANDIDATE = /\b(?:\d[ -]?){13,19}\b/g;

function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = digits.charCodeAt(i) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

export function detectSensitive(text: string): SensitiveScan {
  const matches: SensitiveMatch[] = [];

  for (const { kind, pattern } of TOKEN_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      matches.push({ kind, start: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
    }
  }

  for (const match of text.matchAll(CARD_CANDIDATE)) {
    const digits = match[0].replace(/[ -]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && passesLuhn(digits)) {
      matches.push({ kind: 'card-number', start: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
    }
  }

  for (const match of text.matchAll(PEM_PRIVATE_KEY)) {
    matches.push({ kind: 'private-key', start: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
  }

  for (const match of text.matchAll(URL_USERINFO)) {
    const start = (match.index ?? 0) + match[0].length - 1 - match[1].length;
    matches.push({ kind: 'password', start, end: start + match[1].length });
  }

  for (const match of text.matchAll(LABELLED_SECRET)) {
    const label = match[1].toLowerCase();
    const kind: SensitiveKind = label.startsWith('pass') || label === 'pwd' || label === 'pin' || label === 'secret' ? 'password' : /key/.test(label) ? 'api-key' : 'token';
    const value = match[2] ?? match[3] ?? match[4];
    const quoted = match[4] === undefined;
    const valueStart = (match.index ?? 0) + match[0].lastIndexOf(value);
    const end = kind === 'password' && !quoted ? passphraseEnd(text, valueStart) : valueStart + value.length;
    matches.push({ kind, start: valueStart, end });
  }

  matches.sort((a, b) => a.start - b.start || b.end - a.end);
  return { sensitive: matches.length > 0, kinds: [...new Set(matches.map((m) => m.kind))], matches };
}

/** Replaces every detected secret with `[REDACTED:<kind>]`; text without secrets is returned unchanged. */
export function redactSensitive(text: string): string {
  const { matches } = detectSensitive(text);
  if (matches.length === 0) return text;
  let out = '';
  let cursor = 0;
  for (const match of matches) {
    if (match.start < cursor) continue;
    out += `${text.slice(cursor, match.start)}[REDACTED:${match.kind}]`;
    cursor = match.end;
  }
  return out + text.slice(cursor);
}
