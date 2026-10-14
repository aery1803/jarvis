import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ModelRegistry } from '../src/orchestration/registry.js';
import { MemoryGovernor } from '../src/orchestration/governor.js';
import { CascadeRouter } from '../src/orchestration/router.js';
import { CapabilityChecker } from '../src/orchestration/capability.js';

const GIB = 1024 * 1024 * 1024;
const ALL_INSTALLED = [
  { name: 'qwen3:8b', size: 5225388164 },
  { name: 'qwen3:14b', size: 9276198565 },
  { name: 'qwen3.8:27b', size: 17741872154 },
  { name: 'qwen3:32b', size: 20201253829 },
];

function setup(freeGb: number, installed?: Array<{ name: string; size: number }>) {
  const registry = new ModelRegistry();
  if (installed) registry.reconcileInstalled(installed);
  const checker = new CapabilityChecker({ minHeadroomBytes: 1024 * 1024, env: {} });
  checker.getFreeMemory = () => freeGb * GIB;
  checker.getTotalMemory = () => 64 * GIB;
  const governor = new MemoryGovernor({ capabilityChecker: checker, pacingDelayMs: 0 });
  return { registry, checker, router: new CascadeRouter(registry, governor) };
}

describe('CascadeRouter', () => {
  test('routes code requests to the code lane (resident qwen3:8b)', async () => {
    const { router } = setup(32);
    const d = await router.route({ prompt: 'Write a TypeScript function to calculate factorial' });
    assert.equal(d.canRun, true);
    assert.equal(d.chosenModel?.id, 'qwen3:8b');
    assert.equal(d.isFallback, false);
  });

  test('"latest" does not trip the code keyword "test"', async () => {
    const { router } = setup(32);
    const d = await router.route({ prompt: 'what is the latest news' });
    assert.equal(d.lane, 'fast');
  });

  test('routes complex analysis to the balanced lane', async () => {
    const { router } = setup(32);
    const d = await router.route({ prompt: 'Synthesize consensus and compare the architectural differences between LanceDB and SQLite' });
    assert.equal(d.lane, 'balanced');
    assert.equal(d.chosenModel?.id, 'qwen3:14b');
  });

  test('cascades to a smaller installed model that fits', async () => {
    const { router } = setup(6.5, ALL_INSTALLED);
    const d = await router.route({ prompt: 'Analyze complex multi-agent system architecture', taskType: 'reasoning' });
    assert.equal(d.canRun, true);
    assert.equal(d.isFallback, true);
    assert.equal(d.chosenModel?.id, 'qwen3:8b');
  });

  test('routes among installed models only', async () => {
    const { router } = setup(60, [{ name: 'qwen3:8b', size: 5225388164 }]);
    const d = await router.route({ prompt: 'compare these two plans', taskType: 'reasoning' });
    assert.equal(d.chosenModel?.id, 'qwen3:8b');
    assert.equal(d.isFallback, true);
  });

  test('terminal case is an explicit canRun:false, never the refused model', async () => {
    const { router } = setup(1, ALL_INSTALLED);
    const d = await router.route({ prompt: 'hello there' });
    assert.equal(d.canRun, false);
    assert.equal(d.chosenModel, null);
    assert.ok(d.reason && d.reason.length > 0);
    assert.equal(d.refusedModel?.id, 'qwen3:8b');
  });

  test('honours preferredModel when installed and fitting', async () => {
    const { router } = setup(60, ALL_INSTALLED);
    const d = await router.route({ prompt: 'hello', preferredModel: 'qwen3:32b' });
    assert.equal(d.chosenModel?.id, 'qwen3:32b');
    assert.equal(d.isFallback, false);
  });

  test('preferredModel that is not installed falls back and says so', async () => {
    const { router } = setup(60, ALL_INSTALLED);
    const d = await router.route({ prompt: 'hello', preferredModel: 'qwen3:72b' });
    assert.equal(d.canRun, true);
    assert.notEqual(d.chosenModel?.id, 'qwen3:72b');
    assert.match(d.rationale, /not installed/);
  });

  test('embedding requests never land on a chat model', async () => {
    const { router } = setup(60, ALL_INSTALLED);
    const d = await router.route({ prompt: 'embed this', taskType: 'embedding' });
    assert.equal(d.canRun, false);
    assert.match(d.reason ?? '', /embedding/);
  });

  test('with the pool nearly full of an idle 14B, a 32B request is kept and the rationale says what is unloaded', async () => {
    const { router, checker } = setup(32, ALL_INSTALLED);
    checker.setVramTotal(24 * GIB);
    checker.setResidentModels([{ name: 'qwen3:14b', sizeVramBytes: 9.5 * GIB }]);
    checker.setVramFree(24 * GIB - 9.5 * GIB);
    const d = await router.route({ prompt: 'x', preferredModel: 'qwen3:32b' });
    assert.equal(d.chosenModel?.id, 'qwen3:32b');
    assert.equal(d.isFallback, false);
    assert.match(d.fitNote ?? '', /Ollama will unload qwen3:14b/);
    assert.match(d.rationale, /Ollama will unload qwen3:14b/);
  });

  test('a preferred model that is already resident is chosen again and says so', async () => {
    const { router, checker } = setup(32, ALL_INSTALLED);
    checker.setVramTotal(24 * GIB);
    checker.setResidentModels([{ name: 'qwen3:32b', sizeVramBytes: 21 * GIB }]);
    checker.setVramFree(3 * GIB);
    const d = await router.route({ prompt: 'x', preferredModel: 'qwen3:32b' });
    assert.equal(d.chosenModel?.id, 'qwen3:32b');
    assert.match(d.fitNote ?? '', /already resident/);
  });
});

