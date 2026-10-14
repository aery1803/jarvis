import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DocumentStore } from '../src/storage/collection.js';
import { SessionManager } from '../src/sessions/manager.js';
import { KillSwitch, KillSwitchEngagedError } from '../src/security/kill-switch.js';
import { ApprovalBroker } from '../src/security/approvals.js';

describe('KillSwitch & AuditLog', () => {
  const testDbPath = path.resolve(process.cwd(), 'data', 'test-killswitch.db');
  let store: DocumentStore;
  let sessions: SessionManager;
  let killSwitch: KillSwitch;

  beforeEach(() => {
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
    store = new DocumentStore(testDbPath);
    sessions = new SessionManager(store);
    killSwitch = new KillSwitch(store, sessions);
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  test('should trigger kill switch, abort active tasks, and record in audit log', async () => {
    const s = await sessions.createSession('owner', 'Dangerous Task Session');
    await sessions.createTask({ userId: 'owner', sessionId: s.id, title: 'Long task 1' });
    await sessions.createTask({ userId: 'owner', sessionId: s.id, title: 'Long task 2' });

    assert.equal(killSwitch.isKilled(), false);

    const res = await killSwitch.trigger('owner', 'User pressed Emergency Kill Switch');
    assert.equal(killSwitch.isKilled(), true);
    assert.equal(killSwitch.getKillReason(), 'User pressed Emergency Kill Switch');
    assert.equal(res.tasksAborted, 2);

    // Audit log should contain trigger event
    const logs = await killSwitch.getRecentAuditLogs();
    assert.ok(logs.length > 0);
    assert.equal(logs[0].eventType, 'KILL_SWITCH_TRIGGERED');
    assert.equal(logs[0].actor, 'owner');
  });

  test('should reset kill switch and log reset event', async () => {
    await killSwitch.trigger('admin', 'Testing stop');
    assert.equal(killSwitch.isKilled(), true);

    await killSwitch.reset('admin');
    assert.equal(killSwitch.isKilled(), false);

    const logs = await killSwitch.getRecentAuditLogs();
    assert.equal(logs[0].eventType, 'KILL_SWITCH_RESET');
  });

  test('persists the killed state so a restart does not silently re-arm Jarvis', async () => {
    await killSwitch.trigger('owner', 'stop everything');
    const restarted = new KillSwitch(store, sessions);
    assert.equal(restarted.isKilled(), true);
    assert.equal(restarted.getKillReason(), 'stop everything');
    assert.throws(() => restarted.assertNotKilled(), KillSwitchEngagedError);

    await restarted.reset('owner');
    const afterReset = new KillSwitch(store, sessions);
    assert.equal(afterReset.isKilled(), false);
    assert.doesNotThrow(() => afterReset.assertNotKilled());
  });

  test('assertNotKilled carries the reason', async () => {
    assert.doesNotThrow(() => killSwitch.assertNotKilled());
    await killSwitch.trigger('owner', 'because');
    assert.throws(() => killSwitch.assertNotKilled(), (e: any) => e instanceof KillSwitchEngagedError && e.reason === 'because' && /because/.test(e.message));
  });

  test('notifies subscribers before cancelling tasks, tolerates failing listeners, and supports unsubscribe', async () => {
    const order: string[] = [];
    const s = await sessions.createSession('owner', 'S');
    await sessions.createTask({ userId: 'owner', sessionId: s.id, title: 'T' });
    killSwitch.onTrigger(({ actor, reason }) => {
      order.push(`sync:${actor}:${reason}`);
    });
    killSwitch.onTrigger(async () => {
      order.push('async');
    });
    killSwitch.onTrigger(() => {
      throw new Error('listener bug');
    });
    const off = killSwitch.onTrigger(() => {
      order.push('removed');
    });
    off();

    const res = await killSwitch.trigger('owner', 'halt');
    assert.equal(res.tasksAborted, 1);
    assert.deepEqual(order, ['sync:owner:halt', 'async']);
    assert.equal(killSwitch.isKilled(), true);
  });

  test('aborts in-flight work and denies pending approvals via subscribers', async () => {
    const broker = new ApprovalBroker();
    broker.setNotifier(async () => {});
    const controller = new AbortController();
    killSwitch.onTrigger(({ reason }) => {
      controller.abort();
      broker.denyAll(reason);
    });
    const pending = broker.request({ actionType: 'SHELL_EXEC', description: 'x', tier: 2, requestedBy: 't' });
    await killSwitch.trigger('owner', 'kill');
    assert.equal(controller.signal.aborted, true);
    assert.equal((await pending).approved, false);
  });
});
