/**
 * Jarvis Local AI Agent: Consensus & Fact-Checking Engine
 * Authority: Section 10 (Research & Fact-Check Skill, Consensus Scoring)
 *
 * Confidence is derived from what the excerpts actually say: pairwise content overlap, matching or conflicting
 * numeric facts, polarity (negation) differences, and how many independent origins (distinct domains, with
 * near-duplicate syndicated text collapsed) support the claim. Source count alone never produces a high score.
 */

export type ClaimStatus = 'VERIFIED' | 'DISPUTED' | 'UNCONFIRMED';

export interface SourceFinding {
  source: string;
  excerpt: string;
}

export type ConflictKind = 'numeric' | 'polarity' | 'claim' | 'entity' | 'antonym';

export interface ConsensusConflict {
  kind: ConflictKind;
  /** The two sources in conflict (for `claim` conflicts, the second entry is `claim`). */
  between: [string, string];
  detail: string;
}

export interface ClaimEvaluation {
  claim: string;
  status: ClaimStatus;
  /** 0 when there was nothing to compare (`insufficientSources` is set): a lone source is not agreement. */
  confidence: number;
  sources: string[];
  notes?: string;
  /**
   * Why no agreement figure exists: there was no readable source, a single one, or several that share one origin.
   * Callers show this instead of a percentage.
   */
  insufficientSources?: 'none' | 'single_source' | 'same_origin';
  /** Number of independent origins (distinct domains after collapsing near-duplicate text). */
  independentSources?: number;
  /** Mean pairwise content agreement between independent origins, 0..1. */
  agreement?: number;
  conflicts?: ConsensusConflict[];
}

export interface ConsensusReport {
  overallScore: number;
  verifiedClaimsCount: number;
  disputedClaimsCount: number;
  evaluations: ClaimEvaluation[];
  summary: string;
}

export interface NumericFact {
  lo: number;
  hi: number;
  unit: string;
  /** Content stems in the text window around the number. */
  context: Set<string>;
  /** A year-like integer: 1998 and 1999 are different facts, so the 10% tolerance does not apply. */
  exact?: boolean;
}

const STOPWORDS = new Set(
  (
    'a an the and or but if then else of in on at to for from by with without within into onto over under about above below between among ' +
    'is are was were be been being am do does did done has have had having it its this that these those there here as than so such ' +
    'up out off per via vs also very more most less least much many some any all each both other another can could may might will would shall should ' +
    'which who whom whose what when where why how i you he she we they them their our your his her my me us not no nor only just ' +
    'under over again further once get got gets one two three'
  ).split(/\s+/)
);

const NEGATIONS = new Set([
  'not', 'no', 'never', 'cannot', 'without', 'unsupported', 'fails', 'failed', 'fail', 'false', 'incorrect', 'denied', 'denies', 'deny', 'neither', 'nor', 'none', 'unable', 'lacks', 'lack',
]);

const UNIT_CANON: Record<string, string> = {
  degree: 'degree', degrees: 'degree', celsius: 'degree', fahrenheit: 'degree', meter: 'm', meters: 'm', metre: 'm', metres: 'm', feet: 'ft', foot: 'ft', inch: 'in', inches: 'in',
  hour: 'hour', hours: 'hour', hr: 'hour', hrs: 'hour',
  minute: 'minute', minutes: 'minute', min: 'minute', mins: 'minute',
  second: 'second', seconds: 'second', sec: 'second', secs: 'second', ms: 'ms', millisecond: 'ms', milliseconds: 'ms',
  day: 'day', days: 'day', week: 'week', weeks: 'week', month: 'month', months: 'month', year: 'year', years: 'year',
  gb: 'gb', gib: 'gb', gigabyte: 'gb', gigabytes: 'gb', mb: 'mb', mib: 'mb', megabyte: 'mb', megabytes: 'mb',
  kb: 'kb', kib: 'kb', tb: 'tb', tib: 'tb', terabyte: 'tb', terabytes: 'tb',
  ghz: 'ghz', mhz: 'mhz', hz: 'hz', w: 'w', watt: 'w', watts: 'w', kw: 'kw', wh: 'wh', mah: 'mah',
  mph: 'mph', kph: 'kph', kmh: 'kph', fps: 'fps', tflops: 'tflops', tops: 'tops',
  percent: '%', '%': '%', token: 'token', tokens: 'token', core: 'core', cores: 'core', thread: 'thread', threads: 'thread',
  user: 'user', users: 'user', people: 'user', model: 'model', models: 'model', parameter: 'parameter', parameters: 'parameter',
  b: 'b', mile: 'mile', miles: 'mile', km: 'km', kilometer: 'km', kilometers: 'km', kilometre: 'km', kilometres: 'km',
  dollar: '$', dollars: '$', usd: '$', rupee: '₹', rupees: '₹', inr: '₹', euro: '€', euros: '€', gram: 'g', grams: 'g', kg: 'kg',
};

const MULTIPLIERS: Record<string, number> = {
  k: 1e3, thousand: 1e3, million: 1e6, mn: 1e6, billion: 1e9, bn: 1e9, trillion: 1e12, lakh: 1e5, lakhs: 1e5, crore: 1e7, crores: 1e7,
};

/** Unit given to a number that has a multiplier word or no unit at all; such numbers are compared by their context words. */
const COUNT_UNIT = 'count';
const PLAIN_UNIT = 'num';
const PLAIN_MIN_SHARED_CONTEXT = 2;
const PLAIN_TOLERANCE = 0.02;

const CURRENCY_SYMBOLS: Record<string, string> = { $: '$', '€': '€', '£': '£', '₹': '₹' };
const NUMERIC_TOLERANCE = 0.1;
const DUPLICATE_OVERLAP = 0.9;
const DUPLICATE_MIN_WORDS = 20;
const MIN_AGREEMENT_TO_VERIFY = 0.2;
const SENTENCE_OVERLAP_FOR_POLARITY = 0.5;
const SENTENCE_MIN_SHARED = 3;
const ENTITY_MIN_SHARED = 2;

function stem(word: string): string {
  let w = word.toLowerCase();
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith('es')) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  return w;
}

function contentStems(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (STOPWORDS.has(raw) || NEGATIONS.has(raw)) continue;
    if (raw.length < 3 && !/^\d+$/.test(raw)) continue;
    out.add(stem(raw));
  }
  return out;
}

/** Overlap coefficient |A∩B| / min(|A|,|B|): robust when one excerpt is much longer than the other. */
function overlapCoefficient(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const item of small) if (large.has(item)) shared++;
  return shared / small.size;
}

function sharedCount(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const item of a) if (b.has(item)) shared++;
  return shared;
}

function parseNumber(raw: string): number {
  return Number.parseFloat(raw.replace(/,/g, ''));
}

/** Extracts numbers that carry a recognised unit (or currency/percent), with the surrounding content stems. */
export function extractNumericFacts(text: string): NumericFact[] {
  const facts: NumericFact[] = [];
  const re = /([$€£₹])?\s?(\d[\d,]*(?:\.\d+)?)(?:\s?(?:-|–|—|to)\s?[$€£₹]?(\d[\d,]*(?:\.\d+)?))?\s?(%|[A-Za-z]+)?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const [whole, currency, first, second, trailing] = match;
    let lo = parseNumber(first);
    let hi = second !== undefined ? parseNumber(second) : lo;
    if (Number.isNaN(lo) || Number.isNaN(hi)) continue;

    let unit = currency ? CURRENCY_SYMBOLS[currency] : '';
    let scaled = false;
    if (trailing) {
      const word = trailing.toLowerCase();
      const mult = MULTIPLIERS[word];
      if (mult !== undefined) {
        lo *= mult;
        hi *= mult;
        scaled = true;
      } else if (UNIT_CANON[word] !== undefined && !unit) {
        unit = UNIT_CANON[word];
      }
    }
    // "14 million residents" keeps its magnitude as a count; a bare number is compared by the words around it.
    if (!unit) unit = scaled ? COUNT_UNIT : PLAIN_UNIT;
    // The digits of an identifier ("Z13", "qwen3") are a name, not a quantity.
    const digitsAt = match.index + whole.indexOf(first);
    if (unit === PLAIN_UNIT && digitsAt > 0 && /\p{L}/u.test(text[digitsAt - 1])) continue;
    if (lo > hi) [lo, hi] = [hi, lo];
    const exact = unit === PLAIN_UNIT && lo === hi && Number.isInteger(lo) && lo >= 1000 && lo <= 2100;

    const start = Math.max(0, match.index - 60);
    const end = Math.min(text.length, match.index + whole.length + 60);
    const window = text.slice(start, match.index) + ' ' + text.slice(match.index + whole.length, end);
    facts.push({ lo, hi, unit, context: contentStems(window), ...(exact ? { exact: true } : {}) });
  }
  return facts;
}

function factsMatch(a: NumericFact, b: NumericFact): boolean {
  const tolerance = a.exact || b.exact ? 0 : a.unit === PLAIN_UNIT ? PLAIN_TOLERANCE : NUMERIC_TOLERANCE;
  const slackA = a.hi * (1 + tolerance);
  const slackB = b.hi * (1 + tolerance);
  return a.lo <= slackB && b.lo <= slackA;
}

function describeFact(f: NumericFact): string {
  return f.lo === f.hi ? `${f.lo} ${f.unit}` : `${f.lo}-${f.hi} ${f.unit}`;
}

/** Compares numeric facts of one unit and context. Returns `agree`, `conflict` (with detail), or null when not comparable. */
function compareFacts(a: NumericFact[], b: NumericFact[], minContextShared: number): { agree: boolean; conflict?: string } | null {
  let comparable = false;
  let agreed = false;
  const conflicts: string[] = [];
  const units = new Set(a.map((f) => f.unit));
  for (const unit of units) {
    const as = a.filter((f) => f.unit === unit);
    const bs = b.filter((f) => f.unit === unit);
    const related: Array<[NumericFact, NumericFact]> = [];
    const needShared = unit === PLAIN_UNIT ? Math.max(minContextShared, PLAIN_MIN_SHARED_CONTEXT) : minContextShared;
    for (const fa of as) for (const fb of bs) if (sharedCount(fa.context, fb.context) >= needShared) related.push([fa, fb]);
    if (related.length === 0) continue;
    comparable = true;
    // Judged per unit: two sources agreeing on a model number must not hide that they differ on the gigabytes.
    if (related.some(([fa, fb]) => factsMatch(fa, fb))) {
      agreed = true;
    } else {
      const [fa, fb] = related[0];
      conflicts.push(`${describeFact(fa)} vs ${describeFact(fb)}`);
    }
  }
  if (!comparable) return null;
  if (conflicts.length > 0) return { agree: false, conflict: conflicts.join('; ') };
  return { agree: agreed };
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function negationParity(sentence: string): boolean {
  const words = sentence.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
  let negations = 0;
  for (const w of words) {
    if (NEGATIONS.has(w) || /n['’]t$/.test(w)) negations++;
  }
  return negations % 2 === 1;
}

/** Reduces a source string (URL, bare host or label such as `model:qwen3:8b`) to the origin used for independence. */
export function sourceDomain(source: string): string {
  const trimmed = source.trim().toLowerCase();
  let host = '';
  try {
    host = new URL(trimmed).hostname;
  } catch {
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/.*)?$/.test(trimmed)) {
      try {
        host = new URL(`https://${trimmed}`).hostname;
      } catch {
        host = '';
      }
    }
  }
  if (!host) return trimmed;
  host = host.replace(/^www\./, '');
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  const secondLevel = new Set(['co', 'com', 'org', 'net', 'gov', 'ac', 'edu']);
  const keep = labels[labels.length - 1].length === 2 && secondLevel.has(labels[labels.length - 2]) ? 3 : 2;
  return labels.slice(-keep).join('.');
}

function looksLikeQuestion(claim: string): boolean {
  const c = claim.trim().toLowerCase();
  return c.endsWith('?') || /^(what|why|how|who|whom|whose|when|where|which|is|are|does|do|did|can|could|should|will|would)\b/.test(c);
}

/** Word pairs that mean the opposite of each other; one in each of two same-topic sentences is a contradiction. */
const ANTONYM_PAIRS: Array<[string[], string[]]> = [
  [['approved', 'approve', 'approves', 'accepted', 'accept', 'accepts', 'granted'], ['rejected', 'reject', 'rejects', 'declined', 'decline', 'declines', 'refused', 'revoked']],
  [['allowed', 'allow', 'allows', 'permitted', 'legal', 'lawful'], ['banned', 'ban', 'bans', 'prohibited', 'prohibits', 'forbidden', 'illegal', 'unlawful', 'blocked']],
  [['increase', 'increased', 'increases', 'rise', 'rose', 'risen', 'rises', 'grew', 'grow', 'grows', 'gained', 'higher', 'more', 'faster', 'larger', 'bigger', 'greater'], ['decrease', 'decreased', 'decreases', 'fall', 'fell', 'fallen', 'falls', 'drop', 'dropped', 'shrank', 'shrink', 'lost', 'lower', 'less', 'fewer', 'slower', 'smaller', 'lesser']],
  [['true', 'correct', 'accurate', 'confirmed', 'safe', 'secure', 'supports', 'supported', 'successful', 'succeeded', 'passed'], ['false', 'incorrect', 'inaccurate', 'unsafe', 'insecure', 'dangerous', 'opposes', 'opposed', 'broken', 'unsuccessful', 'lose', 'loses', 'defeated', 'failed', 'fails']],
  [['best', 'largest', 'biggest', 'highest', 'fastest', 'longest', 'tallest', 'maximum'], ['worst', 'smallest', 'lowest', 'slowest', 'shortest', 'minimum']],
  [['alive', 'living', 'survived', 'available', 'enabled', 'included', 'supported'], ['dead', 'died', 'killed', 'unavailable', 'disabled', 'excluded', 'unsupported']],
  [['hot', 'warm', 'hotter', 'warmer'], ['cold', 'cool', 'colder', 'cooler']],
  [['win', 'won', 'victory', 'victorious'], ['lose', 'lost', 'defeat', 'defeated']],
];
const ANTONYM_OF: Map<string, Set<string>> = (() => {
  const map = new Map<string, Set<string>>();
  const link = (from: string, to: string[]): void => {
    const set = map.get(from) ?? new Set<string>();
    for (const word of to) if (word !== from) set.add(word);
    map.set(from, set);
  };
  for (const [left, right] of ANTONYM_PAIRS) {
    for (const word of left) link(word, right);
    for (const word of right) link(word, left);
  }
  return map;
})();

interface Entity {
  word: string;
  /** The two words before it, lower-cased: two entities fill the same slot when these match. */
  slot: string;
}

interface PreparedSentence {
  stems: Set<string>;
  negated: boolean;
  words: Set<string>;
  entities: Entity[];
}

interface PreparedFinding {
  source: string;
  domain: string;
  excerpt: string;
  stems: Set<string>;
  facts: NumericFact[];
  sentences: PreparedSentence[];
}

function prepareSentence(sentence: string): PreparedSentence {
  const tokens = sentence.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [];
  const lower = tokens.map((token) => token.toLowerCase());
  const entities: Entity[] = [];
  tokens.forEach((token, index) => {
    const word = lower[index];
    if (!/^\p{Lu}/u.test(token) || token.length < 2 || STOPWORDS.has(word) || NEGATIONS.has(word)) return;
    entities.push({ word, slot: lower.slice(Math.max(0, index - 2), index).join(' ') });
  });
  return { stems: contentStems(sentence), negated: negationParity(sentence), words: new Set(lower), entities };
}

function prepare(finding: SourceFinding): PreparedFinding {
  const excerpt = finding.excerpt.trim();
  return {
    source: finding.source,
    domain: sourceDomain(finding.source),
    excerpt,
    stems: contentStems(excerpt),
    facts: extractNumericFacts(excerpt),
    sentences: sentences(excerpt).map(prepareSentence),
  };
}

function pairAgreement(a: PreparedFinding, b: PreparedFinding): number {
  const overlap = overlapCoefficient(a.stems, b.stems);
  const facts = compareFacts(a.facts, b.facts, 1);
  const numericAgree = facts?.agree === true;
  return Math.min(1, overlap * 0.7 + (numericAgree ? 0.3 : 0));
}

function findConflict(a: PreparedFinding, b: PreparedFinding): ConsensusConflict | null {
  const facts = compareFacts(a.facts, b.facts, 1);
  if (facts && facts.conflict) {
    return { kind: 'numeric', between: [a.source, b.source], detail: facts.conflict };
  }
  for (const sa of a.sentences) {
    for (const sb of b.sentences) {
      if (sa.negated === sb.negated) continue;
      if (sharedCount(sa.stems, sb.stems) < SENTENCE_MIN_SHARED) continue;
      if (overlapCoefficient(sa.stems, sb.stems) < SENTENCE_OVERLAP_FOR_POLARITY) continue;
      return { kind: 'polarity', between: [a.source, b.source], detail: 'One source affirms and the other negates the same statement.' };
    }
  }
  for (const sa of a.sentences) {
    for (const sb of b.sentences) {
      const shared = sharedCount(sa.stems, sb.stems);
      if (shared < ENTITY_MIN_SHARED || overlapCoefficient(sa.stems, sb.stems) < SENTENCE_OVERLAP_FOR_POLARITY) continue;
      // Two shared topic words are enough when the swapped names sit in the same slot ("capital of Australia is ...").
      const swap = entitySwap(sa, sb);
      if (swap) return { kind: 'entity', between: [a.source, b.source], detail: `The sources name different entities for the same statement: ${swap}.` };
      if (shared < SENTENCE_MIN_SHARED) continue;
      const opposite = antonymClash(sa, sb);
      if (opposite) return { kind: 'antonym', between: [a.source, b.source], detail: `The sources use opposite words for the same statement: ${opposite}.` };
    }
  }
  return null;
}

/** Same-topic sentences that each name a proper noun the other lacks, in the same slot ("located in Paris" / "located in Berlin"). */
function entitySwap(a: PreparedSentence, b: PreparedSentence): string | null {
  for (const ea of a.entities) {
    if (b.words.has(ea.word)) continue;
    for (const eb of b.entities) {
      if (a.words.has(eb.word) || ea.slot !== eb.slot || ea.slot === '') continue;
      return `"${ea.word}" vs "${eb.word}"`;
    }
  }
  return null;
}

function antonymClash(a: PreparedSentence, b: PreparedSentence): string | null {
  for (const word of a.words) {
    const opposites = ANTONYM_OF.get(word);
    if (!opposites || b.words.has(word)) continue;
    for (const other of opposites) if (b.words.has(other) && !a.words.has(other)) return `"${word}" vs "${other}"`;
  }
  return null;
}

export class ConsensusEngine {
  /**
   * Evaluates a single claim across multiple source findings.
   */
  public evaluateClaim(claim: string, findings: SourceFinding[]): ClaimEvaluation {
    const prepared = findings.map(prepare).filter((f) => f.excerpt.length > 0);
    const uniqueSources = Array.from(new Set(findings.map((f) => f.source)));

    if (prepared.length === 0) {
      return {
        claim,
        status: 'UNCONFIRMED',
        confidence: 0,
        sources: uniqueSources,
        notes: findings.length === 0 ? 'No sources provided to corroborate claim.' : 'Sources contained no readable text.',
        independentSources: 0,
        insufficientSources: 'none',
      };
    }

    const groups = this.groupByOrigin(prepared);
    const conflicts: ConsensusConflict[] = [];

    for (let i = 0; i < prepared.length; i++) {
      for (let j = i + 1; j < prepared.length; j++) {
        const conflict = findConflict(prepared[i], prepared[j]);
        if (conflict) conflicts.push(conflict);
      }
    }

    if (!looksLikeQuestion(claim)) {
      const claimFacts = extractNumericFacts(claim);
      if (claimFacts.length > 0) {
        for (const p of prepared) {
          const stance = compareFacts(claimFacts, p.facts, 1);
          if (stance?.conflict) {
            conflicts.push({ kind: 'claim', between: [p.source, 'claim'], detail: `claim and source disagree on a value (claim vs source): ${stance.conflict}`});
          }
        }
      }
    }

    const agreement = this.groupAgreement(prepared, groups);
    const independent = groups.length;

    if (conflicts.length > 0) {
      const confidence = Number((0.2 + 0.25 * agreement).toFixed(2));
      return {
        claim,
        status: 'DISPUTED',
        confidence,
        sources: uniqueSources,
        notes: `Sources conflict: ${conflicts.slice(0, 3).map((c) => c.detail).join(' | ')}`,
        independentSources: independent,
        agreement: Number(agreement.toFixed(2)),
        conflicts,
      };
    }

    if (independent >= 2 && agreement >= MIN_AGREEMENT_TO_VERIFY) {
      const confidence = Math.min(0.95, 0.55 + 0.1 * (Math.min(independent, 3) - 1) + 0.2 * agreement);
      return {
        claim,
        status: 'VERIFIED',
        confidence: Number(confidence.toFixed(2)),
        sources: uniqueSources,
        notes: `${independent} independent sources cover the same topic (content overlap ${(agreement * 100).toFixed(0)}%) and none contradicts another on a number, a negation, a named entity or an opposite word. This is a lexical check, not a reading of the meaning.`,
        independentSources: independent,
        agreement: Number(agreement.toFixed(2)),
      };
    }

    if (independent >= 2) {
      return {
        claim,
        status: 'UNCONFIRMED',
        confidence: Number((0.35 + 0.2 * agreement).toFixed(2)),
        sources: uniqueSources,
        notes: `${independent} independent sources, but their content barely overlaps; no source confirms another.`,
        independentSources: independent,
        agreement: Number(agreement.toFixed(2)),
      };
    }

    // Nothing to compare: one source, or several that are one origin. No agreement figure is invented.
    const sameOrigin = prepared.length > 1;
    return {
      claim,
      status: 'UNCONFIRMED',
      confidence: 0,
      sources: uniqueSources,
      notes: sameOrigin
        ? 'All excerpts share one origin (same domain or near-identical text); not independent corroboration, so there is no agreement figure.'
        : 'Single source only; uncorroborated, so there is no agreement figure.',
      independentSources: independent,
      insufficientSources: sameOrigin ? 'same_origin' : 'single_source',
    };
  }

  /** Groups findings that share a domain or carry near-identical long text (syndication) into one independent origin. */
  private groupByOrigin(prepared: PreparedFinding[]): number[][] {
    const parent = prepared.map((_, i) => i);
    const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
    const union = (a: number, b: number): void => {
      parent[find(a)] = find(b);
    };
    for (let i = 0; i < prepared.length; i++) {
      for (let j = i + 1; j < prepared.length; j++) {
        if (prepared[i].domain === prepared[j].domain) {
          union(i, j);
          continue;
        }
        const longEnough = Math.min(prepared[i].stems.size, prepared[j].stems.size) >= DUPLICATE_MIN_WORDS;
        if (longEnough && overlapCoefficient(prepared[i].stems, prepared[j].stems) >= DUPLICATE_OVERLAP) union(i, j);
      }
    }
    const byRoot = new Map<number, number[]>();
    prepared.forEach((_, i) => {
      const root = find(i);
      byRoot.set(root, [...(byRoot.get(root) ?? []), i]);
    });
    return Array.from(byRoot.values());
  }

  private groupAgreement(prepared: PreparedFinding[], groups: number[][]): number {
    if (groups.length < 2) return 0;
    let total = 0;
    let pairs = 0;
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        let best = 0;
        for (const a of groups[i]) for (const b of groups[j]) best = Math.max(best, pairAgreement(prepared[a], prepared[b]));
        total += best;
        pairs++;
      }
    }
    return pairs > 0 ? total / pairs : 0;
  }

  /**
   * Aggregates multiple evaluated claims into a master ConsensusReport.
   */
  public buildReport(claimsData: Array<{ claim: string; sources: SourceFinding[] }>): ConsensusReport {
    const evaluations = claimsData.map((cd) => this.evaluateClaim(cd.claim, cd.sources));

    const verified = evaluations.filter((e) => e.status === 'VERIFIED');
    const disputed = evaluations.filter((e) => e.status === 'DISPUTED');
    const unconfirmed = evaluations.filter((e) => e.status === 'UNCONFIRMED');

    // A claim with nothing to compare against has no agreement figure, so it cannot pull the average anywhere.
    const comparable = evaluations.filter((e) => e.insufficientSources === undefined);
    const totalScore = comparable.reduce((acc, curr) => acc + curr.confidence, 0);
    const overallScore = comparable.length > 0 ? Number((totalScore / comparable.length).toFixed(2)) : 0;

    let summary = `Source agreement across ${evaluations.length} claim(s): ${verified.length} verified, ${disputed.length} disputed, ${unconfirmed.length} unconfirmed.`;
    if (disputed.length > 0) {
      summary += ` Warning: ${disputed.length} claim(s) disputed across sources.`;
    } else if (verified.length === 0 && evaluations.length > 0) {
      summary += ' No claim was independently corroborated.';
    }

    return {
      overallScore,
      verifiedClaimsCount: verified.length,
      disputedClaimsCount: disputed.length,
      evaluations,
      summary,
    };
  }
}
