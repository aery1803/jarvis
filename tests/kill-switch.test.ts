import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DocumentStore } from '../src/storage/collection.js';
import { SessionManager } from '../src/sessions/manager.js';
import { KillSwitch } from '../src/security/kill-switch.js';

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
});
