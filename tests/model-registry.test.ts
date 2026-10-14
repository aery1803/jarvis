import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ModelRegistry } from '../src/orchestration/registry.js';

const GIB = 1024 * 1024 * 1024;
const installed = [
  { name: 'qwen3:8b', size: 5225388164, details: { family: 'qwen3', parameter_size: '8.2B', quantization_level: 'Q4_K_M' } },
  { name: 'qwen3:14b', size: 9276198565 },
  { name: 'bartowski/moonshotai_Kimi-Linear-48B-A3B-Instruct-GGUF:latest', size: 31000000000 },
  { name: 'mystery-coder:7b', size: 4400000000 },
];

describe('ModelRegistry', () => {
  test('defaults reference only tags installed on the box', () => {
    const registry = new ModelRegistry();
    for (const bad of ['qwen2.5:7b', 'qwen2.5-coder:7b', 'nomic-embed-text:latest', 'llava:7b']) {
      assert.equal(registry.getModel(bad), null, bad);
    }
    assert.equal(registry.getModel('qwen3:8b')?.isPrimary, true);
  });

  test('a model serving several lanes is not clobbered by a second registration', () => {
    const registry = new ModelRegistry();
    for (const lane of ['resident', 'fast', 'code'] as const) {
      assert.equal(registry.getPrimaryModelForLane(lane)?.id, 'qwen3:8b', lane);
    }
    assert.equal(registry.listModels().filter((m) => m.id === 'qwen3:8b').length, 1);

    registry.register({ ...registry.getModel('qwen3:8b')!, lane: 'balanced', strengths: ['x'], isPrimary: false });
    assert.equal(registry.getModel('qwen3:8b')?.lane, 'resident');
    assert.ok(registry.listModels('balanced').some((m) => m.id === 'qwen3:8b'));
    assert.equal(registry.getPrimaryModelForLane('resident')?.id, 'qwen3:8b');
  });

  test('primary and alternate lookups', () => {
    const registry = new ModelRegistry();
    assert.equal(registry.getPrimaryModelForLane('balanced')?.id, 'qwen3:14b');
    registry.register({
      id: 'mistral:7b', name: 'Mistral 7B', lane: 'balanced', family: 'mistral', parameterSize: '7B', quantization: 'q4_k_m',
      memoryRequirementBytes: 4.5 * GIB, contextLength: 32768, measuredTokensPerSec: 38, strengths: [], isPrimary: false,
    });
    assert.equal(registry.getAlternateModelForLane('balanced', 'qwen3:14b')?.id, 'mistral:7b');
  });

  test('reconcileInstalled marks installed, overrides memory, registers unknowns and maps Kimi alias', () => {
    const registry = new ModelRegistry();
    assert.equal(registry.hasInstalledInfo(), false);
    const report = registry.reconcileInstalled(installed);

    assert.equal(registry.hasInstalledInfo(), true);
    assert.equal(registry.isInstalled('qwen3:8b'), true);
    assert.equal(registry.isInstalled('qwen3:32b'), false);
    const eight = registry.getModel('qwen3:8b')!;
    assert.equal(eight.diskSizeBytes, 5225388164);
    assert.ok(eight.memoryRequirementBytes > 5225388164 && eight.memoryRequirementBytes < 5225388164 + 2 * GIB);

    assert.equal(registry.isInstalled('kimi-linear-48b-a3b:instruct'), true);
    assert.equal(registry.getInstalledTag('kimi-linear-48b-a3b:instruct'), 'bartowski/moonshotai_Kimi-Linear-48B-A3B-Instruct-GGUF:latest');
    assert.equal(registry.listModels().filter((m) => m.family === 'kimi').length, 1);

    assert.deepEqual(report.added, ['mystery-coder:7b']);
    assert.equal(registry.getModel('mystery-coder:7b')?.lane, 'code');
    assert.ok(report.notInstalled.includes('qwen3:72b'));
    assert.deepEqual(registry.listInstalled('deep').map((m) => m.id), ['kimi-linear-48b-a3b:instruct']);
  });

  test('getInstalledPrimaryForLane ignores uninstalled primaries and treats :latest as the bare tag', () => {
    const registry = new ModelRegistry();
    registry.reconcileInstalled([{ name: 'qwen3:8b:latest', size: 5e9 }, { name: 'qwen3:32b', size: 2e10 }]);
    assert.equal(registry.getInstalledPrimaryForLane('deep')?.id, 'qwen3:32b');
    assert.equal(registry.isInstalled('qwen3:8b'), true);
    assert.equal(registry.getInstalledPrimaryForLane('fast')?.id, 'qwen3:8b');
    assert.equal(registry.getInstalledPrimaryForLane('vision'), null);
  });

  test('markInstalled adds one model without dropping the snapshot', () => {
    const registry = new ModelRegistry();
    registry.reconcileInstalled([{ name: 'qwen3:8b', size: 5e9 }]);
    registry.markInstalled('qwen3:14b');
    assert.equal(registry.isInstalled('qwen3:14b'), true);
    assert.equal(registry.isInstalled('qwen3:8b'), true);
  });
});
