/**
 * Jarvis Local AI Agent: What the owner is shown when asked to approve a Tier 2 action
 * Authority: Section 6.2 (Tier 2 requires explicit owner approval each time)
 *
 * The prompt must show the WHOLE action. A clamped `JSON.stringify(args)` in the model's own key order lets a
 * prompt-injected model push the dangerous argument (`to`, a URL, the tail of a command) past the cut-off. So the
 * text is built here: tool name first, then every argument, security-relevant ones first, otherwise in the tool
 * schema's order, never the model's. A long value is shortened with an explicit "(+N chars not shown)" marker and
 * an argument is never dropped; a security-relevant value too long to show in full makes the action unshowable,
 * and the caller must refuse it rather than ask.
 */

/** Arguments that decide who or what an action touches; always listed first, in this order. */
const SECURITY_KEY_ORDER = [
  'to', 'cc', 'bcc', 'recipient', 'recipients', 'url', 'uri', 'href', 'command', 'args', 'cwd', 'path', 'file', 'filepath', 'directory',
  'target', 'host', 'address', 'number', 'phone', 'repo', 'branch', 'deviceid',
];

export const MAX_VALUE_CHARS = 300;
/** A security-relevant value over this length cannot be displayed in full, so the action is refused. */
export const MAX_SECURITY_VALUE_CHARS = 2000;

export interface ApprovalField {
  name: string;
  /** The value as shown to the owner (JSON-encoded, so control characters and quotes are visible escapes). */
  shown: string;
  /** How many characters of the encoded value are not shown; 0 when the whole value is. */
  omittedChars: number;
  securityRelevant: boolean;
}

export interface ApprovalAction {
  /** Multi-line text for the approval banner: the tool name, then one `name: value` line per argument. */
  text: string;
  fields: ApprovalField[];
  /** Set when a security-relevant value is too long to show in full; the caller must deny without asking. */
  unshowable?: string;
}

function encode(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'undefined';
  } catch {
    return '"[unserializable]"';
  }
}

function orderKeys(keys: string[], schemaOrder: readonly string[]): string[] {
  const NOT_RANKED = 1_000_000;
  const schemaRank = new Map(schemaOrder.map((key, index) => [key, index]));
  const securityRank = (key: string): number => {
    const rank = SECURITY_KEY_ORDER.indexOf(key.toLowerCase());
    return rank === -1 ? NOT_RANKED : rank;
  };
  return [...keys].sort(
    (a, b) =>
      securityRank(a) - securityRank(b) || (schemaRank.get(a) ?? NOT_RANKED) - (schemaRank.get(b) ?? NOT_RANKED) || (a < b ? -1 : a > b ? 1 : 0)
  );
}

/** `schemaOrder` is the tool's declared property order; unknown extra keys follow it alphabetically. */
export function formatApprovalAction(toolName: string, args: unknown, schemaOrder: readonly string[] = []): ApprovalAction {
  const record = typeof args === 'object' && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : null;
  const fields: ApprovalField[] = [];
  let unshowable: string | undefined;

  const entries: Array<[string, unknown]> = record ? orderKeys(Object.keys(record), schemaOrder).map((key) => [key, record[key]]) : [['arguments', args]];
  for (const [name, value] of entries) {
    const encoded = encode(value);
    const securityRelevant = SECURITY_KEY_ORDER.includes(name.toLowerCase());
    if (securityRelevant && encoded.length > MAX_SECURITY_VALUE_CHARS) {
      unshowable ??= `'${name}' is ${encoded.length} characters, too long to show the owner in full`;
    }
    const limit = securityRelevant ? MAX_SECURITY_VALUE_CHARS : MAX_VALUE_CHARS;
    const omittedChars = Math.max(0, encoded.length - limit);
    fields.push({ name, shown: omittedChars > 0 ? encoded.slice(0, limit) : encoded, omittedChars, securityRelevant });
  }

  const lines = [`Tool: ${toolName}`];
  for (const field of fields) {
    lines.push(`${field.name}: ${field.shown}${field.omittedChars > 0 ? ` (+${field.omittedChars} chars not shown)` : ''}`);
  }
  if (fields.length === 0) lines.push('(no arguments)');
  return { text: lines.join('\n'), fields, ...(unshowable ? { unshowable } : {}) };
}

export interface ApprovalArgMetadata {
  name: string;
  value: string;
  omittedChars: number;
  securityRelevant: boolean;
}

/** The structured twin of `ApprovalAction.text` for the approval request's metadata; same order, same omitted counts. */
export function approvalArgsMetadata(action: ApprovalAction): ApprovalArgMetadata[] {
  return action.fields.map((field) => ({ name: field.name, value: field.shown, omittedChars: field.omittedChars, securityRelevant: field.securityRelevant }));
}
