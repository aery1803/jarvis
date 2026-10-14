/**
 * Jarvis Local AI Agent: MongoDB-Style Document Collection over SQLite
 * Authority: Section 8.1, 18.1 (Embedded Document Store)
 *
 * Provides a familiar MongoDB/Mongoose-style document API (find, findOne, insertOne, updateOne, deleteMany)
 * on top of native SQLite (node:sqlite DatabaseSync) with zero background RAM daemon overhead.
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export type FilterQuery<T> = {
  [P in keyof T]?: T[P] | any;
};

export class Collection<T extends { id?: string | number }> {
  private db: DatabaseSync;
  private tableName: string;

  constructor(db: DatabaseSync, name: string) {
    this.db = db;
    // Sanitize table name
    this.tableName = `col_${name.replace(/[^a-zA-Z0-9_]/g, '_')}`;
    this.initTable();
  }

  private initTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        id TEXT PRIMARY KEY,
        doc JSON NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_${this.tableName}_created ON ${this.tableName}(created_at);
    `);
  }

  private buildWhereClause(filter?: FilterQuery<T>): { sql: string; params: any[] } {
    if (!filter || Object.keys(filter).length === 0) {
      return { sql: '', params: [] };
    }

    const clauses: string[] = [];
    const params: any[] = [];

    for (const [key, value] of Object.entries(filter)) {
      if (value !== undefined) {
        clauses.push(`json_extract(doc, '$.${key}') = ?`);
        params.push(typeof value === 'object' ? JSON.stringify(value) : value);
      }
    }

    if (clauses.length === 0) {
      return { sql: '', params: [] };
    }

    return {
      sql: `WHERE ${clauses.join(' AND ')}`,
      params,
    };
  }

  /**
   * MongoDB-style insertOne()
   */
  public insertOne(doc: T): T {
    const id = doc.id ? String(doc.id) : crypto.randomUUID();
    const docWithId = { ...doc, id };
    const createdAt = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO ${this.tableName} (id, doc, created_at)
      VALUES (?, ?, ?)
    `);

    stmt.run(id, JSON.stringify(docWithId), createdAt);
    return docWithId as T;
  }

  /**
   * MongoDB-style insertMany()
   */
  public insertMany(docs: T[]): T[] {
    return docs.map((d) => this.insertOne(d));
  }

  /**
   * MongoDB-style findOne()
   */
  public findOne(filter: FilterQuery<T>): T | null {
    const { sql, params } = this.buildWhereClause(filter);
    const stmt = this.db.prepare(`
      SELECT doc FROM ${this.tableName} ${sql} LIMIT 1
    `);

    const row = stmt.get(...params) as any;
    if (!row || !row.doc) {
      return null;
    }

    return JSON.parse(row.doc) as T;
  }

  /**
   * MongoDB-style find()
   */
  public find(filter?: FilterQuery<T>): T[] {
    const { sql, params } = this.buildWhereClause(filter);
    const stmt = this.db.prepare(`
      SELECT doc FROM ${this.tableName} ${sql} ORDER BY created_at ASC
    `);

    const rows = stmt.all(...params) as any[];
    return rows.map((r) => JSON.parse(r.doc) as T);
  }

  /**
   * MongoDB-style updateOne()
   */
  public updateOne(filter: FilterQuery<T>, update: Partial<T>): boolean {
    const existing = this.findOne(filter);
    if (!existing) {
      return false;
    }

    const merged = { ...existing, ...update };
    const id = String(existing.id);

    const stmt = this.db.prepare(`
      UPDATE ${this.tableName}
      SET doc = ?
      WHERE id = ?
    `);

    stmt.run(JSON.stringify(merged), id);
    return true;
  }

  /**
   * MongoDB-style updateMany()
   */
  public updateMany(filter: FilterQuery<T>, update: Partial<T>): number {
    const items = this.find(filter);
    let count = 0;
    for (const item of items) {
      if (this.updateOne({ id: item.id } as any, update)) {
        count++;
      }
    }
    return count;
  }

  /**
   * MongoDB-style deleteOne()
   */
  public deleteOne(filter: FilterQuery<T>): boolean {
    const item = this.findOne(filter);
    if (!item || !item.id) {
      return false;
    }

    const stmt = this.db.prepare(`
      DELETE FROM ${this.tableName} WHERE id = ?
    `);
    stmt.run(String(item.id));
    return true;
  }

  /**
   * MongoDB-style deleteMany()
   */
  public deleteMany(filter: FilterQuery<T>): number {
    const { sql, params } = this.buildWhereClause(filter);
    if (!sql) {
      const count = this.count();
      this.db.exec(`DELETE FROM ${this.tableName}`);
      return count;
    }

    const items = this.find(filter);
    const stmt = this.db.prepare(`
      DELETE FROM ${this.tableName} ${sql}
    `);
    stmt.run(...params);
    return items.length;
  }

  /**
   * MongoDB-style count()
   */
  public count(filter?: FilterQuery<T>): number {
    const { sql, params } = this.buildWhereClause(filter);
    const stmt = this.db.prepare(`
      SELECT count(*) as total FROM ${this.tableName} ${sql}
    `);
    const row = stmt.get(...params) as any;
    return row?.total ?? 0;
  }
}

export class DocumentStore {
  private db: DatabaseSync;

  constructor(dbPath: string = ':memory:') {
    if (dbPath !== ':memory:') {
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
    this.db = new DatabaseSync(dbPath);
  }

  public collection<T extends { id?: string | number }>(name: string): Collection<T> {
    return new Collection<T>(this.db, name);
  }

  public close(): void {
    this.db.close();
  }
}
