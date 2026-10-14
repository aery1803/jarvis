/**
 * Unit Tests: pure browser helpers (link safety, formatting) and the skill-reply parser
 * Authority: FEAT-004
 *
 * `api.js` touches `document` only inside the functions that build elements, so its pure helpers import cleanly in Node.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { safeHttpUrl, formatBytes, formatGb, formatPercent, formatDuration, number } from '../src/web/public/api.js';
import { createRequestGate, deriveSessionTitle, planImageFiles, createToolChipTracker, deviceStatusCells, isDrawerHidden, modelRetryDelayMs } from '../src/web/public/ui-logic.js';
import { parseSkillReply } from '../src/web/routes/skills.js';

describe('safeHttpUrl', () => {
  test('keeps http and https links and refuses every other scheme', () => {
    assert.equal(safeHttpUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
    assert.equal(safeHttpUrl('http://example.com'), 'http://example.com/');
    for (const bad of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd', 'ftp://example.com', '//example.com', 'not a url', '', null, undefined]) {
      assert.equal(safeHttpUrl(bad), null, String(bad));
    }
  });
});

describe('formatting', () => {
  test('sizes, percentages and durations are readable and tolerate junk', () => {
    assert.equal(formatBytes(5225388164), '4.9 GB');
    assert.equal(formatBytes(512 * 1024 * 1024), '512 MB');
    assert.equal(formatBytes(null), 'unknown size');
    assert.equal(formatGb(2 ** 30), '1.0');
    assert.equal(formatPercent(0.857), '86%');
    assert.equal(formatDuration(1500), '1.5 s');
    assert.equal(formatDuration(250.4), '250 ms');
    assert.equal(number('x'), 0);
    assert.equal(number('12'), 12);
  });
});

describe('parseSkillReply', () => {
  test('reads the name, the sample input and the first code block', () => {
    const parsed = parseSkillReply('<think>plan</think>NAME: word-count\nSAMPLE_INPUT: {"text":"a b"}\n```js\nfunction run(i) { return 1; }\n```\nextra');
    assert.deepEqual(parsed, { name: 'word-count', code: 'function run(i) { return 1; }', sampleInput: { text: 'a b' }, hasSampleInput: true });
  });

  test('a sample the model wrote badly is dropped, and a reply without code is null', () => {
    const parsed = parseSkillReply('SAMPLE_INPUT: not json\n```javascript\nfunction run() {}\n```');
    assert.equal(parsed?.hasSampleInput, false);
    assert.equal(parsed?.name, null);
    assert.equal(parseSkillReply('I would write a function that counts words.'), null);
    assert.equal(parseSkillReply('```js\n\n```'), null);
  });
});

describe('createRequestGate', () => {
  test('only the newest token is current, and invalidate retires every older one', () => {
    const gate = createRequestGate();
    const a = gate.next();
    const b = gate.next();
    assert.equal(gate.isCurrent(a), false);
    assert.equal(gate.isCurrent(b), true);
    gate.invalidate();
    assert.equal(gate.isCurrent(b), false);
  });
});

describe('deriveSessionTitle', () => {
  test('uses the first message on one line, truncates on code points, and falls back when empty', () => {
    assert.equal(deriveSessionTitle('  how do\n\n I   reset  '), 'how do I reset');
    const long = deriveSessionTitle('😀'.repeat(60));
    assert.equal([...long].length, 40);
    assert.ok(long.endsWith('…'));
    assert.ok(!long.includes('\ufffd'));
    assert.equal(deriveSessionTitle('   '), 'New Conversation');
  });
});

describe('planImageFiles', () => {
  const img = (name: string) => ({ name, type: 'image/png' });
  test('a multi-select over the cap keeps only the slots left and counts the rest', () => {
    const files = [1, 2, 3, 4, 5, 6].map((n) => img(`f${n}`));
    const plan = planImageFiles(files, 1, 4);
    assert.deepEqual(plan.accepted.map((f) => f.name), ['f1', 'f2', 'f3']);
    assert.equal(plan.rejectedCount, 3);
  });
  test('non-images are ignored without counting as overflow', () => {
    const plan = planImageFiles([{ name: 'a.txt', type: 'text/plain' }, img('b')], 0, 4);
    assert.equal(plan.accepted.length, 1);
    assert.equal(plan.rejectedCount, 0);
    assert.equal(planImageFiles([img('x')], 4, 4).rejectedCount, 1);
  });
});

describe('createToolChipTracker', () => {
  test('two calls to the same tool get two chips; later frames follow the unfinished call', () => {
    const t = createToolChipTracker();
    const first = t.update({ name: 'web_search', state: 'requested' });
    const firstDone = t.update({ name: 'web_search', state: 'done' });
    const second = t.update({ name: 'web_search', state: 'requested' });
    const secondErr = t.update({ name: 'web_search', state: 'error', detail: 'boom' });
    assert.equal(first.callId, firstDone.callId);
    assert.notEqual(second.callId, first.callId);
    assert.equal(second.isNew, true);
    assert.equal(firstDone.text, 'tool: web_search - requested - done');
    assert.equal(secondErr.callId, second.callId);
    assert.equal(secondErr.text, 'tool: web_search - requested - error (boom)');
  });
  test('different tools never share a chip, and an unannounced call opens its own', () => {
    const t = createToolChipTracker();
    const a = t.update({ name: 'a', state: 'requested' });
    const b = t.update({ name: 'b', state: 'requested' });
    assert.notEqual(a.callId, b.callId);
    t.update({ name: 'a', state: 'done' });
    assert.equal(t.update({ name: 'a', state: 'done' }).isNew, true);
  });
});

describe('deviceStatusCells', () => {
  test('an unreadable device shows unknown, never 0% or a fresh sync time', () => {
    const cells = deviceStatusCells({ connected: false, batteryLevel: 0, isCharging: false, lastSyncTime: '2026-01-01T00:00:00Z' });
    assert.deepEqual(cells, { battery: 'unknown', charging: 'unknown', lastSync: null, reason: null });
  });
  test('a connected device shows its measured values', () => {
    assert.deepEqual(deviceStatusCells({ connected: true, batteryLevel: 87, isCharging: true, lastSyncTime: 'T' }), { battery: '87%', charging: 'yes', lastSync: 'T', reason: null });
    assert.equal(deviceStatusCells({ connected: true, batteryLevel: undefined, isCharging: false, lastSyncTime: 'T' }).battery, 'unknown');
  });
  test('null readings are unknown, never 0% or "not charging", and the reason is carried', () => {
    const cells = deviceStatusCells({ connected: true, batteryLevel: null, isCharging: null, lastSyncTime: null, unavailableReason: 'adb shell failed' });
    assert.deepEqual(cells, { battery: 'unknown', charging: 'unknown', lastSync: null, reason: 'adb shell failed' });
  });
});

describe('isDrawerHidden', () => {
  test('only a closed drawer on a narrow screen is hidden', () => {
    assert.equal(isDrawerHidden(true, false), true);
    assert.equal(isDrawerHidden(true, true), false);
    assert.equal(isDrawerHidden(false, false), false);
  });
});

describe('modelRetryDelayMs', () => {
  test('backs off from 3 s and never exceeds 30 s', () => {
    assert.equal(modelRetryDelayMs(0), 3000);
    assert.equal(modelRetryDelayMs(2), 12000);
    assert.equal(modelRetryDelayMs(50), 30000);
  });
});
