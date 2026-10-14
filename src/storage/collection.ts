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

const FILTER_KEY_PATTERN = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/;

/** `insertUnique` found a document with the same `id`. */
export class DuplicateIdError extends Error {
  constructor(
    public readonly collection: string,
    public readonly docId: string
  ) {
    super(`Document ${docId} already exists in ${collection}`);
    this.name = 'DuplicateIdError';
  }
}

/** A mutating call whose filter has no usable criterion; running it would touch every document. */
export class EmptyFilterError extends Error {
  constructor(operation: string) {
    super(`${operation}() needs at least one defined filter value; use deleteAll() to empty a collection on purpose`);
    this.name = 'EmptyFilterError';
  }
}

function bindFilterValue(key: string, value: unknown): string | number | bigint {
  if (typeof value === 'string' || typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`Filter value for "${key}" must be a finite number`);
    return value;
  }
  // `json_extract` yields 1/0 for JSON true/false, and `node:sqlite` rejects booleans as bind parameters.
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  throw new TypeError(`Unsupported filter value type for "${key}": ${typeof value}`);
}

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

  private buildWhereClause(filter?: FilterQuery<T>): { sql: string; params: Array<string | number | bigint>; criteria: number } {
    const clauses: string[] = [];
    const params: Array<string | number | bigint> = [];

    for (const [key, value] of Object.entries(filter ?? {})) {
      if (!FILTER_KEY_PATTERN.test(key)) {
        throw new Error(`Invalid filter key: ${JSON.stringify(key)}`);
      }
      if (value === undefined) continue;
      if (value === null) {
        clauses.push(`json_extract(doc, '$.${key}') IS NULL`);
        continue;
      }
      clauses.push(`json_extract(doc, '$.${key}') = ?`);
      params.push(bindFilterValue(key, value));
    }

    return { sql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params, criteria: clauses.length };
  }

  /** Builds a filter for a call that must target something: an empty or all-undefined filter throws. */
  private buildTargetedWhere(operation: string, filter: FilterQuery<T>): { sql: string; params: Array<string | number | bigint> } {
    const where = this.buildWhereClause(filter);
    if (where.criteria === 0) {
      throw new EmptyFilterError(operation);
    }
    return where;
  }

  /**
   * Inserts the document, or replaces the stored one when `doc.id` already exists (the original
   * `created_at` and position are kept). Callers that must not overwrite use `insertUnique()`; callers
   * that mean to replace and want to know which happened use `upsertOne()`.
   */
  public insertOne(doc: T): T {
    return this.upsertOne(doc).doc;
  }

  /** Inserts the document; throws `DuplicateIdError` when `doc.id` already exists. */
  public insertUnique(doc: T): T {
    const id = doc.id ? String(doc.id) : crypto.randomUUID();
    const docWithId = { ...doc, id };
    try {
      this.db
        .prepare(`INSERT INTO ${this.tableName} (id, doc, created_at) VALUES (?, ?, ?)`)
        .run(id, JSON.stringify(docWithId), new Date().toISOString());
    } catch (err: unknown) {
      if (this.findById(id)) {
        throw new DuplicateIdError(this.tableName, id);
      }
      throw err;
    }
    return docWithId as T;
  }

  /** Replaces the document with the same `id`, or inserts it; `created` says which. */
  public upsertOne(doc: T): { doc: T; created: boolean } {
    const id = doc.id ? String(doc.id) : crypto.randomUUID();
    const docWithId = { ...doc, id };
    const created = !this.findById(id);
    this.db
      .prepare(
        `INSERT INTO ${this.tableName} (id, doc, created_at) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET doc = excluded.doc`
      )
      .run(id, JSON.stringify(docWithId), new Date().toISOString());
    return { doc: docWithId as T, created };
  }

  private findById(id: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 AS present FROM ${this.tableName} WHERE id = ?`).get(id));
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
    const { sql, params, criteria } = this.buildWhereClause(filter);
    if (criteria === 0 && Object.keys(filter ?? {}).length > 0) {
      // Every value was undefined (e.g. `{ id: undefined }`): returning "the first document" would be arbitrary.
      throw new EmptyFilterError('findOne');
    }
    const stmt = this.db.prepare(`
      SELECT doc FROM ${this.tableName} ${sql} ORDER BY created_at ASC, rowid ASC LIMIT 1
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
      SELECT doc FROM ${this.tableName} ${sql} ORDER BY created_at ASC, rowid ASC
    `);

    const rows = stmt.all(...params) as any[];
    return rows.map((r) => JSON.parse(r.doc) as T);
  }

  /**
   * MongoDB-style updateOne()
   */
  public updateOne(filter: FilterQuery<T>, update: Partial<T>): boolean {
    this.buildTargetedWhere('updateOne', filter);
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
    this.buildTargetedWhere('updateMany', filter);
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
    this.buildTargetedWhere('deleteOne', filter);
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

  /** Deletes every document matching `filter`; an empty or all-undefined filter throws `EmptyFilterError`. */
  public deleteMany(filter: FilterQuery<T>): number {
    const { sql, params } = this.buildTargetedWhere('deleteMany', filter);
    const result = this.db.prepare(`DELETE FROM ${this.tableName} ${sql}`).run(...params);
    return Number(result.changes);
  }

  /** Deletes every document in the collection. The only way to do so. */
  public deleteAll(): number {
    return Number(this.db.prepare(`DELETE FROM ${this.tableName}`).run().changes);
  }

  /** The largest numeric value of a top-level or dotted `field`, or null when no document has one. */
  public max(field: string, filter?: FilterQuery<T>): number | null {
    if (!FILTER_KEY_PATTERN.test(field)) {
      throw new Error(`Invalid field: ${JSON.stringify(field)}`);
    }
    const { sql, params } = this.buildWhereClause(filter);
    const row = this.db
      .prepare(`SELECT max(json_extract(doc, '$.${field}')) AS top FROM ${this.tableName} ${sql}`)
      .get(...params) as { top: number | null } | undefined;
    return typeof row?.top === 'number' ? row.top : null;
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
  private transactionDepth = 0;

  constructor(dbPath: string = ':memory:') {
    if (dbPath !== ':memory:') {
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
    this.db = new DatabaseSync(dbPath);
    if (dbPath !== ':memory:') {
      // WAL lets the web server and the Telegram bot write the same file without readers blocking writers;
      // `busy_timeout` makes a competing writer wait instead of failing at once with SQLITE_BUSY.
      this.db.exec('PRAGMA busy_timeout = 5000');
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA synchronous = NORMAL');
    }
  }

  public collection<T extends { id?: string | number }>(name: string): Collection<T> {
    return new Collection<T>(this.db, name);
  }

  public getCollection<T extends { id?: string | number }>(name: string): Collection<T> {
    return this.collection<T>(name);
  }

  /**
   * Runs `fn` in one SQLite transaction: committed if it returns, rolled back if it throws. `fn` must be
   * synchronous: `COMMIT` would otherwise run before an async callback's writes, so a returned promise is
   * rolled back and rejected. `BEGIN IMMEDIATE` takes the write lock up front, so two processes cannot
   * deadlock upgrading read locks. A nested call joins the outer transaction.
   */
  public transaction<R>(fn: () => R): R {
    if (this.transactionDepth > 0) {
      return fn();
    }
    this.db.exec('BEGIN IMMEDIATE');
    this.transactionDepth++;
    try {
      const result = fn();
      if (result instanceof Promise) {
        throw new TypeError('DocumentStore.transaction() callback must be synchronous');
      }
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    } finally {
      this.transactionDepth--;
    }
  }

  public close(): void {
    this.db.close();
  }
}
