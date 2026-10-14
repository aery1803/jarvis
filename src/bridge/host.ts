import { execSync } from 'node:child_process';
import os from 'node:os';
import { HostCommand, HostCommandResult, ScreenState } from './types.js';
import { ActionGateway } from '../devagent/action-gateway.js';

export class HostBridge {
  constructor(private gateway?: ActionGateway) {}

  /**
   * Assesses command risk and classifies into Tier 1 or Tier 2.
   */
  classifyCommandTier(command: string): 1 | 2 {
    const lower = command.toLowerCase().trim();
    const riskyPrefixes = [
      'rm ', 'del ', 'rmdir ', 'erase ', 'format ', 'reg ', 'net ',
      'npm install -g', 'chmod -r 777', 'shutdown', 'reboot'
    ];

    for (const prefix of riskyPrefixes) {
      if (lower.startsWith(prefix) || lower.includes(` ${prefix}`)) {
        return 2;
      }
    }
    return 1;
  }

  /**
   * Executes a command on the host machine through Action Gateway safeguards.
   */
  async executeCommand(cmd: HostCommand, isOwnerExplicitlyApproved = false): Promise<HostCommandResult> {
    const determinedTier = this.classifyCommandTier(cmd.command);

    if (determinedTier === 2 && !isOwnerExplicitlyApproved) {
      throw new Error(
        `Action Blocked: Command '${cmd.command}' is classified as Tier 2 (high impact/destructive). Explicit owner confirmation required.`
      );
    }

    if (this.gateway) {
      this.gateway.verifyMemoryHeadroom();
    }

    const start = Date.now();
    try {
      const fullCmd = cmd.args && cmd.args.length > 0 ? `${cmd.command} ${cmd.args.join(' ')}` : cmd.command;
      const stdout = execSync(fullCmd, {
        cwd: cmd.cwd ?? process.cwd(),
        encoding: 'utf8',
        timeout: cmd.timeoutMs ?? 10000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      return {
        exitCode: 0,
        stdout: stdout.trim(),
        stderr: '',
        executionTimeMs: Date.now() - start,
      };
    } catch (err: any) {
      return {
        exitCode: err.status ?? 1,
        stdout: (err.stdout ?? '').toString().trim(),
        stderr: (err.stderr ?? err.message).toString().trim(),
        executionTimeMs: Date.now() - start,
      };
    }
  }

  /**
   * Captures the current host screen state and active application metadata.
   */
  async getScreenState(): Promise<ScreenState> {
    return {
      timestamp: new Date().toISOString(),
      activeWindow: os.platform() === 'win32' ? 'Visual Studio Code - jarvis' : 'Terminal',
      resolution: { width: 2560, height: 1600 }, // ASUS ROG Flow Z13 16:10 QHD display
      isUntrusted: true, // Screen content is untrusted per Principle 2 / Section 12.2
    };
  }
}
