/**
 * Unit Tests: MongoDB-Style Document Store over SQLite
 * Authority: CODING_RULES.md (TDD), Section 18.1 (Tech Stack)
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DocumentStore } from '../src/storage/collection.js';

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
});
