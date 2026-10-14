import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createBoardPoller } from '../src/cli/board-poller.js';
import { resolveWebPort, startTelegram, startWebServer } from '../src/cli/bootstrap.js';
import { makeHarness, type Harness } from './fixtures/runtime-harness.js';

async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
}

describe('board poller', () => {
  test('a poll is skipped while the kill switch is engaged', async () => {
    let polls = 0;
    let killed = true;
    const poller = createBoardPoller({ watcher: { pollBoard: async () => (polls++, []) }, killSwitch: { isKilled: () => killed }, intervalMs: 1000 });
    assert.equal(await poller.pollOnce(), null);
    assert.equal(polls, 0);
    killed = false;
    assert.equal(await poller.pollOnce(), 0);
    assert.equal(polls, 1);
  });

  test('a failing poll is reported as null and never throws', async () => {
    const poller = createBoardPoller({
      watcher: {
        pollBoard: async () => {
          throw new Error('gh is not installed');
        },
      },
      killSwitch: { isKilled: () => false },
      intervalMs: 1000,
    });
    assert.equal(await poller.pollOnce(), null);
  });

  test('concurrent polls share one run, so gh is never called twice at once', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let polls = 0;
    const poller = createBoardPoller({
      watcher: {
        pollBoard: async () => {
          polls += 1;
          await gate;
          return [{}, {}];
        },
      },
      killSwitch: { isKilled: () => false },
      intervalMs: 1000,
    });
    const a = poller.pollOnce();
    const b = poller.pollOnce();
    release();
    assert.deepEqual(await Promise.all([a, b]), [2, 2]);
    assert.equal(polls, 1);
  });

  test('start schedules the next cycle only after the previous one finished, and stop cancels it', async () => {
    const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
    let polls = 0;
    const poller = createBoardPoller({
      watcher: { pollBoard: async () => (polls++, []) },
      killSwitch: { isKilled: () => false },
      intervalMs: 45_000,
      setTimer: (fn, ms) => {
        const entry = { fn, ms, cleared: false };
        timers.push(entry);
        return { unref() {} } as unknown as NodeJS.Timeout;
      },
      clearTimer: () => {
        timers[timers.length - 1].cleared = true;
      },
    });
    poller.start();
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, 45_000);
    timers[0].fn();
    await settle();
    assert.equal(polls, 1);
    assert.equal(timers.length, 2, 'the next cycle is scheduled after the first finished');
    await poller.stop();
    assert.equal(timers[1].cleared, true);
    await settle();
    assert.equal(timers.length, 2, 'nothing is scheduled after stop');
  });
});

describe('launcher bootstrap', () => {
  test('resolveWebPort accepts a valid PORT and falls back to 3000', () => {
    const previous = process.env.PORT;
    try {
      process.env.PORT = '4321';
      assert.equal(resolveWebPort(), 4321);
      process.env.PORT = 'abc';
      assert.equal(resolveWebPort(), 3000);
      process.env.PORT = '70000';
      assert.equal(resolveWebPort(), 3000);
    } finally {
      if (previous === undefined) delete process.env.PORT;
      else process.env.PORT = previous;
    }
  });

  test('a busy port is retried and then reported with a clear message instead of an uncaught crash', async () => {
    let attempts = 0;
    const server = {
      start: async () => {
        attempts += 1;
        throw new Error('Port 3000 is already in use');
      },
    };
    await assert.rejects(() => startWebServer(server, 3000, 0), /Port 3000 is already in use by another program.*PORT environment variable/);
    assert.equal(attempts, 5);
  });

  test('a busy port that frees up is started on a later attempt', async () => {
    let attempts = 0;
    await startWebServer(
      {
        start: async () => {
          attempts += 1;
          if (attempts < 3) throw new Error('EADDRINUSE');
        },
      },
      3000,
      0
    );
    assert.equal(attempts, 3);
  });

  test('any other start error is reported once, with the port', async () => {
    let attempts = 0;
    await assert.rejects(
      () =>
        startWebServer(
          {
            start: async () => {
              attempts += 1;
              throw new Error('permission denied');
            },
          },
          80,
          0
        ),
      /Could not start the web server on port 80: permission denied/
    );
    assert.equal(attempts, 1);
  });

  describe('telegram start', () => {
    let harness: Harness;
    afterEach(async () => {
      await harness?.cleanup();
    });

    const getMeOk = (username: string): Response => new Response(JSON.stringify({ ok: true, result: { username } }));
    /** A `getUpdates` request that stays open until the poll is aborted, like a quiet long poll. */
    const quietPoll = (init?: RequestInit): Promise<Response> =>
      new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));

    test('a rejected token stops the bot from starting, with the reason', async () => {
      harness = await makeHarness();
      const fetchImpl = (async () => new Response(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }), { status: 401 })) as typeof fetch;
      await assert.rejects(() => startTelegram(harness.rt, '123', { token: 'bad-token', fetchImpl }), /rejected the bot token/);
    });

    test('a working token starts polling and reports the bot username and the auth mode', async () => {
      harness = await makeHarness();
      const fetchImpl = ((input: string | URL | Request, init?: RequestInit) =>
        String(input).endsWith('/getMe') ? Promise.resolve(getMeOk('jarvis_test_bot')) : quietPoll(init)) as typeof fetch;
      const started = await startTelegram(harness.rt, '123', { token: 'good-token', fetchImpl });
      assert.ok(started);
      assert.match(started.summary, /@jarvis_test_bot/);
      assert.match(started.summary, /owner 123 only/);
      await started.bot.stop(100);
    });

    test('with no owner configured the summary says the bot refuses everyone', async () => {
      harness = await makeHarness();
      const fetchImpl = ((input: string | URL | Request, init?: RequestInit) =>
        String(input).endsWith('/getMe') ? Promise.resolve(getMeOk('b')) : quietPoll(init)) as typeof fetch;
      const started = await startTelegram(harness.rt, '', { token: 'good-token', fetchImpl });
      assert.ok(started);
      assert.match(started.summary, /refusing everyone except \/id|OPEN DEV MODE/);
      await started.bot.stop(100);
    });
  });
});

describe('board poller change log', () => {
  test('the first poll is only a baseline; later polls report new, moved and removed cards', async () => {
    const polls: unknown[][] = [
      [{ itemId: 'a', issueNumber: 1, title: 'One', status: 'Todo' }, { itemId: 'b', issueNumber: 2, title: 'Two', status: 'Todo' }],
      [{ itemId: 'a', issueNumber: 1, title: 'One', status: 'In Progress' }, { itemId: 'c', issueNumber: 3, title: 'Three', status: 'Todo' }],
      [{ itemId: 'a', issueNumber: 1, title: 'One', status: 'In Progress' }, { itemId: 'c', issueNumber: 3, title: 'Three', status: 'Todo' }],
    ];
    const seen: unknown[][] = [];
    const poller = createBoardPoller({
      watcher: { pollBoard: async () => polls.shift() ?? [] },
      killSwitch: { isKilled: () => false },
      intervalMs: 1000,
      onChange: (changes) => seen.push(changes),
    });
    assert.equal(await poller.pollOnce(), 2);
    assert.deepEqual(seen, []);
    assert.equal(await poller.pollOnce(), 2);
    assert.deepEqual(seen, [[
      { kind: 'moved', itemId: 'a', title: 'One', issueNumber: 1, from: 'Todo', to: 'In Progress' },
      { kind: 'new', itemId: 'c', title: 'Three', issueNumber: 3, to: 'Todo' },
      { kind: 'removed', itemId: 'b', title: 'Two', issueNumber: 2, from: 'Todo' },
    ]]);
    await poller.pollOnce();
    assert.equal(seen.length, 1, 'an unchanged board reports nothing');
  });
});
