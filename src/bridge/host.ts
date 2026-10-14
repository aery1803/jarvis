import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HostCommand, HostCommandResult, ScreenState } from './types.js';
import type { ActionGateway } from '../devagent/action-gateway.js';
import { stripControlChars } from './untrusted.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const SHELL_METACHARACTERS = /[;&|`$><\r\n\0]/;
const SECRET_FILE_PATTERN = /^(\.env(\..*)?|settings\.env|.*\.(pem|key|pfx|p12)|id_(rsa|ed25519|ecdsa).*|credentials.*)$/i;
const ENV_PASSTHROUGH = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'windir', 'COMSPEC', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR'];

const GIT_STATUS_FLAGS = new Set(['-s', '--short', '-b', '--branch', '-sb', '--porcelain', '--porcelain=v1', '--porcelain=v2', '--long']);
const GIT_LOG_FLAGS = new Set(['--oneline', '--stat', '--graph', '--decorate', '--no-color', '--name-only', '--name-status', '--shortstat', '--numstat', '--no-merges', '--merges']);
const GIT_DIFF_FLAGS = new Set(['--stat', '--name-only', '--name-status', '--cached', '--staged', '--no-color', '--shortstat', '--numstat', '--summary']);
const GIT_BRANCH_FLAGS = new Set(['-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose', '--list', '--show-current', '--no-color']);
const GIT_REVISION = /^[A-Za-z0-9._/~^@{}-]+$/;

const WINDOW_QUERY_SCRIPT = `
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class JarvisWin {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
}
"@
[void][JarvisWin]::SetProcessDPIAware()
$sb = New-Object System.Text.StringBuilder 512
[void][JarvisWin]::GetWindowText([JarvisWin]::GetForegroundWindow(), $sb, 512)
@{ title = $sb.ToString(); width = [JarvisWin]::GetSystemMetrics(0); height = [JarvisWin]::GetSystemMetrics(1) } | ConvertTo-Json -Compress
`;

export interface ProcessRunOptions {
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  /** Only ever set for owner-approved Tier 2 lines, or the fixed `npm.cmd`/`pnpm.cmd` version probes. */
  shell: boolean;
}

export interface ProcessRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

export type ProcessRunner = (file: string, args: string[], options: ProcessRunOptions) => Promise<ProcessRunResult>;

export interface HostBridgeOptions {
  /** Directory Tier 1 file reads and listings are confined to. Defaults to `process.cwd()`. */
  workspaceRoot?: string;
  maxOutputBytes?: number;
  platform?: NodeJS.Platform;
  runProcess?: ProcessRunner;
}

type HostPlan =
  | { kind: 'process'; file: string; args: string[]; shell?: boolean }
  | { kind: 'builtin'; name: 'echo' | 'pwd' | 'whoami' | 'hostname'; args: string[] }
  | { kind: 'builtin'; name: 'ls'; target: string; showHidden: boolean }
  | { kind: 'builtin'; name: 'cat'; targets: string[] };

export interface HostCommandClassification {
  tier: 1 | 2;
  reason: string;
  /** Present only for Tier 1: the exact shell-free operation that will run. */
  plan?: HostPlan;
}

function tokenize(line: string): string[] | null {
  const tokens: string[] = [];
  let current = '';
  let started = false;
  let quote: string | null = null;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
    } else {
      current += ch;
      started = true;
    }
  }
  if (quote) return null;
  if (started) tokens.push(current);
  return tokens;
}

function realpathOrResolved(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

function capText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false };
  return { text: Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8'), truncated: true };
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' };
  for (const key of ENV_PASSTHROUGH) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

interface ExecFailure extends Error {
  code?: string | number;
  killed?: boolean;
}

const defaultRunProcess: ProcessRunner = (file, args, options) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd: options.cwd,
        env: cleanEnv(),
        timeout: options.timeoutMs,
        maxBuffer: options.maxOutputBytes,
        encoding: 'utf8',
        windowsHide: true,
        shell: options.shell,
      },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ exitCode: 0, stdout, stderr, timedOut: false, truncated: false });
          return;
        }
        const failure = err as ExecFailure;
        const truncated = failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
        const timedOut = failure.killed === true && !truncated;
        resolve({
          exitCode: typeof failure.code === 'number' ? failure.code : failure.code === 'ENOENT' ? 127 : 1,
          stdout: stdout ?? '',
          stderr: stderr || failure.message,
          timedOut,
          truncated,
        });
      }
    );
  });

export class HostBridge {
  private readonly workspaceRoot: string;
  private readonly maxOutputBytes: number;
  private readonly platform: NodeJS.Platform;
  private readonly runProcess: ProcessRunner;

  constructor(private gateway?: ActionGateway, options: HostBridgeOptions = {}) {
    this.workspaceRoot = realpathOrResolved(options.workspaceRoot ?? process.cwd());
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.platform = options.platform ?? os.platform();
    this.runProcess = options.runProcess ?? defaultRunProcess;
  }

  /**
   * Derives the tier from the full command line. Only a small allowlist of read-only, argument-validated
   * commands is Tier 1; everything else (unknown binaries, shell metacharacters, unvalidated flags) is Tier 2.
   */
  classifyCommand(cmd: Pick<HostCommand, 'command' | 'args' | 'cwd'>): HostCommandClassification {
    const parts = [cmd.command, ...(cmd.args ?? [])];
    if (parts.some((part) => SHELL_METACHARACTERS.test(part))) {
      return { tier: 2, reason: 'contains shell metacharacters or command substitution' };
    }

    const commandTokens = tokenize(cmd.command);
    if (commandTokens === null) return { tier: 2, reason: 'unbalanced quotes' };
    const argv = [...commandTokens, ...(cmd.args ?? [])];
    if (argv.length === 0) return { tier: 2, reason: 'empty command' };

    const base = cmd.cwd ? path.resolve(cmd.cwd) : this.workspaceRoot;
    if (!this.isInsideWorkspace(base)) return { tier: 2, reason: 'working directory is outside the workspace' };

    const binary = argv[0].toLowerCase().replace(/\.exe$/, '');
    if (/[\\/]/.test(binary)) return { tier: 2, reason: 'path-qualified binary is not allowlisted' };
    const rest = argv.slice(1);

    switch (binary) {
      case 'node':
      case 'npm':
      case 'pnpm': {
        if (rest.length !== 1 || (rest[0] !== '-v' && rest[0] !== '--version')) {
          return { tier: 2, reason: `only '${binary} -v' is allowlisted` };
        }
        const needsShell = this.platform === 'win32' && binary !== 'node';
        return {
          tier: 1,
          reason: 'version probe',
          plan: { kind: 'process', file: needsShell ? `${binary}.cmd` : binary, args: ['-v'], shell: needsShell },
        };
      }
      case 'git':
        return this.classifyGit(rest);
      case 'echo':
        return { tier: 1, reason: 'echo', plan: { kind: 'builtin', name: 'echo', args: rest } };
      case 'pwd':
      case 'whoami':
      case 'hostname':
        if (rest.length > 0) return { tier: 2, reason: `'${binary}' takes no arguments` };
        return { tier: 1, reason: binary, plan: { kind: 'builtin', name: binary, args: [] } };
      case 'ls':
      case 'dir':
        return this.classifyListing(rest, base);
      case 'cat':
      case 'type':
        return this.classifyRead(rest, base);
      default:
        return { tier: 2, reason: `'${binary}' is not an allowlisted command` };
    }
  }

  classifyCommandTier(command: string, args?: string[]): 1 | 2 {
    return this.classifyCommand({ command, args }).tier;
  }

  /**
   * Runs a command on the host. Tier 1 commands run without a shell; anything else needs
   * `isOwnerExplicitlyApproved` and is audited through the Action Gateway when one is configured.
   */
  async executeCommand(cmd: HostCommand, isOwnerExplicitlyApproved = false): Promise<HostCommandResult> {
    const classification = this.classifyCommand(cmd);
    const effectiveTier = cmd.tier === 2 ? 2 : classification.tier;
    const displayLine = [cmd.command, ...(cmd.args ?? [])].join(' ');

    if (effectiveTier === 2 && !isOwnerExplicitlyApproved) {
      throw new Error(
        `Action Blocked: Command '${displayLine}' is classified as Tier 2 (${classification.reason}). Explicit owner confirmation required.`
      );
    }
    if (!displayLine.trim()) throw new Error('Action Blocked: empty command.');

    const timeoutMs = Math.min(Math.max(cmd.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1), MAX_TIMEOUT_MS);
    const cwd = cmd.cwd ? path.resolve(cmd.cwd) : this.workspaceRoot;
    const start = Date.now();

    const run = async (): Promise<HostCommandResult> => {
      if (classification.tier === 1 && classification.plan) {
        return this.runPlan(classification.plan, cwd, timeoutMs, start);
      }
      const result = await this.runProcess(displayLine, [], { cwd, timeoutMs, maxOutputBytes: this.maxOutputBytes, shell: true });
      return this.toResult(result, start);
    };

    if (this.gateway) {
      if (effectiveTier === 2) {
        const target = (cmd.command.trim().split(/\s+/)[0] ?? 'host').slice(0, 64);
        return this.gateway.executeTier2Action('HOST_COMMAND', 'Owner-approved host command', target, run);
      }
      this.gateway.verifyMemoryHeadroom();
    }
    return run();
  }

  /**
   * Reads the foreground window title and primary-screen resolution. On Windows this runs one fixed
   * PowerShell script (no caller input); elsewhere nothing real can be read, so it says so.
   */
  async getScreenState(): Promise<ScreenState> {
    const timestamp = new Date().toISOString();
    if (this.platform !== 'win32') {
      return {
        timestamp,
        activeWindow: null,
        resolution: null,
        unavailableReason: `screen state is only implemented for Windows hosts (platform: ${this.platform})`,
        isUntrusted: true,
      };
    }

    const encoded = Buffer.from(WINDOW_QUERY_SCRIPT, 'utf16le').toString('base64');
    let raw: ProcessRunResult;
    try {
      raw = await this.runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
        cwd: this.workspaceRoot,
        timeoutMs: 8000,
        maxOutputBytes: 8 * 1024,
        shell: false,
      });
    } catch (err: unknown) {
      return this.unavailableScreen(timestamp, `PowerShell failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (raw.exitCode !== 0) {
      return this.unavailableScreen(timestamp, `PowerShell exited with code ${raw.exitCode}${raw.timedOut ? ' (timed out)' : ''}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.stdout.trim());
    } catch {
      return this.unavailableScreen(timestamp, 'PowerShell returned unparseable output');
    }
    const record = parsed as { title?: unknown; width?: unknown; height?: unknown } | null;
    const width = typeof record?.width === 'number' ? record.width : 0;
    const height = typeof record?.height === 'number' ? record.height : 0;
    const title = typeof record?.title === 'string' ? stripControlChars(record.title).trim().slice(0, 200) : '';
    return {
      timestamp,
      activeWindow: title || null,
      resolution: width > 0 && height > 0 ? { width, height } : null,
      unavailableReason: title ? undefined : 'no foreground window title (desktop or lock screen)',
      isUntrusted: true,
    };
  }

  private unavailableScreen(timestamp: string, reason: string): ScreenState {
    return { timestamp, activeWindow: null, resolution: null, unavailableReason: reason, isUntrusted: true };
  }

  private isInsideWorkspace(target: string): boolean {
    const relative = path.relative(this.workspaceRoot, realpathOrResolved(target));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  }

  private classifyGit(rest: string[]): HostCommandClassification {
    const [sub, ...flags] = rest;
    const allowed: Record<string, Set<string>> = {
      status: GIT_STATUS_FLAGS,
      log: GIT_LOG_FLAGS,
      diff: GIT_DIFF_FLAGS,
      branch: GIT_BRANCH_FLAGS,
    };
    const allowedFlags = sub ? allowed[sub] : undefined;
    if (!allowedFlags) return { tier: 2, reason: `'git ${sub ?? ''}' is not allowlisted` };

    const allowsRevisions = sub === 'log' || sub === 'diff';
    for (let i = 0; i < flags.length; i++) {
      const flag = flags[i];
      if (allowedFlags.has(flag)) continue;
      if (sub === 'log') {
        if (/^-\d+$/.test(flag) || /^-n\d+$/.test(flag) || /^--max-count=\d+$/.test(flag)) continue;
        if (flag === '-n' && /^\d+$/.test(flags[i + 1] ?? '')) {
          i++;
          continue;
        }
      }
      if (allowsRevisions && !flag.startsWith('-') && GIT_REVISION.test(flag)) continue;
      return { tier: 2, reason: `git ${sub} argument '${flag}' is not allowlisted` };
    }

    const prefix = ['-c', 'core.fsmonitor=false', '--no-pager'];
    const extra = sub === 'diff' ? ['--no-ext-diff'] : [];
    return { tier: 1, reason: `read-only git ${sub}`, plan: { kind: 'process', file: 'git', args: [...prefix, sub, ...extra, ...flags] } };
  }

  private classifyListing(rest: string[], base: string): HostCommandClassification {
    let showHidden = false;
    const paths: string[] = [];
    for (const arg of rest) {
      if (/^-[al1]+$/.test(arg)) {
        if (arg.includes('a')) showHidden = true;
      } else if (/^\/[abw]$/i.test(arg)) {
        if (arg.toLowerCase() === '/a') showHidden = true;
      } else if (arg.startsWith('-')) {
        return { tier: 2, reason: `listing flag '${arg}' is not allowlisted` };
      } else {
        paths.push(arg);
      }
    }
    if (paths.length > 1) return { tier: 2, reason: 'listing more than one path is not allowlisted' };
    const target = path.resolve(base, paths[0] ?? '.');
    if (!this.isInsideWorkspace(target)) return { tier: 2, reason: 'path is outside the workspace' };
    return { tier: 1, reason: 'directory listing', plan: { kind: 'builtin', name: 'ls', target: realpathOrResolved(target), showHidden } };
  }

  private classifyRead(rest: string[], base: string): HostCommandClassification {
    if (rest.length === 0 || rest.length > 3) return { tier: 2, reason: 'expected one to three file paths' };
    const targets: string[] = [];
    for (const arg of rest) {
      if (arg.startsWith('-')) return { tier: 2, reason: `flag '${arg}' is not allowlisted` };
      const resolved = path.resolve(base, arg);
      if (!this.isInsideWorkspace(resolved)) return { tier: 2, reason: 'path is outside the workspace' };
      const real = realpathOrResolved(resolved);
      const segments = path.relative(this.workspaceRoot, real).split(/[\\/]/);
      if (segments.includes('.git') || SECRET_FILE_PATTERN.test(path.basename(real))) {
        return { tier: 2, reason: 'path looks like a secret or repository internals' };
      }
      targets.push(real);
    }
    return { tier: 1, reason: 'file read inside workspace', plan: { kind: 'builtin', name: 'cat', targets } };
  }

  private async runPlan(plan: HostPlan, cwd: string, timeoutMs: number, start: number): Promise<HostCommandResult> {
    if (plan.kind === 'process') {
      const result = await this.runProcess(plan.file, plan.args, {
        cwd,
        timeoutMs,
        maxOutputBytes: this.maxOutputBytes,
        shell: plan.shell === true,
      });
      return this.toResult(result, start);
    }

    try {
      let output = '';
      switch (plan.name) {
        case 'echo':
          output = plan.args.join(' ');
          break;
        case 'pwd':
          output = cwd;
          break;
        case 'whoami':
          output = os.userInfo().username;
          break;
        case 'hostname':
          output = os.hostname();
          break;
        case 'ls':
          output = this.listDirectory(plan.target, plan.showHidden);
          break;
        case 'cat':
          output = plan.targets.map((target) => this.readFileCapped(target)).join('\n');
          break;
      }
      const capped = capText(output, this.maxOutputBytes);
      return { exitCode: 0, stdout: capped.text.trim(), stderr: '', executionTimeMs: Date.now() - start, truncated: capped.truncated || undefined };
    } catch (err: unknown) {
      return { exitCode: 1, stdout: '', stderr: err instanceof Error ? err.message : String(err), executionTimeMs: Date.now() - start };
    }
  }

  private listDirectory(target: string, showHidden: boolean): string {
    if (!fs.statSync(target).isDirectory()) return path.basename(target);
    return fs
      .readdirSync(target, { withFileTypes: true })
      .filter((entry) => showHidden || !entry.name.startsWith('.'))
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort()
      .join('\n');
  }

  private readFileCapped(target: string): string {
    const fd = fs.openSync(target, 'r');
    try {
      const buffer = Buffer.alloc(this.maxOutputBytes + 1);
      const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
      return buffer.subarray(0, read).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  }

  private toResult(result: ProcessRunResult, start: number): HostCommandResult {
    const stdout = capText(result.stdout, this.maxOutputBytes);
    const stderr = capText(result.stderr, this.maxOutputBytes);
    return {
      exitCode: result.exitCode,
      stdout: stdout.text.trim(),
      stderr: stderr.text.trim(),
      executionTimeMs: Date.now() - start,
      timedOut: result.timedOut || undefined,
      truncated: result.truncated || stdout.truncated || stderr.truncated || undefined,
    };
  }
}
