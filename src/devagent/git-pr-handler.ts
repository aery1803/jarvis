/**
 * Jarvis Local AI Agent: Git & PR Handler
 * Authority: Section 17.8 (Branching, merging, and release), CODING_RULES.md
 */

import { execSync } from 'node:child_process';
import type { ActionGateway } from './action-gateway.js';
import { logger } from '../utils/logger.js';

export interface CreatePROptions {
  title: string;
  body: string;
  baseBranch?: string;
  headBranch: string;
}

export class GitPRHandler {
  private gateway: ActionGateway;

  constructor(gateway: ActionGateway) {
    this.gateway = gateway;
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

    await this.gateway.executeAction(
      {
        tier: 1,
        actionType: 'BRANCH_CREATE',
        targetId: branchName,
        description: `Create branch ${branchName} from ${baseBranch}`,
      },
      async () => {
        execSync(`git checkout -b ${branchName} ${baseBranch}`, { encoding: 'utf-8' });
        logger.info(`[GitPRHandler] Created branch '${branchName}' from '${baseBranch}'`);
      }
    );
  }

  /**
   * Opens a Pull Request using the gh CLI with the ai-authored label.
   */
  public async openPullRequest(options: CreatePROptions): Promise<{ prNumber: number; url: string }> {
    const base = options.baseBranch ?? 'main';

    return this.gateway.executeAction(
      {
        tier: 1,
        actionType: 'PR_CREATE',
        targetId: options.headBranch,
        description: `Open Pull Request: ${options.title}`,
        metadata: { baseBranch: base, headBranch: options.headBranch },
      },
      async () => {
        // Enforce ai-authored label
        const cmd = `gh pr create --base ${base} --head ${options.headBranch} --title "${options.title.replace(/"/g, '\\"')}" --body "${options.body.replace(/"/g, '\\"')}" --label "ai-authored"`;
        const stdout = execSync(cmd, { encoding: 'utf-8' });
        const url = stdout.trim();
        const prNumberMatch = url.match(/\/pull\/(\d+)/);
        const prNumber = prNumberMatch ? Number.parseInt(prNumberMatch[1], 10) : 0;

        logger.info(`[GitPRHandler] Opened PR #${prNumber}: ${url}`);
        return { prNumber, url };
      }
    );
  }
}
