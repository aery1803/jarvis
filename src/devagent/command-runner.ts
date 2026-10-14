/**
 * Jarvis Local AI Agent: Shell-free command runner
 * Authority: CODING_RULES.md section 9 (input validation)
 *
 * Every external command goes through `execFile` with an argument array, so no value is ever parsed by a shell.
 */

import { execFile } from 'node:child_process';

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  file: string,
  args: readonly string[],
  options?: { timeoutMs?: number; cwd?: string }
) => Promise<CommandResult>;

export const runCommand: CommandRunner = (file, args, options = {}) =>
  new Promise<CommandResult>((resolve, reject) => {
    execFile(
      file,
      [...args],
      { encoding: 'utf8', timeout: options.timeoutMs ?? 60_000, cwd: options.cwd, windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr ? `: ${String(stderr).trim().slice(0, 500)}` : '';
          reject(new Error(`${file} ${args[0] ?? ''} failed: ${error.message}${detail}`));
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      }
    );
  });

const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

/** A git ref or branch name that cannot be mistaken for an option and has no traversal or reserved sequences. */
export function isSafeRefName(name: string): boolean {
  return (
    SAFE_REF.test(name) &&
    !name.includes('..') &&
    !name.includes('//') &&
    !name.endsWith('/') &&
    !name.endsWith('.') &&
    !name.endsWith('.lock')
  );
}
