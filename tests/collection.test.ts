/**
 * Unit Tests: MongoDB-Style Document Store over SQLite
 * Authority: CODING_RULES.md (TDD), Section 18.1 (Tech Stack)
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DocumentStore, DuplicateIdError, EmptyFilterError } from '../src/storage/collection.js';

interface TestUser {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'user';
  meta?: {
    tags: string[];
    score: number;
  };
}

describe('DocumentStore & MongoDB-Style Collection', () => {
  let store: DocumentStore;

  beforeEach(() => {
    store = new DocumentStore(':memory:');
  });

  test('should insert and find documents like MongoDB findOne() and find()', () => {
    const users = store.collection<TestUser>('users');

    users.insertOne({
      id: 'u1',
      name: 'Avinav',
      email: 'aery1803@gmail.com',
      role: 'admin',
      meta: { tags: ['dev', 'owner'], score: 100 },
    });

    users.insertOne({
      id: 'u2',
      name: 'Alice',
      email: 'alice@example.com',
      role: 'user',
      meta: { tags: ['qa'], score: 85 },
    });

    // MongoDB-style findOne()
    const foundAdmin = users.findOne({ role: 'admin' });
    assert.ok(foundAdmin);
    assert.equal(foundAdmin.name, 'Avinav');
    assert.equal(foundAdmin.meta?.score, 100);

    // MongoDB-style find()
    const allUsers = users.find();
    assert.equal(allUsers.length, 2);

    const userRoleOnly = users.find({ role: 'user' });
    assert.equal(userRoleOnly.length, 1);
    assert.equal(userRoleOnly[0].name, 'Alice');
  });

  test('should update documents like MongoDB updateOne() and updateMany()', () => {
    const users = store.collection<TestUser>('users');

    users.insertOne({
      id: 'u1',
      name: 'Bob',
      email: 'bob@example.com',
      role: 'user',
    });

    // MongoDB-style updateOne()
    const updated = users.updateOne(
      { email: 'bob@example.com' },
      { role: 'admin' }
    );
    assert.equal(updated, true);

    const checkBob = users.findOne({ id: 'u1' });
    assert.equal(checkBob?.role, 'admin');
  });

  test('should delete documents like MongoDB deleteOne() and deleteMany()', () => {
    const users = store.collection<TestUser>('users');

    users.insertOne({ id: 'u1', name: 'User1', email: '1@ex.com', role: 'user' });
    users.insertOne({ id: 'u2', name: 'User2', email: '2@ex.com', role: 'user' });
    users.insertOne({ id: 'u3', name: 'Admin', email: 'admin@ex.com', role: 'admin' });

    assert.equal(users.count(), 3);

    // MongoDB-style deleteOne()
    const deletedOne = users.deleteOne({ id: 'u1' });
    assert.equal(deletedOne, true);
    assert.equal(users.count(), 2);

    // MongoDB-style deleteMany()
    const deletedMany = users.deleteMany({ role: 'user' });
    assert.equal(deletedMany, 1);
    assert.equal(users.count(), 1);
    assert.equal(users.findOne({ role: 'admin' })?.name, 'Admin');
  });

  test('should support nested JSON structures and arrays seamlessly', () => {
    interface ResearchItem {
      id: string;
      topic: string;
      findings: string[];
      confidence: number;
    }

    const research = store.collection<ResearchItem>('research');

    research.insertOne({
      id: 'r1',
      topic: 'Vulkan UMA Memory',
      findings: ['54GB VRAM available', '41 t/s on 7B model'],
      confidence: 0.95,
    });

    const item = research.findOne({ id: 'r1' });
    assert.ok(item);
    assert.equal(item.findings.length, 2);
    assert.equal(item.findings[0], '54GB VRAM available');
    assert.equal(item.confidence, 0.95);
  });

  test('transaction() commits every write when the callback returns', () => {
    const users = store.collection<TestUser>('users');

    const result = store.transaction(() => {
      users.insertOne({ id: 't1', name: 'One', email: 'one@example.test', role: 'user' });
      users.insertOne({ id: 't2', name: 'Two', email: 'two@example.test', role: 'user' });
      return 'done';
    });

    assert.equal(result, 'done');
    assert.equal(users.count(), 2);
  });

  test('transaction() rolls back every write when the callback throws', () => {
    const users = store.collection<TestUser>('users');
    users.insertOne({ id: 'kept', name: 'Kept', email: 'kept@example.test', role: 'admin' });

    assert.throws(
      () =>
        store.transaction(() => {
          users.insertOne({ id: 't3', name: 'Three', email: 'three@example.test', role: 'user' });
          users.updateOne({ id: 'kept' }, { role: 'user' });
          throw new Error('boom');
        }),
      /boom/
    );

    assert.equal(users.count(), 1);
    assert.equal(users.findOne({ id: 'kept' })?.role, 'admin');
  });

  test('transaction() rejects an async callback instead of committing before it finishes', () => {
    const users = store.collection<TestUser>('users');

    assert.throws(
      () =>
        store.transaction(() => {
          users.insertOne({ id: 't4', name: 'Four', email: 'four@example.test', role: 'user' });
          return Promise.resolve();
        }),
      TypeError
    );

    assert.equal(users.count(), 0);
  });
});

describe('Collection safety and semantics', () => {
  interface Item {
    id?: string;
    name: string;
    flag?: boolean;
    note?: string | null;
    count?: number;
    nested?: { a: number };
  }
  let store: DocumentStore;

  beforeEach(() => {
    store = new DocumentStore(':memory:');
  });

  test('rejects filter keys that could break out of the JSON path literal', () => {
    const items = store.collection<Item>('items');
    items.insertOne({ id: 'i1', name: 'one' });
    assert.throws(() => items.find({ "name') OR 1=1 --": 'x' } as never), /Invalid filter key/);
    assert.throws(() => items.findOne({ 'a b': 1 } as never), /Invalid filter key/);
    assert.throws(() => items.count({ '': 1 } as never), /Invalid filter key/);
    assert.equal(items.find({ 'nested.a': undefined } as never).length, 1);
  });

  test('allows dotted keys for nested fields', () => {
    const items = store.collection<Item>('items');
    items.insertOne({ id: 'i1', name: 'one', nested: { a: 5 } });
    items.insertOne({ id: 'i2', name: 'two', nested: { a: 6 } });
    assert.equal(items.findOne({ 'nested.a': 6 } as never)?.name, 'two');
  });

  test('matches boolean filter values', () => {
    const items = store.collection<Item>('items');
    items.insertOne({ id: 'on', name: 'on', flag: true });
    items.insertOne({ id: 'off', name: 'off', flag: false });
    assert.deepEqual(items.find({ flag: true }).map((i) => i.id), ['on']);
    assert.deepEqual(items.find({ flag: false }).map((i) => i.id), ['off']);
  });

  test('matches null as IS NULL, including missing fields', () => {
    const items = store.collection<Item>('items');
    items.insertOne({ id: 'nul', name: 'a', note: null });
    items.insertOne({ id: 'val', name: 'b', note: 'x' });
    items.insertOne({ id: 'missing', name: 'c' });
    assert.deepEqual(items.find({ note: null }).map((i) => i.id), ['nul', 'missing']);
    assert.equal(items.count({ note: 'x' }), 1);
  });

  test('deleteMany with an empty or all-undefined filter throws instead of wiping the collection', () => {
    const items = store.collection<Item>('items');
    items.insertOne({ id: 'i1', name: 'one' });
    items.insertOne({ id: 'i2', name: 'two' });
    assert.throws(() => items.deleteMany({}), EmptyFilterError);
    assert.throws(() => items.deleteMany({ name: undefined }), EmptyFilterError);
    assert.equal(items.count(), 2);
  });

  test('updateOne, deleteOne and findOne refuse an all-undefined filter instead of picking an arbitrary document', () => {
    const items = store.collection<Item>('items');
    items.insertOne({ id: 'i1', name: 'one' });
    assert.throws(() => items.updateOne({ id: undefined }, { name: 'x' }), EmptyFilterError);
    assert.throws(() => items.deleteOne({ id: undefined }), EmptyFilterError);
    assert.throws(() => items.findOne({ id: undefined }), EmptyFilterError);
    assert.equal(items.findOne({})?.id, 'i1');
    assert.equal(items.findOne({ id: 'i1' })?.name, 'one');
  });

  test('deleteAll empties the collection on purpose and reports how many', () => {
    const items = store.collection<Item>('items');
    items.insertOne({ id: 'i1', name: 'one' });
    items.insertOne({ id: 'i2', name: 'two' });
    assert.equal(items.deleteAll(), 2);
    assert.equal(items.count(), 0);
  });

  test('deleteMany returns the number of rows it removed', () => {
    const items = store.collection<Item>('items');
    items.insertMany([
      { id: 'a', name: 'x' },
      { id: 'b', name: 'x' },
      { id: 'c', name: 'y' },
    ]);
    assert.equal(items.deleteMany({ name: 'x' }), 2);
    assert.equal(items.deleteMany({ name: 'x' }), 0);
  });

  test('insertUnique refuses an existing id while insertOne and upsertOne replace it', () => {
    const items = store.collection<Item>('items');
    items.insertUnique({ id: 'k', name: 'first' });
    assert.throws(() => items.insertUnique({ id: 'k', name: 'second' }), DuplicateIdError);
    assert.equal(items.findOne({ id: 'k' })?.name, 'first');

    const replaced = items.upsertOne({ id: 'k', name: 'third' });
    assert.equal(replaced.created, false);
    assert.equal(items.findOne({ id: 'k' })?.name, 'third');
    assert.equal(items.upsertOne({ id: 'new', name: 'n' }).created, true);

    items.insertOne({ id: 'k', name: 'fourth' });
    assert.equal(items.findOne({ id: 'k' })?.name, 'fourth');
    assert.equal(items.count(), 2);
  });

  test('replacing a document keeps its position in find() order', () => {
    const items = store.collection<Item>('items');
    items.insertOne({ id: 'a', name: 'a' });
    items.insertOne({ id: 'b', name: 'b' });
    items.insertOne({ id: 'a', name: 'a2' });
    assert.deepEqual(items.find().map((i) => i.name), ['a2', 'b']);
  });

  test('find() returns same-millisecond inserts in insertion order', () => {
    const items = store.collection<Item>('items');
    const ids = Array.from({ length: 50 }, (_, i) => `id-${String(49 - i).padStart(2, '0')}`);
    for (const id of ids) items.insertOne({ id, name: id });
    assert.deepEqual(items.find().map((i) => i.id), ids);
  });

  test('max() returns the largest numeric field value, or null', () => {
    const items = store.collection<Item>('items');
    assert.equal(items.max('count'), null);
    items.insertMany([
      { id: 'a', name: 'x', count: 3 },
      { id: 'b', name: 'x', count: 11 },
      { id: 'c', name: 'y', count: 7 },
    ]);
    assert.equal(items.max('count'), 11);
    assert.equal(items.max('count', { name: 'y' }), 7);
    assert.throws(() => items.max("count'); DROP TABLE x;--"), /Invalid field/);
  });

  test('a nested transaction joins the outer one and rolls back with it', () => {
    const items = store.collection<Item>('items');
    assert.throws(() =>
      store.transaction(() => {
        store.transaction(() => items.insertOne({ id: 'inner', name: 'inner' }));
        throw new Error('outer fails');
      })
    );
    assert.equal(items.count(), 0);
    store.transaction(() => store.transaction(() => items.insertOne({ id: 'ok', name: 'ok' })));
    assert.equal(items.count(), 1);
  });

  test('file databases use WAL with a busy timeout so two writers do not collide', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-wal-'));
    const dbPath = path.join(dir, 'wal.db');
    const first = new DocumentStore(dbPath);
    const second = new DocumentStore(dbPath);
    try {
      const probe = new DatabaseSync(dbPath);
      const mode = probe.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
      probe.close();
      assert.equal(mode.journal_mode, 'wal');

      const a = first.collection<Item>('shared');
      const b = second.collection<Item>('shared');
      a.insertOne({ id: 'from-a', name: 'a' });
      b.insertOne({ id: 'from-b', name: 'b' });
      assert.equal(a.count(), 2);
      assert.equal(b.count(), 2);
    } finally {
      first.close();
      second.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
