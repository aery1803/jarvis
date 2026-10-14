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
import type { ActionStatus, OwnActionRecord } from './types.js';

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

    // Databases created before status tracking lack these columns; `CREATE TABLE IF NOT EXISTS` leaves them as-is.
    const columns = (this.db.prepare(`PRAGMA table_info(own_actions)`).all() as Array<{ name: string }>).map((c) => c.name);
    if (!columns.includes('status')) {
      this.db.exec(`ALTER TABLE own_actions ADD COLUMN status TEXT`);
    }
    if (!columns.includes('outcome')) {
      this.db.exec(`ALTER TABLE own_actions ADD COLUMN outcome TEXT`);
    }
  }

  /**
   * Records an agent-initiated action into SQLite.
   */
  public recordAction(action: OwnActionRecord): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO own_actions (id, action_type, target_id, signature, created_at, metadata, status, outcome)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      action.id,
      action.actionType,
      action.targetId,
      action.signature ?? null,
      action.createdAt,
      action.metadata ?? null,
      action.status ?? null,
      action.outcome ?? null
    );
  }

  /**
   * Updates the status/outcome of an already-recorded action. Returns false when the id is unknown.
   */
  public updateAction(id: string, update: { status: ActionStatus; outcome?: string }): boolean {
    const result = this.db
      .prepare(`UPDATE own_actions SET status = ?, outcome = ? WHERE id = ?`)
      .run(update.status, update.outcome ?? null, id);
    return Number(result.changes) > 0;
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
   * 1. Embedded invisible marker: <!-- jarvis-devagent:action-id:<id> --> whose id is recorded
   * 2. Direct comment ID lookup in the own_actions table.
   */
  public isOwnComment(commentBody: string, commentId?: string): boolean {
    if (commentId && this.isOwnAction(commentId)) {
      return true;
    }

    // A marker only counts when its id was minted by the gateway: anyone can type the marker text into a comment.
    const match = commentBody.match(AI_COMMENT_MARKER_REGEX);
    return Boolean(match && match[1] && this.isOwnAction(match[1]));
  }

  /**
   * Retrieves all recorded actions ordered by creation time.
   */
  public getAllActions(): OwnActionRecord[] {
    const stmt = this.db.prepare(`
      SELECT id, action_type as actionType, target_id as targetId, signature, created_at as createdAt, metadata, status, outcome
      FROM own_actions
      ORDER BY created_at ASC, rowid ASC
    `);

    const rows = stmt.all() as any[];
    return rows.map((r) => ({
      id: r.id,
      actionType: r.actionType,
      targetId: r.targetId,
      signature: r.signature ?? undefined,
      createdAt: r.createdAt,
      metadata: r.metadata ?? undefined,
      status: r.status ?? undefined,
      outcome: r.outcome ?? undefined,
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
