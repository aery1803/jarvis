import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalBroker } from '../src/security/approvals.js';
import type { ApprovalAuditEvent, ApprovalRequest } from '../src/security/approvals.js';

const base = { actionType: 'SHELL_EXEC', description: 'run ls', tier: 2 as const, requestedBy: 'tester' };

describe('ApprovalBroker', () => {
  test('denies by default when no notifier is registered', async () => {
    const broker = new ApprovalBroker();
    const decision = await broker.request(base);
    assert.equal(decision.approved, false);
    assert.match(decision.reason ?? '', /no approval channel/i);
    assert.equal(broker.pending().length, 0);
  });

  test('resolves approved when the owner approves', async () => {
    const broker = new ApprovalBroker();
    let seen: ApprovalRequest | undefined;
    broker.setNotifier(async (req) => {
      seen = req;
    });
    const promise = broker.request(base);
    await new Promise((r) => setImmediate(r));
    assert.ok(seen);
    assert.equal(broker.pending().length, 1);
    assert.equal(broker.resolve(seen.id, true, 'owner-1'), true);
    const decision = await promise;
    assert.deepEqual([decision.approved, decision.decidedBy], [true, 'owner-1']);
    assert.equal(broker.pending().length, 0);
  });

  test('handles a reply that arrives synchronously inside the notifier', async () => {
    const broker = new ApprovalBroker();
    broker.setNotifier(async (req) => {
      broker.resolve(req.id, false, 'owner');
    });
    const decision = await broker.request(base);
    assert.equal(decision.approved, false);
    assert.equal(decision.decidedBy, 'owner');
  });

  test('ids are unguessable uuids and unique', async () => {
    const broker = new ApprovalBroker();
    const ids: string[] = [];
    broker.setNotifier(async (req) => {
      ids.push(req.id);
    });
    void broker.request(base);
    void broker.request(base);
    await new Promise((r) => setImmediate(r));
    assert.equal(new Set(ids).size, 2);
    assert.match(ids[0], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(broker.denyAll('cleanup'), 2);
  });

  test('resolve is idempotent and false for unknown ids', async () => {
    const broker = new ApprovalBroker();
    let id = '';
    broker.setNotifier(async (req) => {
      id = req.id;
    });
    const promise = broker.request(base);
    await new Promise((r) => setImmediate(r));
    assert.equal(broker.resolve(id, true, 'owner'), true);
    assert.equal(broker.resolve(id, false, 'owner'), false);
    assert.equal((await promise).approved, true);
    assert.equal(broker.resolve('nope', true, 'owner'), false);
  });

  test('denies on timeout and then refuses a late resolve', async () => {
    const broker = new ApprovalBroker({ timeoutMs: 15 });
    let id = '';
    broker.setNotifier(async (req) => {
      id = req.id;
    });
    const decision = await broker.request(base);
    assert.equal(decision.approved, false);
    assert.match(decision.reason ?? '', /timed out/i);
    assert.equal(broker.resolve(id, true, 'owner'), false);
  });

  test('denies when the notifier throws', async () => {
    const broker = new ApprovalBroker();
    broker.setNotifier(async () => {
      throw new Error('telegram down');
    });
    const decision = await broker.request(base);
    assert.equal(decision.approved, false);
    assert.match(decision.reason ?? '', /telegram down/);
    assert.equal(broker.pending().length, 0);
  });

  test('never approves Tier 3 and rejects duplicate ids', async () => {
    const broker = new ApprovalBroker();
    broker.setNotifier(async () => {});
    assert.equal((await broker.request({ ...base, tier: 3 })).approved, false);
    void broker.request({ ...base, id: 'fixed' });
    await new Promise((r) => setImmediate(r));
    const dup = await broker.request({ ...base, id: 'fixed' });
    assert.equal(dup.approved, false);
    assert.equal(broker.pending().length, 1);
    broker.denyAll('done');
  });

  test('denyAll denies every pending request and reports the count', async () => {
    const broker = new ApprovalBroker();
    broker.setNotifier(async () => {});
    const a = broker.request(base);
    const b = broker.request(base);
    assert.equal(broker.denyAll('kill switch'), 2);
    assert.deepEqual([(await a).reason, (await b).reason], ['kill switch', 'kill switch']);
    assert.equal(broker.denyAll('again'), 0);
  });

  test('audits lifecycle events and survives a failing audit sink', async () => {
    const events: ApprovalAuditEvent[] = [];
    const broker = new ApprovalBroker({ audit: (e) => void events.push(e) });
    broker.setNotifier(async (req) => {
      broker.resolve(req.id, true, 'owner');
    });
    await broker.request(base);
    assert.deepEqual(events.map((e) => e.type), ['requested', 'approved']);

    const flaky = new ApprovalBroker({
      audit: async () => {
        throw new Error('disk full');
      },
    });
    assert.equal((await flaky.request(base)).approved, false);
  });

  test('clearNotifier removes only the notifier it is given and restores the channel it displaced', async () => {
    const broker = new ApprovalBroker();
    const seen: string[] = [];
    const passive = async (req: ApprovalRequest): Promise<void> => void seen.push(`passive:${req.id}`);
    const channel = async (): Promise<void> => undefined;
    broker.setNotifier(passive);
    broker.setNotifier(channel);

    broker.clearNotifier(passive);
    assert.equal(broker.hasNotifier(), true, 'a notifier that is no longer the current one is left alone');
    const stillChannel = broker.request({ ...base });
    assert.equal(broker.pending().length, 1);
    broker.denyAll('x');
    await stillChannel;

    broker.clearNotifier(channel);
    const pending = broker.request({ ...base, description: 'later' });
    await new Promise((r) => setImmediate(r));
    assert.equal(seen.length, 1, 'the displaced channel is asked again');
    assert.equal(broker.pending().length, 1);
    broker.denyAll('done');
    await pending;

    broker.clearNotifier(passive);
    assert.equal(broker.hasNotifier(), false);
    assert.match((await broker.request(base)).reason ?? '', /no approval channel/i);
  });
});
