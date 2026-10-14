/**
 * Jarvis Local AI Agent: GitHub Board Watcher & Directive Parser
 * Authority: Section 17.10 (Automation mechanism and security)
 */

import type { OwnActionRegistry } from './action-registry.js';
import type { ActionGateway } from './action-gateway.js';
import type { ProjectBoardItem, TicketDirective, ProjectColumn, TicketType } from './types.js';
import { runCommand } from './command-runner.js';
import type { CommandRunner } from './command-runner.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';

export function parseDirective(commentBody: string, author: string, commentId: string): TicketDirective {
  const trimmed = commentBody.trim();
  const match = trimmed.match(/^\/jarvis(?:\s+([a-zA-Z0-9_-]+))?(.*)$/i);

  if (!match) {
    return {
      isDirective: false,
      rawComment: commentBody,
      author,
      commentId,
    };
  }

  const command = match[1] ? match[1].toLowerCase() : 'help';
  const rawArgs = match[2] ? match[2].trim().split(/\s+/).filter(Boolean) : [];

  return {
    isDirective: true,
    command,
    args: rawArgs,
    rawComment: commentBody,
    author,
    commentId,
  };
}

export interface BoardWatcherDeps {
  registry: OwnActionRegistry;
  gateway: ActionGateway;
  projectNumber?: number;
  repoOwner?: string;
  run?: CommandRunner;
}

const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export class BoardWatcher {
  private registry: OwnActionRegistry;
  private gateway: ActionGateway;
  private projectNumber: number;
  private repoOwner: string;
  private run: CommandRunner;

  constructor(deps: BoardWatcherDeps) {
    this.registry = deps.registry;
    this.gateway = deps.gateway;
    this.projectNumber = deps.projectNumber ?? config.projectNumber;
    this.repoOwner = deps.repoOwner ?? config.repoOwner;
    this.run = deps.run ?? runCommand;
  }

  /**
   * Checks if a comment was authored by the AI agent itself.
   */
  public isAiGeneratedComment(commentBody: string, commentId?: string): boolean {
    return this.registry.isOwnComment(commentBody, commentId);
  }

  /**
   * Transforms raw gh project item-list JSON output into ProjectBoardItem list.
   */
  public parseProjectItems(raw: any): ProjectBoardItem[] {
    if (!raw || !Array.isArray(raw.items)) {
      return [];
    }

    return raw.items
      .map((item: any) => {
        const content = item.content ?? {};
        const labels = Array.isArray(item.labels) ? item.labels : [];
        return {
          itemId: item.id,
          issueNumber: content.number ?? 0,
          title: item.title ?? content.title ?? '',
          body: content.body ?? '',
          status: (item.status as ProjectColumn) ?? 'Concept',
          ticketType: (item.ticketType as TicketType) ?? undefined,
          labels,
          url: content.url ?? item.repository ?? '',
        };
      })
      .filter((item: ProjectBoardItem) => item.issueNumber > 0);
  }

  /**
   * Polls the GitHub Project Board using the gh CLI. A read, recorded as BOARD_POLL so it never looks like a card mutation.
   */
  public async pollBoard(): Promise<ProjectBoardItem[]> {
    if (!Number.isInteger(this.projectNumber) || this.projectNumber <= 0) {
      throw new Error(`Invalid project number: ${String(this.projectNumber)}`);
    }
    if (!GITHUB_OWNER.test(this.repoOwner)) {
      throw new Error(`Invalid repository owner: '${this.repoOwner}'`);
    }

    return this.gateway.executeAction(
      {
        tier: 1,
        actionType: 'BOARD_POLL',
        targetId: `board-${this.projectNumber}`,
        description: `Poll Project Board #${this.projectNumber}`,
      },
      async () => {
        try {
          const { stdout } = await this.run(
            'gh',
            ['project', 'item-list', String(this.projectNumber), '--owner', this.repoOwner, '--format', 'json'],
            { timeoutMs: 15_000 }
          );
          const raw = JSON.parse(stdout);
          const items = this.parseProjectItems(raw);
          logger.info(`[BoardWatcher] Successfully polled ${items.length} items from Board #${this.projectNumber}`);
          return items;
        } catch (err: any) {
          logger.error(`[BoardWatcher] Failed to poll project board: ${err.message}`);
          throw err;
        }
      }
    );
  }
}
