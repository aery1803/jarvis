/**
 * Jarvis Local AI Agent: Telegram message formatting helpers
 *
 * Bot-authored messages go out with `parse_mode: 'Markdown'` (legacy Markdown), so every dynamic value in them
 * is escaped here. Model output, email text and other untrusted strings are never sent through Markdown: they
 * are sent as plain text, where Telegram does not interpret any entity.
 */

/** Escapes the four characters legacy Markdown treats as entity starts (`_`, `*`, `` ` ``, `[`). */
export function esc(text: string): string {
  return text.replace(/([_*`\[])/g, '\\$1');
}

/** A value inside a legacy-Markdown code span. Backticks and backslashes cannot be escaped there, so they are dropped. */
export function code(text: string): string {
  return `\`${text.replace(/[`\\]/g, '').replace(/[\r\n]+/g, ' ')}\``;
}

/** Undoes `esc` for the plain-text resend after Telegram rejects Markdown, so no stray backslashes are shown. */
export function unescapeMarkdown(text: string): string {
  return text.replace(/\\([_*`\[])/g, '$1');
}

/** Strips control characters and collapses whitespace, so an untrusted one-line value cannot break the layout. */
export function oneLine(text: string, maxChars = 120): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return clean.length > maxChars ? `${clean.slice(0, Math.max(0, maxChars - 3))}...` : clean;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return 'unknown';
  const gib = bytes / 2 ** 30;
  if (gib >= 1) return `${gib.toFixed(1)} GiB`;
  return `${(bytes / 2 ** 20).toFixed(0)} MiB`;
}

export function formatAge(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return 'never';
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min ago`;
  return `${(minutes / 60).toFixed(1)} h ago`;
}
