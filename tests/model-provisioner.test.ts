import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ModelProvisioner, NEMOTRON_REGISTRY_ID } from '../src/orchestration/provisioner.js';
import { CapabilityChecker } from '../src/orchestration/capability.js';
import { MockLLMProvider } from '../src/services/provider.js';

const GIB = 1024 * 1024 * 1024;
const FLEET = [
  { name: 'qwen3:8b', size: 5225388164 },
  { name: 'qwen3:14b', size: 9276198565 },
  { name: 'qwen3:32b', size: 20201253829 },
  { name: 'deepseek-r1:70b', size: 42520397873 },
  { name: NEMOTRON_REGISTRY_ID, size: 30215578984 },
];

function make(installed: Array<{ name: string; size?: number }>, vramGb: number | null = 45, extra: { pull?: (n: string) => boolean } = {}) {
  const provider = new MockLLMProvider();
  const switched: string[] = [];
  provider.setModel = (m) => { switched.push(m); };
  const pulled: string[] = [];
  provider.pullModel = async (n: string) => { pulled.push(n); return extra.pull ? extra.pull(n) : true; };
  const checker = new CapabilityChecker({ minHeadroomBytes: 1024 * 1024, env: {} });
  checker.getFreeMemory = () => 14 * GIB;
  checker.getTotalMemory = () => 31.65 * GIB;
  const provisioner = new ModelProvisioner(provider, {
    capabilityChecker: checker,
    getVramFreeBytes: async () => (vramGb === null ? null : vramGb * GIB),
    listInstalled: async () => installed,
  });
  return { provisioner, switched, pulled, provider };
}

describe('ModelProvisioner classification', () => {
  const p = new ModelProvisioner(new MockLLMProvider(), { listInstalled: async () => [] });

  test('code tasks go to the resident baseline', () => {
    assert.equal(p.classifyTask('Write a Python script to scrape stock prices').model, 'qwen3:8b');
    assert.equal(p.classifyTask('Fix the memory leak bug in this TypeScript loop').category, 'code');
  });

  test('deep math goes to deepseek; Nemotron requests go to Nemotron, not DeepSeek', () => {
    assert.equal(p.classifyTask('Calculate deep math probability with rigorous proof').model, 'deepseek-r1:70b');
    assert.equal(p.classifyTask('use nemotron for this').model, NEMOTRON_REGISTRY_ID);
    assert.equal(p.classifyTask('run the 49b model').model, NEMOTRON_REGISTRY_ID);
    assert.equal(p.classifyTask('what is r1 in the table').model, 'qwen3:8b');
  });

  test('Kimi resolves to the registry id, casual chat to qwen3:8b', () => {
    assert.equal(p.classifyTask('analyze this massive document with kimi').model, 'kimi-linear-48b-a3b:instruct');
    assert.equal(p.classifyTask('Hello Jarvis, how are you today?').model, 'qwen3:8b');
  });

  test('vision keywords are whole words and never name llava', () => {
    assert.equal(p.classifyTask('the microcracks crossed the sidewalk').category, 'chat');
    assert.equal(p.classifyTask('describe this screenshot').category, 'vision');
    assert.equal(p.classifyTask('describe this screenshot').model, '');
  });

  test('precise work escalates to qwen3:32b', () => {
    const c = p.classifyTask('Design a full architecture system blueprint with multi-file precision engineering');
    assert.equal(c.model, 'qwen3:32b');
    assert.equal(c.is30BClass, true);
  });
});

describe('ModelProvisioner dispatch', () => {
  test('dispatches immediately to an installed model and points the provider at it', async () => {
    const { provisioner, switched } = make(FLEET);
    const d = await provisioner.ensureAndDispatch({ prompt: 'Write a quick PowerShell script' });
    assert.equal(d.canRun, true);
    assert.equal(d.targetModel, 'qwen3:8b');
    assert.equal(d.isFallback, false);
    assert.equal(d.wasInstalledOnDemand, false);
    assert.deepEqual(switched, ['qwen3:8b']);
  });

  test('never pulls without a callback: uses an installed model and says so', async () => {
    const { provisioner, pulled } = make([{ name: 'qwen3:8b', size: 5225388164 }]);
    const d = await provisioner.ensureAndDispatch({ prompt: 'Calculate deep math probability with rigorous proof', allowPull: true });
    assert.deepEqual(pulled, []);
    assert.equal(d.targetModel, 'qwen3:8b');
    assert.equal(d.isFallback, true);
    assert.match(d.rationale, /Tier 2/);
  });

  test('a declined confirmation does not pull', async () => {
    const { provisioner, pulled } = make([{ name: 'qwen3:8b', size: 5225388164 }]);
    const asked: Array<[string, number]> = [];
    const d = await provisioner.ensureAndDispatch({
      prompt: 'Calculate deep math probability with rigorous proof',
      allowPull: true,
      confirmPull: async (id, size) => { asked.push([id, size]); return false; },
    });
    assert.deepEqual(pulled, []);
    assert.equal(asked[0][0], 'deepseek-r1:70b');
    assert.ok(asked[0][1] > 39 * GIB);
    assert.equal(d.targetModel, 'qwen3:8b');
    assert.match(d.rationale, /not approved/);
  });

  test('an approved confirmation pulls, reports progress, and uses the model', async () => {
    const { provisioner, pulled } = make([{ name: 'qwen3:8b', size: 5225388164 }]);
    const messages: string[] = [];
    const d = await provisioner.ensureAndDispatch({
      prompt: 'Calculate deep math probability with rigorous proof',
      allowPull: true,
      confirmPull: async () => true,
      onProgress: (m) => { messages.push(m); },
    });
    assert.deepEqual(pulled, ['deepseek-r1:70b']);
    assert.equal(d.targetModel, 'deepseek-r1:70b');
    assert.equal(d.wasInstalledOnDemand, true);
    assert.equal(messages.length, 2);
  });

  test('a pull receives the turn signal, relays progress, and stops when the signal aborts', async () => {
    const { provisioner, provider } = make([{ name: 'qwen3:8b', size: 5225388164 }]);
    const seen: { signal?: AbortSignal; timeoutMs?: number } = {};
    provider.pullModel = (async (_name: string, options?: { signal?: AbortSignal; timeoutMs?: number; onProgress?: (p: { status: string; percent?: number }) => void }) => {
      seen.signal = options?.signal;
      seen.timeoutMs = options?.timeoutMs;
      options?.onProgress?.({ status: 'pulling', percent: 10 });
      options?.onProgress?.({ status: 'pulling', percent: 12 });
      return new Promise<boolean>((resolve) => options?.signal?.addEventListener('abort', () => resolve(false)));
    }) as typeof provider.pullModel;
    const controller = new AbortController();
    const messages: string[] = [];
    const decision = provisioner.ensureAndDispatch({
      prompt: 'Calculate deep math probability with rigorous proof',
      allowPull: true,
      confirmPull: async () => true,
      signal: controller.signal,
      pullTimeoutMs: 1234,
      onProgress: (m) => { messages.push(m); },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort('Kill switch engaged');
    const d = await decision;
    assert.equal(seen.signal?.aborted, true);
    assert.equal(seen.timeoutMs, 1234);
    assert.ok(messages.some((m) => m.includes('10%')));
    assert.ok(!messages.some((m) => m.includes('12%')), 'progress is throttled to 5% steps');
    assert.equal(d.wasInstalledOnDemand, false);
    assert.match(d.rationale, /was stopped/);
  });

  test('explicitModel is honoured without reclassifying the prompt', async () => {
    const { provisioner, switched } = make(FLEET);
    const d = await provisioner.ensureAndDispatch({ prompt: 'Write a python function', explicitModel: 'qwen3:14b' });
    assert.equal(d.targetModel, 'qwen3:14b');
    assert.equal(d.isFallback, false);
    assert.deepEqual(switched, ['qwen3:14b']);
  });

  test('Kimi is dispatched under the tag the downloader installed', async () => {
    const tag = 'bartowski/moonshotai_Kimi-Linear-48B-A3B-Instruct-GGUF:latest';
    const { provisioner } = make([{ name: 'qwen3:8b', size: 5225388164 }, { name: tag, size: 31e9 }]);
    const d = await provisioner.ensureAndDispatch({ prompt: 'summarize this massive document' });
    assert.equal(d.targetModel, tag);
  });

  test('falls back to a fitting installed model when VRAM is too small', async () => {
    const { provisioner } = make(FLEET, 12);
    const d = await provisioner.ensureAndDispatch({ prompt: 'Calculate deep math probability with rigorous proof' });
    assert.equal(d.canRun, true);
    assert.equal(d.isFallback, true);
    assert.equal(d.targetModel, 'qwen3:14b');
  });

  test('reports canRun:false instead of pretending when nothing fits', async () => {
    const { provisioner, switched } = make(FLEET, 1);
    const d = await provisioner.ensureAndDispatch({ prompt: 'hello' });
    assert.equal(d.canRun, false);
    assert.equal(d.targetModel, '');
    assert.ok(d.reason);
    assert.deepEqual(switched, []);
  });

  test('a vision keyword with no vision model installed falls back to text chat and says so', async () => {
    const { provisioner } = make(FLEET);
    const d = await provisioner.ensureAndDispatch({ prompt: 'what is in this screenshot' });
    assert.equal(d.canRun, true);
    assert.equal(d.targetModel, 'qwen3:8b');
    assert.match(d.rationale, /No vision model/);
  });

  test('explicit vision with no vision model is canRun:false', async () => {
    const { provisioner } = make(FLEET);
    const d = await provisioner.ensureAndDispatch({ prompt: 'read it', taskType: 'vision' });
    assert.equal(d.canRun, false);
    assert.match(d.reason ?? '', /vision/);
  });
});

describe('ModelProvisioner: explicit model that is not installed', () => {
  // The owner's real Ollama inventory. The qwen3.8:27b size is a 27B Q4 estimate (the box did not report one).
  const REAL_INVENTORY = [
    { name: 'qwen3:72b', size: 47415724625 },
    { name: 'deepseek-r1:70b', size: 42520397873 },
    { name: NEMOTRON_REGISTRY_ID, size: 30215578984 },
    { name: 'qwen3:32b', size: 20201253829 },
    { name: 'qwen3.8:27b', size: 17.4 * GIB },
    { name: 'qwen3:14b', size: 9276198565 },
    { name: 'qwen3:8b', size: 5225388164 },
  ];

  test('hello with an uninstalled explicit model is answered by the resident qwen3:8b, not a heavier lane', async () => {
    const { provisioner, switched, pulled } = make(REAL_INVENTORY);
    const d = await provisioner.ensureAndDispatch({ prompt: 'hello', explicitModel: 'qwen2.5:7b' });
    assert.equal(d.canRun, true);
    assert.equal(d.targetModel, 'qwen3:8b');
    assert.equal(d.isFallback, true);
    assert.equal(d.requestedModel, 'qwen2.5:7b');
    assert.equal(d.wasInstalledOnDemand, false);
    assert.deepEqual(switched, ['qwen3:8b']);
    assert.deepEqual(pulled, [], 'nothing is downloaded without approval');
    assert.match(d.rationale, /qwen2\.5:7b is not installed/);
    assert.match(d.rationale, /answering instead/);
    assert.match(d.rationale, /qwen3:8b/);
    assert.match(d.rationale, /Tier 2 action that needs your approval/);
    assert.ok(!/qwen3:14b|qwen3:32b|qwen3:72b/.test(d.rationale), 'no heavier lane is named as the answerer');
  });

  test('the prompt is not reclassified: an analytical prompt still stays on the default model', async () => {
    const { provisioner } = make(REAL_INVENTORY);
    for (const prompt of ['Analyze and compare these two strategies in depth', 'Write a python function', 'rigorous proof please']) {
      const d = await provisioner.ensureAndDispatch({ prompt, explicitModel: 'qwen2.5:7b' });
      assert.equal(d.targetModel, 'qwen3:8b', prompt);
    }
  });

  test('a known but missing heavy model (qwen3:32b removed) also falls back to the default, not a lane-mate', async () => {
    const { provisioner } = make(REAL_INVENTORY.filter((m) => m.name !== 'qwen3:32b'));
    const d = await provisioner.ensureAndDispatch({ prompt: 'hello', explicitModel: 'qwen3:32b' });
    assert.equal(d.targetModel, 'qwen3:8b');
    assert.match(d.rationale, /qwen3:32b/);
    assert.match(d.rationale, /not installed/);
  });

  test('with the default model missing, the smallest installed model that fits answers', async () => {
    const { provisioner } = make(REAL_INVENTORY.filter((m) => m.name !== 'qwen3:8b'));
    const d = await provisioner.ensureAndDispatch({ prompt: 'hello', explicitModel: 'qwen2.5:7b' });
    assert.equal(d.targetModel, 'qwen3:14b');
    assert.equal(d.isFallback, true);
    assert.match(d.rationale, /smallest installed model that fits/);
  });

  test('a configured default other than qwen3:8b is honoured', async () => {
    const provider = new MockLLMProvider();
    const checker = new CapabilityChecker({ minHeadroomBytes: 1024 * 1024, env: {} });
    checker.getFreeMemory = () => 14 * GIB;
    checker.getTotalMemory = () => 31.65 * GIB;
    const provisioner = new ModelProvisioner(provider, {
      capabilityChecker: checker,
      getVramFreeBytes: async () => 45 * GIB,
      listInstalled: async () => REAL_INVENTORY,
      defaultModel: 'qwen3:14b',
    });
    const d = await provisioner.ensureAndDispatch({ prompt: 'hello', explicitModel: 'qwen2.5:7b' });
    assert.equal(d.targetModel, 'qwen3:14b');
  });

  test('canRun is false, with the Tier 2 explanation, when nothing installed fits', async () => {
    const { provisioner, switched } = make(REAL_INVENTORY, 1);
    const d = await provisioner.ensureAndDispatch({ prompt: 'hello', explicitModel: 'qwen2.5:7b' });
    assert.equal(d.canRun, false);
    assert.match(d.reason ?? '', /qwen2\.5:7b is not installed/);
    assert.match(d.reason ?? '', /Tier 2/);
    assert.deepEqual(switched, []);
  });

  test('an approved pull still wins: the owner asked for that model and said yes to downloading it', async () => {
    const { provisioner, pulled } = make(REAL_INVENTORY.filter((m) => m.name !== 'qwen3:32b'));
    const d = await provisioner.ensureAndDispatch({
      prompt: 'hello',
      explicitModel: 'qwen3:32b',
      allowPull: true,
      confirmPull: async () => true,
    });
    assert.deepEqual(pulled, ['qwen3:32b']);
    assert.equal(d.targetModel, 'qwen3:32b');
    assert.equal(d.wasInstalledOnDemand, true);
  });

  test('a declined pull falls back to the default and says the download was not approved', async () => {
    const { provisioner, pulled } = make(REAL_INVENTORY.filter((m) => m.name !== 'qwen3:32b'));
    const d = await provisioner.ensureAndDispatch({ prompt: 'hello', explicitModel: 'qwen3:32b', allowPull: true, confirmPull: async () => false });
    assert.deepEqual(pulled, []);
    assert.equal(d.targetModel, 'qwen3:8b');
    assert.match(d.rationale, /not approved/);
  });
});
