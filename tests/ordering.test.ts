/**
 * Unit Tests: Stable Recency Ordering
 * Authority: Section 8.1 (memory tiers), Section 6.2 (audit log), CODING_RULES.md Section 2
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { newestFirst, newestByCreatedAt } from '../src/utils/ordering.js';

describe('newestFirst', () => {
  test('orders distinct timestamps newest first', () => {
    const items = [
      { id: 'old', at: '2026-10-15T10:00:00.000Z' },
      { id: 'new', at: '2026-10-15T12:00:00.000Z' },
      { id: 'mid', at: '2026-10-15T11:00:00.000Z' },
    ];
    assert.deepEqual(newestFirst(items, (i) => i.at).map((i) => i.id), ['new', 'mid', 'old']);
  });

  test('breaks a same-millisecond tie by insertion order, latest insert first', () => {
    const sameMs = '2026-10-15T10:00:00.000Z';
    const items = [
      { id: 'first', at: sameMs },
      { id: 'second', at: sameMs },
      { id: 'third', at: sameMs },
    ];
    assert.deepEqual(newestFirst(items, (i) => i.at).map((i) => i.id), ['third', 'second', 'first']);
  });

  test('a later insert in the same millisecond outranks an earlier one, which is the kill-switch case', () => {
    const sameMs = '2026-10-15T10:00:00.000Z';
    const log = [
      { event: 'KILL_SWITCH_TRIGGERED', timestamp: sameMs },
      { event: 'KILL_SWITCH_RESET', timestamp: sameMs },
    ];
    assert.equal(newestFirst(log, (e) => e.timestamp)[0].event, 'KILL_SWITCH_RESET');
  });

  test('mixes tied and untied entries correctly', () => {
    const items = [
      { id: 'a', at: '2026-10-15T10:00:00.000Z' },
      { id: 'b', at: '2026-10-15T10:00:00.000Z' },
      { id: 'c', at: '2026-10-15T09:00:00.000Z' },
      { id: 'd', at: '2026-10-15T11:00:00.000Z' },
    ];
    assert.deepEqual(newestFirst(items, (i) => i.at).map((i) => i.id), ['d', 'b', 'a', 'c']);
  });

  test('does not mutate the input array', () => {
    const items = [
      { id: 'x', at: '2026-10-15T10:00:00.000Z' },
      { id: 'y', at: '2026-10-15T12:00:00.000Z' },
    ];
    const snapshot = items.map((i) => i.id);
    newestFirst(items, (i) => i.at);
    assert.deepEqual(items.map((i) => i.id), snapshot);
  });

  test('handles empty and single-element input', () => {
    assert.deepEqual(newestFirst([], (i: { at: string }) => i.at), []);
    const one = [{ id: 'only', at: '2026-10-15T10:00:00.000Z' }];
    assert.deepEqual(newestFirst(one, (i) => i.at).map((i) => i.id), ['only']);
  });

  test('keeps unparseable timestamps last rather than throwing', () => {
    const items = [
      { id: 'bad', at: 'not-a-date' },
      { id: 'good', at: '2026-10-15T10:00:00.000Z' },
    ];
    const ordered = newestFirst(items, (i) => i.at);
    assert.equal(ordered[0].id, 'good', 'a parseable timestamp must outrank NaN');
  });

  test('newestByCreatedAt is newestFirst over the createdAt field', () => {
    const items = [
      { id: 'older', createdAt: '2026-10-15T10:00:00.000Z' },
      { id: 'newer', createdAt: '2026-10-15T12:00:00.000Z' },
    ];
    assert.deepEqual(newestByCreatedAt(items).map((i) => i.id), ['newer', 'older']);
  });
});
