/**
 * Jarvis Local AI Agent: Sensitive Text Detection
 * Authority: Section 8.3 (encrypted sensitive items), CODING_RULES.md Section 3
 *
 * Finds secrets in free text so they go to the encrypted vault instead of plaintext memory, and so they
 * are redacted before text reaches summaries or episodes. Detection is heuristic: a miss is possible, a
 * false positive only routes a fact to the vault.
 */

export type SensitiveKind = 'password' | 'api-key' | 'token' | 'card-number' | 'ssn';

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

const LABELLED_SECRET =
  /\b(pass(?:word|wd|phrase|code)?|pwd|pin|secret|api[ _-]?key|access[ _-]?key|auth(?:entication)?[ _-]?token|token|credentials?)\b(?:\s+\w+){0,4}?\s*(?:is|are|=|:)\s*(["']?)([^\s"',;]{3,})\2/gi;

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

  for (const match of text.matchAll(LABELLED_SECRET)) {
    const label = match[1].toLowerCase();
    const kind: SensitiveKind = label.startsWith('pass') || label === 'pwd' || label === 'pin' || label === 'secret' ? 'password' : /key/.test(label) ? 'api-key' : 'token';
    const valueStart = (match.index ?? 0) + match[0].lastIndexOf(match[3]);
    matches.push({ kind, start: valueStart, end: valueStart + match[3].length });
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
