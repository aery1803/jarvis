/**
 * Unit Tests: POST /api/probe/speed and the Ollama counters behind it
 *
 * The probe client is replaced by a scripted fake, so no Ollama, network or real model is involved. The
 * `OllamaProvider` side is checked against a loopback HTTP server that plays Ollama's `/api/generate` and `/api/ps`.
 */

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { JarvisWebServer } from '../src/web/server.js';
import { OllamaProvider, type ResidentModelInfo, type SpeedProbeClient, type SpeedProbeCounters, type SpeedProbeRequest } from '../src/services/provider.js';
import { SPEED_PROBE_PROMPT, convertSpeedRun, parseSpeedRequest, summarizeSpeed } from '../src/web/routes/speed.js';
import type { Diagnostics } from '../src/web/diagnostics.js';
import { GIB, REAL_VRAM_BYTES, makeHarness, type Harness, type HarnessOptions } from './fixtures/runtime-harness.js';

const JSON_HEADERS = { 'Content-Type': 'application/json', 'X-Jarvis-Client': 'web' };
const GPU_PROBE = async (): Promise<Diagnostics['gpu']> => ({
  probe: 'llama.cpp',
  devices: [{ index: 0, backend: 'Vulkan', name: 'Radeon 8060S', totalBytes: 48 * GIB, freeBytes: 45 * GIB }],
});

/** What Ollama sends for a 128-token run: counters in nanoseconds. */
const counters = (decodeTokensPerSec: number, extra: SpeedProbeCounters = {}): SpeedProbeCounters => ({
  loadDurationNs: 12_000_000,
  promptEvalCount: 20,
  promptEvalDurationNs: 100_000_000,
  evalCount: 128,
  evalDurationNs: Math.round((128 / decodeTokensPerSec) * 1e9),
  totalDurationNs: 3_000_000_000,
  doneReason: 'length',
  ...extra,
});

class FakeSpeedClient implements SpeedProbeClient {
  public readonly requests: SpeedProbeRequest[] = [];
  public psCalls = 0;
  constructor(
    private script: Array<SpeedProbeCounters | Error> = [counters(40)],
    private resident: ResidentModelInfo | null | Error = null,
    private gate?: Promise<void>
  ) {}

  async generateOnce(request: SpeedProbeRequest): Promise<SpeedProbeCounters> {
    this.requests.push(request);
    if (this.gate) {
      await new Promise<void>((resolve, reject) => {
        const abort = (): void => reject(new Error('This operation was aborted'));
        if (request.signal?.aborted) abort();
        request.signal?.addEventListener('abort', abort, { once: true });
        void this.gate?.then(resolve);
      });
    }
    const step = this.script[Math.min(this.requests.length - 1, this.script.length - 1)];
    if (step instanceof Error) throw step;
    return step;
  }

  async residentModel(): Promise<ResidentModelInfo | null> {
    this.psCalls += 1;
    if (this.resident instanceof Error) throw this.resident;
    return this.resident;
  }
}

interface Running {
  harness: Harness;
  server: JarvisWebServer;
  base: string;
}
const running: Running[] = [];

afterEach(async () => {
  while (running.length > 0) {
    const entry = running.pop() as Running;
    await entry.server.stop();
    await entry.harness.cleanup();
  }
});

async function start(client: FakeSpeedClient, options: HarnessOptions = {}): Promise<Running & { models: string[] }> {
  const models: string[] = [];
  const harness = await makeHarness({
    installed: ['qwen3:8b', 'qwen3:14b'],
    speedProbeFactory: (model) => {
      models.push(model);
      return client;
    },
    ...options,
  });
  const server = new JarvisWebServer({ port: 0, runtime: harness.rt, probes: { gpu: GPU_PROBE } });
  await server.start();
  const entry = { harness, server, base: `http://127.0.0.1:${server.getPort()}`, models };
  running.push(entry);
  return entry;
}

async function post(base: string, body: unknown = {}, headers: Record<string, string> = { Origin: base }): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}/api/probe/speed`, { method: 'POST', headers: { ...JSON_HEADERS, ...headers }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function waitFor<T>(read: () => T | undefined | false | null, what: string): Promise<T> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('speed probe arithmetic', () => {
  test('Ollama nanosecond counters become ms and tokens per second', () => {
    const run = convertSpeedRun(1, { loadDurationNs: 1_500_000_000, promptEvalCount: 26, promptEvalDurationNs: 130_000_000, evalCount: 128, evalDurationNs: 2_560_000_000, doneReason: 'length' });
    assert.deepEqual(run, { run: 1, loadMs: 1500, promptEvalTokens: 26, promptEvalTokensPerSec: 200, decodeTokens: 128, decodeTokensPerSec: 50, doneReason: 'length' });
  });

  test('a counter Ollama did not send is null, never zero or a guess', () => {
    assert.deepEqual(convertSpeedRun(2, {}), { run: 2, loadMs: null, promptEvalTokens: null, promptEvalTokensPerSec: null, decodeTokens: null, decodeTokensPerSec: null, doneReason: null });
    const zeroDuration = convertSpeedRun(1, { evalCount: 10, evalDurationNs: 0, promptEvalCount: 5, promptEvalDurationNs: 0 });
    assert.equal(zeroDuration.decodeTokensPerSec, null);
    assert.equal(zeroDuration.promptEvalTokensPerSec, null);
    assert.equal(zeroDuration.decodeTokens, 10);
  });

  test('the median and best come from the warm runs; a single run is the only run', () => {
    const rate = (n: number, v: number | null) => ({ run: n, loadMs: 0, promptEvalTokens: 1, promptEvalTokensPerSec: 1, decodeTokens: 1, decodeTokensPerSec: v, doneReason: null });
    assert.deepEqual(summarizeSpeed([rate(1, 10), rate(2, 40), rate(3, 44), rate(4, 42)]), { basedOn: 'warm runs', runsCounted: 3, medianDecodeTokensPerSec: 42, bestDecodeTokensPerSec: 44 });
    assert.deepEqual(summarizeSpeed([rate(1, 10), rate(2, 40), rate(3, 44)]), { basedOn: 'warm runs', runsCounted: 2, medianDecodeTokensPerSec: 42, bestDecodeTokensPerSec: 44 });
    assert.deepEqual(summarizeSpeed([rate(1, 31.2)]), { basedOn: 'only run', runsCounted: 1, medianDecodeTokensPerSec: 31.2, bestDecodeTokensPerSec: 31.2 });
    assert.deepEqual(summarizeSpeed([rate(1, 10), rate(2, null)]), { basedOn: 'warm runs', runsCounted: 0, medianDecodeTokensPerSec: null, bestDecodeTokensPerSec: null });
  });

  test('request parsing applies the defaults and bounds every field', () => {
    const defaults = { model: 'qwen3:8b', numCtx: 16_384 };
    assert.deepEqual(parseSpeedRequest(undefined, defaults), { model: 'qwen3:8b', numCtx: 16_384, numPredict: 128, repeat: 3, think: false });
    assert.deepEqual(parseSpeedRequest({ model: ' qwen3:14b ', numCtx: 512, numPredict: 512, repeat: 5, think: true }, defaults), { model: 'qwen3:14b', numCtx: 512, numPredict: 512, repeat: 5, think: true });
    assert.equal(parseSpeedRequest({ numCtx: 131_072 }, defaults) instanceof Object, true);
    for (const bad of [{ numCtx: 511 }, { numCtx: 131_073 }, { numCtx: 4096.5 }, { numCtx: '4096' }, { numPredict: 0 }, { numPredict: 513 }, { repeat: 0 }, { repeat: 6 }, { think: 'yes' }, { model: 'bad;name' }, { model: 7 }]) {
      assert.equal(typeof parseSpeedRequest(bad, defaults), 'string', JSON.stringify(bad));
    }
    assert.deepEqual(parseSpeedRequest({}, { model: 'm', numCtx: 100 }), { model: 'm', numCtx: 512, numPredict: 128, repeat: 3, think: false });
  });
});

describe('POST /api/probe/speed', () => {
  test('runs the fixed prompt the requested number of times and returns converted counters, a separate first run, and /api/ps', async () => {
    const client = new FakeSpeedClient(
      [counters(10, { loadDurationNs: 9_000_000_000 }), counters(40), counters(44), counters(42)],
      { name: 'qwen3:14b', sizeBytes: 10_000_000_000, sizeVramBytes: 8_000_000_000, contextLength: 8192 }
    );
    const { base, models } = await start(client);
    const res = await post(base, { model: 'qwen3:14b', numCtx: 8192, numPredict: 100, repeat: 4 });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.deepEqual(models, ['qwen3:14b']);
    assert.equal(client.requests.length, 4);
    for (const request of client.requests) {
      assert.deepEqual({ prompt: request.prompt, numCtx: request.numCtx, numPredict: request.numPredict, think: request.think }, { prompt: SPEED_PROBE_PROMPT, numCtx: 8192, numPredict: 100, think: false });
      assert.ok(request.signal);
    }
    assert.equal(res.json.model, 'qwen3:14b');
    assert.equal(res.json.prompt, SPEED_PROBE_PROMPT);
    assert.equal(res.json.runs.length, 4);
    assert.equal(res.json.firstRun.loadMs, 9000);
    assert.equal(res.json.firstRun.decodeTokensPerSec, 10);
    assert.deepEqual(res.json.runs.map((r: { decodeTokensPerSec: number }) => r.decodeTokensPerSec), [10, 40, 44, 42]);
    assert.deepEqual(res.json.runs[1], { run: 2, loadMs: 12, promptEvalTokens: 20, promptEvalTokensPerSec: 200, decodeTokens: 128, decodeTokensPerSec: 40, doneReason: 'length' });
    assert.deepEqual(res.json.summary, { basedOn: 'warm runs', runsCounted: 3, medianDecodeTokensPerSec: 42, bestDecodeTokensPerSec: 44 });
    assert.deepEqual(res.json.resident, { name: 'qwen3:14b', sizeBytes: 10_000_000_000, sizeVramBytes: 8_000_000_000, contextLength: 8192, vramShare: 0.8 });
    assert.equal(res.json.residentError, undefined);
    assert.equal(client.psCalls, 1);
  });

  test('an empty body uses the default model, the configured context, 128 tokens, three runs and no thinking', async () => {
    const client = new FakeSpeedClient();
    const { base, models, harness } = await start(client);
    const res = await post(base, {});
    assert.equal(res.status, 200);
    assert.deepEqual(models, ['qwen3:8b']);
    assert.equal(client.requests.length, 3);
    assert.deepEqual({ numCtx: client.requests[0].numCtx, numPredict: client.requests[0].numPredict, think: client.requests[0].think }, { numCtx: harness.rt.config.contextTokens, numPredict: 128, think: false });
    assert.equal(res.json.resident, null);
  });

  test('think:true is passed through', async () => {
    const client = new FakeSpeedClient();
    const { base } = await start(client);
    await post(base, { repeat: 1, think: true });
    assert.equal(client.requests[0].think, true);
  });

  test('invalid fields are 400 with a message and never reach the model', async () => {
    const client = new FakeSpeedClient();
    const { base } = await start(client);
    const cases: Array<[unknown, RegExp]> = [
      [{ numCtx: 100 }, /numCtx must be a whole number from 512 to 131072/],
      [{ numCtx: 200_000 }, /numCtx/],
      [{ numPredict: 0 }, /numPredict must be a whole number from 1 to 512/],
      [{ numPredict: 513 }, /numPredict/],
      [{ repeat: 0 }, /repeat must be a whole number from 1 to 5/],
      [{ repeat: 6 }, /repeat/],
      [{ think: 'no' }, /think must be true or false/],
      [{ model: 'bad;name' }, /Invalid model name/],
    ];
    for (const [body, message] of cases) {
      const res = await post(base, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.match(res.json.error, message);
    }
    assert.equal(client.requests.length, 0);
    assert.equal(running[0].harness.rt.benchmark.guard.isBusy(), false);
  });

  test('a model that is not installed is 404 and is never probed', async () => {
    const client = new FakeSpeedClient();
    const { base } = await start(client);
    const res = await post(base, { model: 'qwen3:72b' });
    assert.equal(res.status, 404);
    assert.match(res.json.error, /not installed/);
    assert.equal(client.requests.length, 0);
    assert.equal(running[0].harness.rt.benchmark.guard.isBusy(), false, 'the single-flight slot is freed');
  });

  test('an unreachable Ollama is 503 with the reason', async () => {
    const { base } = await start(new FakeSpeedClient(), { fetchInventory: async () => ({ baseUrl: 'x', reachable: false, installed: [], loaded: [], error: 'ECONNREFUSED' }) });
    const res = await post(base, {});
    assert.equal(res.status, 503);
    assert.match(res.json.error, /ECONNREFUSED/);
  });

  test('the kill switch refuses it with 503 and runs nothing', async () => {
    const client = new FakeSpeedClient();
    const { base, harness } = await start(client);
    await harness.rt.killSwitch.trigger('test', 'test stop');
    const res = await post(base, {});
    assert.equal(res.status, 503);
    assert.match(res.json.error, /Kill switch engaged: test stop/);
    assert.equal(client.requests.length, 0);
  });

  test('a request without a same-origin Origin header is 403', async () => {
    const client = new FakeSpeedClient();
    const { base } = await start(client);
    assert.equal((await post(base, {}, {})).status, 403);
    assert.equal((await post(base, {}, { Origin: 'http://evil.example' })).status, 403);
    assert.equal(client.requests.length, 0);
  });

  test('while a probe runs a second probe and a benchmark are 409 (one slot), and the slot is freed afterwards', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const client = new FakeSpeedClient([counters(40)], null, gate);
    const { base, harness } = await start(client);
    const first = post(base, { repeat: 1 });
    try {
      await waitFor(() => client.requests.length > 0, 'the probe to start');
      const second = await post(base, {});
      assert.equal(second.status, 409);
      assert.match(second.json.error, /already running \(speed probe: qwen3:8b\)/);
      const benchmark = await fetch(`${base}/api/benchmark`, { method: 'POST', headers: { ...JSON_HEADERS, Origin: base }, body: '{}' });
      assert.equal(benchmark.status, 409);
      assert.equal(client.requests.length, 1);
    } finally {
      release();
    }
    assert.equal((await first).status, 200);
    assert.equal(harness.rt.benchmark.guard.isBusy(), false);
  });

  test('a benchmark that is already running makes the probe 409 without touching the model', async () => {
    const client = new FakeSpeedClient();
    const { base, harness } = await start(client);
    const release = harness.rt.benchmark.guard.tryAcquire('qwen3:14b');
    assert.ok(release);
    const res = await post(base, {});
    assert.equal(res.status, 409);
    assert.match(res.json.error, /already running \(qwen3:14b\)/);
    assert.equal(client.requests.length, 0);
    release();
  });

  test('the client disconnecting aborts the in-flight run and frees the slot', async () => {
    const gate = new Promise<void>(() => undefined);
    const client = new FakeSpeedClient([counters(40)], null, gate);
    const { base, harness } = await start(client);
    const controller = new AbortController();
    const request = fetch(`${base}/api/probe/speed`, { method: 'POST', headers: { ...JSON_HEADERS, Origin: base }, body: '{}', signal: controller.signal }).catch(() => null);
    await waitFor(() => client.requests.length > 0, 'the probe to start');
    controller.abort();
    await request;
    await waitFor(() => !harness.rt.benchmark.guard.isBusy(), 'the slot to be released');
    assert.equal(client.requests[0].signal?.aborted, true);
    assert.equal(client.requests.length, 1, 'no further runs after the disconnect');
  });

  test('a failing run is 502 naming the run, and the slot is freed', async () => {
    const client = new FakeSpeedClient([counters(40), new Error('model runner crashed')]);
    const { base, harness } = await start(client);
    const res = await post(base, {});
    assert.equal(res.status, 502);
    assert.match(res.json.error, /Speed probe run 2 of 3 failed: model runner crashed/);
    assert.equal(harness.rt.benchmark.guard.isBusy(), false);
  });

  test('counters Ollama left out come back as null, with no speed claimed', async () => {
    const { base } = await start(new FakeSpeedClient([{}]));
    const res = await post(base, { repeat: 2 });
    assert.equal(res.status, 200);
    assert.equal(res.json.runs[0].decodeTokensPerSec, null);
    assert.equal(res.json.summary.medianDecodeTokensPerSec, null);
    assert.equal(res.json.summary.bestDecodeTokensPerSec, null);
  });

  test('a failing /api/ps does not lose the measurements; the reason is reported', async () => {
    const { base } = await start(new FakeSpeedClient([counters(40)], new Error('ps unavailable')));
    const res = await post(base, { repeat: 1 });
    assert.equal(res.status, 200);
    assert.equal(res.json.resident, null);
    assert.equal(res.json.residentError, 'ps unavailable');
    assert.equal(res.json.summary.medianDecodeTokensPerSec, 40);
  });

  test('uses VRAM figures only from /api/ps (the real box has about 47.8 GiB of Vulkan memory)', async () => {
    const { base } = await start(new FakeSpeedClient([counters(40)], { name: 'qwen3:8b', sizeBytes: 5_225_388_164, sizeVramBytes: 5_225_388_164 }), { vramFreeBytes: REAL_VRAM_BYTES });
    const res = await post(base, { repeat: 1 });
    assert.equal(res.json.resident.vramShare, 1);
    assert.equal(res.json.resident.contextLength, undefined);
  });
});

describe('OllamaProvider speed probe calls', () => {
  interface Seen {
    path: string;
    body: Record<string, unknown>;
  }
  let server: http.Server | null = null;
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = null;
  });

  async function fakeOllama(handler: (seen: Seen) => { status?: number; body: unknown }): Promise<{ provider: OllamaProvider; seen: Seen[] }> {
    const seen: Seen[] = [];
    server = http.createServer((req, res) => {
      let text = '';
      req.on('data', (chunk) => (text += chunk));
      req.on('end', () => {
        const entry: Seen = { path: req.url ?? '', body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
        seen.push(entry);
        const reply = handler(entry);
        res.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const port = (server?.address() as AddressInfo).port;
    return { provider: new OllamaProvider({ baseUrl: `http://127.0.0.1:${port}`, model: 'probe-model:1b' }), seen };
  }

  test('generateOnce sends a non-streaming, temperature-0 request with think set, and returns the raw counters', async () => {
    const { provider, seen } = await fakeOllama(() => ({
      body: { response: '1, 2, 3', done: true, done_reason: 'length', load_duration: 1_000_000, prompt_eval_count: 12, prompt_eval_duration: 2_000_000, eval_count: 128, eval_duration: 3_200_000_000, total_duration: 4_000_000_000 },
    }));
    const result = await provider.generateOnce({ prompt: SPEED_PROBE_PROMPT, numCtx: 4096, numPredict: 128, think: false });
    assert.deepEqual(result, { loadDurationNs: 1_000_000, promptEvalCount: 12, promptEvalDurationNs: 2_000_000, evalCount: 128, evalDurationNs: 3_200_000_000, totalDurationNs: 4_000_000_000, doneReason: 'length' });
    assert.equal(seen[0].path, '/api/generate');
    assert.deepEqual(seen[0].body, {
      model: 'probe-model:1b',
      prompt: SPEED_PROBE_PROMPT,
      stream: false,
      options: { num_ctx: 4096, num_predict: 128, temperature: 0 },
      think: false,
    });
    assert.equal('keep_alive' in seen[0].body, false, 'keep_alive stays at Ollama\'s default');
    assert.equal(convertSpeedRun(1, result).decodeTokensPerSec, 40);
  });

  test('an Ollama error body or HTTP error is thrown, not turned into numbers', async () => {
    const failing = await fakeOllama(() => ({ status: 500, body: { error: 'llama runner process has terminated' } }));
    await assert.rejects(failing.provider.generateOnce({ prompt: 'x', numCtx: 512, numPredict: 1, think: false }), /Ollama error 500: .*llama runner process has terminated/);
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
    const inBody = await fakeOllama(() => ({ body: { error: 'model failed to load' } }));
    await assert.rejects(inBody.provider.generateOnce({ prompt: 'x', numCtx: 512, numPredict: 1, think: false }), /Ollama error: model failed to load/);
  });

  test('residentModel reads size, size_vram and context_length from /api/ps, matches by tag, and is null when not resident', async () => {
    const { provider } = await fakeOllama(() => ({
      body: { models: [{ name: 'other:7b', size: 1, size_vram: 1 }, { name: 'probe-model:1b', model: 'probe-model:1b', size: 5_000_000_000, size_vram: 4_500_000_000, context_length: 8192 }] },
    }));
    assert.deepEqual(await provider.residentModel(), { name: 'probe-model:1b', sizeBytes: 5_000_000_000, sizeVramBytes: 4_500_000_000, contextLength: 8192 });
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
    const none = await fakeOllama(() => ({ body: { models: [{ name: 'other:7b', size: 1, size_vram: 1 }] } }));
    assert.equal(await none.provider.residentModel(), null);
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
    const noContext = await fakeOllama(() => ({ body: { models: [{ name: 'probe-model:1b', size: 10, size_vram: 5 }] } }));
    assert.deepEqual(await noContext.provider.residentModel(), { name: 'probe-model:1b', sizeBytes: 10, sizeVramBytes: 5 });
  });
});
