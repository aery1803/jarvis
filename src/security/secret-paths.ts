/**
 * Jarvis Local AI Agent: One predicate for "this path may hold secrets"
 * Authority: Section 6.2, CODING_RULES.md section 5
 *
 * `file_read` and the Tier 1 `host_command` reads (`cat`, `type`, `git diff`) must refuse the same files, so both
 * import this predicate instead of keeping their own lists.
 */

const SECRET_EXTENSIONS = ['.db', '.sqlite', '.sqlite3', '.db-wal', '.db-shm', '.db-journal', '.pem', '.key', '.pfx', '.p12', '.crt', '.keystore', '.jks', '.ppk'];
const SECRET_BASENAMES = new Set(['.env', 'settings.env', 'credentials.json', '.npmrc', '.netrc', 'id_rsa', 'id_ed25519', 'token.json', 'secrets.json', 'vault.key']);
const SECRET_DIRECTORIES = new Set(['.git', '.ssh', '.gnupg', '.aws']);
const SECRET_BASENAME_PATTERNS = [/^\.env\./, /\.env$/, /^id_(rsa|ed25519|ecdsa|dsa)/, /^credentials/, /^(tokens?|secrets?)(\.[^.]+)?$/];

/**
 * Git pathspecs (`:(exclude,icase)...`) that keep `git diff` from printing a secret file's content. `*` in a
 * non-glob pathspec crosses `/`, so each entry covers every directory depth.
 */
export const SECRET_GIT_EXCLUDE_PATHSPECS: readonly string[] = [
  ...['.env', 'settings.env', '.npmrc', '.netrc', 'token.json', 'secrets.json', 'credentials.json', 'vault.key', 'id_rsa', 'id_ed25519'].map((name) => `:(exclude,icase)*${name}*`),
  ':(exclude,icase)*.env.*',
  ...SECRET_EXTENSIONS.map((ext) => `:(exclude,icase)*${ext}`),
  ':(exclude,icase).ssh/*',
  ':(exclude,icase)*/.ssh/*',
  ':(exclude,icase)data/*',
];

/** Windows ignores case, trailing dots and spaces, and an `::$DATA` stream suffix, so the check normalises all four. */
function normalizeSegment(segment: string): string {
  const withoutStream = segment.split(':')[0] ?? '';
  return withoutStream.toLowerCase().replace(/[. ]+$/, '');
}

/** `relativePath` is relative to the workspace root; the root's `data/` directory holds the databases. */
export function isSecretPath(relativePath: string): boolean {
  const segments = relativePath.split(/[\\/]+/).map(normalizeSegment).filter(Boolean);
  if (segments.length === 0) return false;
  const base = segments[segments.length - 1];
  return (
    segments[0] === 'data' ||
    segments.some((segment) => SECRET_DIRECTORIES.has(segment)) ||
    SECRET_BASENAMES.has(base) ||
    SECRET_BASENAME_PATTERNS.some((pattern) => pattern.test(base)) ||
    SECRET_EXTENSIONS.some((ext) => base.endsWith(ext))
  );
}
