/**
 * Jarvis Local AI Agent: Structured Logger
 * Authority: CODING_RULES.md (Zero-Secrets Hygiene)
 */

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40,
};

// Redaction patterns for secrets (tokens, auth keys, bearer tokens)
const SECRET_PATTERNS = [
  /ghp_[a-zA-Z0-9]{36}/g,
  /github_pat_[a-zA-Z0-9_]{82}/g,
  /bot\d{6,12}:[a-zA-Z0-9_-]{35}/g,
  /Bearer\s+[a-zA-Z0-9_.-]+/gi,
  /password\s*[:=]\s*[^\s,]+/gi,
  /token\s*[:=]\s*[^\s,]+/gi,
];

export function redactSecrets(text: string): string {
  let cleaned = text;
  for (const pattern of SECRET_PATTERNS) {
    cleaned = cleaned.replace(pattern, '[REDACTED_SECRET]');
  }
  return cleaned;
}

export class Logger {
  private level: LogLevel;

  constructor(level: LogLevel = 'INFO') {
    this.level = level;
  }

  public setLevel(level: LogLevel): void {
    this.level = level;
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[this.level];
  }

  private format(level: LogLevel, message: string, meta?: Record<string, unknown>): string {
    const timestamp = new Date().toISOString();
    const cleanMsg = redactSecrets(message);
    const metaStr = meta ? ` | ${redactSecrets(JSON.stringify(meta))}` : '';
    return `[${timestamp}] [${level}] ${cleanMsg}${metaStr}`;
  }

  public debug(message: string, meta?: Record<string, unknown>): void {
    if (this.shouldLog('DEBUG')) {
      console.debug(this.format('DEBUG', message, meta));
    }
  }

  public info(message: string, meta?: Record<string, unknown>): void {
    if (this.shouldLog('INFO')) {
      console.info(this.format('INFO', message, meta));
    }
  }

  public warn(message: string, meta?: Record<string, unknown>): void {
    if (this.shouldLog('WARN')) {
      console.warn(this.format('WARN', message, meta));
    }
  }

  public error(message: string, meta?: Record<string, unknown>): void {
    if (this.shouldLog('ERROR')) {
      console.error(this.format('ERROR', message, meta));
    }
  }
}

function levelFromEnv(value: string | undefined): LogLevel {
  const upper = value?.trim().toUpperCase();
  return upper === 'DEBUG' || upper === 'INFO' || upper === 'WARN' || upper === 'ERROR' ? upper : 'INFO';
}

/** Honours `JARVIS_LOG_LEVEL` (DEBUG, INFO, WARN, ERROR); defaults to INFO. */
export const logger = new Logger(levelFromEnv(process.env.JARVIS_LOG_LEVEL));
