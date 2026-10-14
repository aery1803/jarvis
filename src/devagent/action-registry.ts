/**
 * Jarvis Local AI Agent: Own-Action Registry
 * Authority: Section 17.10 (Shared-Account Safeguards)
 *
 * Prevents loopback when the AI Dev Agent shares the owner's GitHub account (aery1803).
 * Every GitHub mutation (comment, card move, PR, commit) is logged into SQLite.
 * Comments posted by the AI carry an invisible HTML marker with the action ID.
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import type { OwnActionRecord } from './types.js';

export const AI_COMMENT_MARKER_REGEX = /<!--\s*jarvis-devagent:action-id:([a-zA-Z0-9_.-]+)\s*-->/i;

export class OwnActionRegistry {
  private db: DatabaseSync;

  constructor(dbPath: string = ':memory:') {
    if (dbPath !== ':memory:') {
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
    this.db = new DatabaseSync(dbPath);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS own_actions (
        id TEXT PRIMARY KEY,
        action_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        signature TEXT,
        created_at TEXT NOT NULL,
        metadata TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_own_actions_target ON own_actions(target_id);
    `);
  }

  /**
   * Records an agent-initiated action into SQLite.
   */
  public recordAction(action: OwnActionRecord): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO own_actions (id, action_type, target_id, signature, created_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      action.id,
      action.actionType,
      action.targetId,
      action.signature ?? null,
      action.createdAt,
      action.metadata ?? null
    );
  }

  /**
   * Checks if an action ID exists in the own-action database.
   */
  public isOwnAction(actionId: string): boolean {
    const stmt = this.db.prepare(`
      SELECT 1 FROM own_actions WHERE id = ? LIMIT 1
    `);
    const result = stmt.get(actionId);
    return result !== undefined;
  }

  /**
   * Inspects a comment to determine if it originated from the Dev Agent.
   * Checks both:
   * 1. Embedded invisible marker: <!-- jarvis-devagent:action-id:<id> -->
   * 2. Direct comment ID lookup in the own_actions table.
   */
  public isOwnComment(commentBody: string, commentId?: string): boolean {
    if (commentId && this.isOwnAction(commentId)) {
      return true;
    }

    const match = commentBody.match(AI_COMMENT_MARKER_REGEX);
    if (match && match[1]) {
      return true;
    }

    return false;
  }

  /**
   * Retrieves all recorded actions ordered by creation time.
   */
  public getAllActions(): OwnActionRecord[] {
    const stmt = this.db.prepare(`
      SELECT id, action_type as actionType, target_id as targetId, signature, created_at as createdAt, metadata
      FROM own_actions
      ORDER BY created_at ASC
    `);

    const rows = stmt.all() as any[];
    return rows.map((r) => ({
      id: r.id,
      actionType: r.actionType,
      targetId: r.targetId,
      signature: r.signature ?? undefined,
      createdAt: r.createdAt,
      metadata: r.metadata ?? undefined,
    }));
  }

  /**
   * Clears all recorded actions (primarily for testing/resets).
   */
  public clear(): void {
    this.db.exec(`DELETE FROM own_actions`);
  }

  /**
   * Closes the database connection.
   */
  public close(): void {
    this.db.close();
  }
}
