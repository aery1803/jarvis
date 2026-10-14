const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Strips control characters (keeps tab/newline) so untrusted text cannot smuggle terminal or framing escapes. */
export function stripControlChars(text: string): string {
  return text.replace(CONTROL_CHARS, '');
}

/** Entity-escapes any `<untrusted_data` / `</untrusted_data` (whitespace variants included) so text cannot close a fence early. */
export function escapeFenceTags(text: string): string {
  return text.replace(/<\s*(\/?)\s*untrusted_data/gi, '&lt;$1untrusted_data');
}

/**
 * Wraps untrusted text in an `<untrusted_data>` block for a prompt. Any literal `<untrusted_data` or
 * `</untrusted_data` inside the content is entity-escaped so the payload cannot close the fence early.
 */
export function fenceUntrusted(source: string, content: string, attrs: Record<string, string> = {}): string {
  const safeAttr = (value: string): string => stripControlChars(value).replace(/["<>\r\n]/g, ' ').slice(0, 300);
  const attrText = Object.entries({ source, ...attrs })
    .map(([key, value]) => ` ${key.replace(/[^a-zA-Z0-9_-]/g, '')}="${safeAttr(value)}"`)
    .join('');
  const escaped = escapeFenceTags(stripControlChars(content));
  return `<untrusted_data${attrText}>\n${escaped}\n</untrusted_data>`;
}
