/**
 * Jarvis Local AI Agent: Git & PR Handler
 * Authority: Section 17.8 (Branching, merging, and release), CODING_RULES.md
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ActionGateway } from './action-gateway.js';
import { runCommand, isSafeRefName } from './command-runner.js';
import type { CommandRunner } from './command-runner.js';
import { logger } from '../utils/logger.js';

export interface CreatePROptions {
  title: string;
  body: string;
  baseBranch?: string;
  headBranch: string;
}

export interface GitPRHandlerDeps {
  run?: CommandRunner;
}

const MAX_TITLE_CHARS = 256;

export class GitPRHandler {
  private gateway: ActionGateway;
  private run: CommandRunner;

  constructor(gateway: ActionGateway, deps: GitPRHandlerDeps = {}) {
    this.gateway = gateway;
    this.run = deps.run ?? runCommand;
  }

  /**
   * Validates and creates a git branch for local AI development.
   * Strictly permits only 'story/' or 'feature/' prefixes.
   */
  public async createBranch(branchName: string, baseBranch: string = 'main'): Promise<void> {
    const validPrefix = branchName.startsWith('story/') || branchName.startsWith('feature/');
    if (!validPrefix) {
      throw new Error(
        `Invalid branch name: '${branchName}'. Dev Agent may only create 'story/' or 'feature/' branches.`
      );
    }

    if (branchName === 'main' || branchName === 'master') {
      throw new Error(`Forbidden branch creation: cannot target '${branchName}' directly.`);
    }
    if (!isSafeRefName(branchName)) {
      throw new Error(`Invalid branch name: '${branchName}'. Use only letters, digits, '.', '_', '-' and '/'.`);
    }
    if (!isSafeRefName(baseBranch)) {
      throw new Error(`Invalid base branch: '${baseBranch}'.`);
    }

    await this.gateway.executeAction(
      {
        tier: 1,
        actionType: 'BRANCH_CREATE',
        targetId: branchName,
        description: `Create branch ${branchName} from ${baseBranch}`,
      },
      async () => {
        await this.run('git', ['checkout', '-b', branchName, baseBranch]);
        logger.info(`[GitPRHandler] Created branch '${branchName}' from '${baseBranch}'`);
      }
    );
  }

  /**
   * Opens a Pull Request using the gh CLI with the ai-authored label.
   */
  public async openPullRequest(options: CreatePROptions): Promise<{ prNumber: number; url: string }> {
    const base = options.baseBranch ?? 'main';
    if (!isSafeRefName(options.headBranch)) {
      throw new Error(`Invalid head branch: '${options.headBranch}'.`);
    }
    if (!isSafeRefName(base)) {
      throw new Error(`Invalid base branch: '${base}'.`);
    }
    const title = options.title.replace(/[\r\n]+/g, ' ').trim().slice(0, MAX_TITLE_CHARS);
    if (!title) {
      throw new Error('Pull request title must not be empty.');
    }

    return this.gateway.executeAction(
      {
        tier: 1,
        actionType: 'PR_CREATE',
        targetId: options.headBranch,
        description: `Open Pull Request: ${title}`,
        metadata: { baseBranch: base, headBranch: options.headBranch },
      },
      async ({ marker }) => {
        // `--body-file` keeps the body out of argv, so its length and content never reach a shell or the command line limit.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-pr-'));
        const bodyFile = path.join(dir, 'body.md');
        try {
          fs.writeFileSync(bodyFile, `${options.body}\n\n${marker}\n`, { encoding: 'utf8', mode: 0o600 });
          const { stdout } = await this.run('gh', [
            'pr', 'create',
            '--base', base,
            '--head', options.headBranch,
            `--title=${title}`,
            '--body-file', bodyFile,
            '--label', 'ai-authored',
          ]);
          const url = stdout.trim();
          const prNumberMatch = url.match(/\/pull\/(\d+)/);
          const prNumber = prNumberMatch ? Number.parseInt(prNumberMatch[1], 10) : 0;

          logger.info(`[GitPRHandler] Opened PR #${prNumber}: ${url}`);
          return { prNumber, url };
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }
    );
  }
}
