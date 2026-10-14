import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityChecker } from '../src/orchestration/capability.js';
import { MemoryGovernor, LeaseTimeoutError, LeaseDeniedError, LeaseAbortedError, DEFAULT_LEASE_WAIT_MS } from '../src/orchestration/governor.js';
import type { ModelDefinition } from '../src/orchestration/registry.js';

const GIB = 1024 * 1024 * 1024;
const def = (id: string, gb: number): ModelDefinition => ({
  id, name: id, lane: 'deep', family: 't', parameterSize: '1B', quantization: 'q', memoryRequirementBytes: gb * GIB,
  contextLength: 1, measuredTokensPerSec: 1, strengths: [], isPrimary: false,
});

function governor(extra = {}) {
  const checker = new CapabilityChecker({ minHeadroomBytes: 1, env: {} });
  checker.getFreeMemory = () => 200 * GIB;
  checker.getTotalMemory = () => 256 * GIB;
  return new MemoryGovernor({ capabilityChecker: checker, pacingDelayMs: 0, ...extra });
}

describe('MemoryGovernor', () => {
  test('acquire/release keeps the single heavy model invariant', async () => {
    const g = governor();
    assert.equal((await g.acquireLease(def('a', 10))).acquired, true);
    assert.equal((await g.acquireLease(def('b', 10))).acquired, false);
    assert.equal((await g.acquireLease(def('small', 1))).acquired, true);
    g.releaseLease('a');
    assert.equal((await g.acquireLease(def('b', 10))).acquired, true);
  });

  test('withLease queues heavy models in FIFO order and releases in finally', async () => {
    const g = governor();
    const order: string[] = [];
    let releaseA!: () => void;
    const a = g.withLease(def('a', 10), () => new Promise<void>((r) => { order.push('a-start'); releaseA = r; }));
    const b = g.withLease(def('b', 10), async () => { order.push('b'); });
    const c = g.withLease(def('c', 10), async () => { order.push('c'); });
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(order, ['a-start']);
    assert.equal(g.getQueueLength(), 2);
    releaseA();
    await Promise.all([a, b, c]);
    assert.deepEqual(order, ['a-start', 'b', 'c']);
    assert.equal(g.getActiveHeavyModel(), null);
  });

  test('withLease releases when fn throws', async () => {
    const g = governor();
    await assert.rejects(g.withLease(def('a', 10), async () => { throw new Error('boom'); }), /boom/);
    assert.equal(g.getActiveHeavyModel(), null);
  });

  test('withLease times out with a typed error and leaves the queue clean', async () => {
    const g = governor();
    let releaseA!: () => void;
    const a = g.withLease(def('a', 10), () => new Promise<void>((r) => { releaseA = r; }));
    await assert.rejects(g.withLease(def('b', 10), async () => 1, { timeoutMs: 10 }), LeaseTimeoutError);
    assert.equal(g.getQueueLength(), 0);
    releaseA();
    await a;
  });

  test('withLease denies a model that does not fit with a typed error', async () => {
    const g = governor();
    g.getChecker().getFreeMemory = () => 2 * GIB;
    await assert.rejects(g.withLease(def('big', 10), async () => 1), LeaseDeniedError);
    assert.equal(g.getActiveHeavyModel(), null);
  });

  test('withLease honours thermal pacing between inferences', async () => {
    let now = 1000;
    const sleeps: number[] = [];
    const g = governor({ pacingDelayMs: 500, now: () => now, sleep: async (ms: number) => { sleeps.push(ms); now += ms; } });
    await g.withLease(def('s', 1), async () => { now += 10; });
    await g.withLease(def('s', 1), async () => 1);
    assert.deepEqual(sleeps, [500]);
  });

  test('the default wait for a heavy model is long enough for a heavy turn (15 minutes)', () => {
    assert.equal(DEFAULT_LEASE_WAIT_MS, 15 * 60 * 1000);
  });

  test('a queued waiter leaves the queue at once when its signal aborts, and the next waiter is still served', async () => {
    const g = governor();
    let releaseA!: () => void;
    const a = g.withLease(def('a', 10), () => new Promise<void>((r) => (releaseA = r)));
    const controller = new AbortController();
    const b = g.withLease(def('b', 10), async () => 'b-ran', { signal: controller.signal });
    const c = g.withLease(def('c', 10), async () => 'c-ran');
    await new Promise((r) => setImmediate(r));
    assert.equal(g.getQueueLength(), 2);
    controller.abort();
    await assert.rejects(b, LeaseAbortedError);
    assert.equal(g.getQueueLength(), 1, 'the aborted waiter no longer occupies a slot');
    releaseA();
    assert.equal(await c, 'c-ran');
    await a;
    assert.equal(g.getActiveHeavyModel(), null);
  });

  test('a signal that is already aborted never queues, and one that aborts as the lease is granted gives it back', async () => {
    const g = governor();
    const done = new AbortController();
    done.abort();
    await assert.rejects(g.withLease(def('a', 10), async () => 1, { signal: done.signal }), LeaseAbortedError);
    assert.equal(g.getActiveHeavyModel(), null);

    let releaseA!: () => void;
    const holder = g.withLease(def('a', 10), () => new Promise<void>((r) => (releaseA = r)));
    const late = new AbortController();
    let ran = false;
    const waiter = g.withLease(def('b', 10), async () => { ran = true; }, { signal: late.signal });
    await new Promise((r) => setImmediate(r));
    releaseA();
    late.abort();
    await holder;
    await waiter.catch(() => undefined);
    assert.equal(ran && late.signal.aborted && g.getActiveHeavyModel() !== null, false, 'an aborted waiter never leaves the lease held');
    assert.equal(g.getActiveHeavyModel(), null);
  });
});
