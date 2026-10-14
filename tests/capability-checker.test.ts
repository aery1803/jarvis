import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityChecker } from '../src/orchestration/capability.js';
import type { ModelDefinition } from '../src/orchestration/registry.js';

describe('CapabilityChecker', () => {
  const dummyModel: ModelDefinition = {
    id: 'test-model:7b',
    name: 'Test Model',
    lane: 'balanced',
    family: 'test',
    parameterSize: '7B',
    quantization: 'q4_0',
    memoryRequirementBytes: 5 * 1024 * 1024 * 1024, // 5 GB
    contextLength: 4096,
    measuredTokensPerSec: 40.0,
    strengths: [],
    isPrimary: true,
  };

  test('should allow execution when free memory exceeds required headroom', () => {
    // Mock checker with 32 GB free memory and 14 GB min headroom
    const checker = new CapabilityChecker({ minHeadroomBytes: 14 * 1024 * 1024 * 1024 });
    checker.getFreeMemory = () => 32 * 1024 * 1024 * 1024; // 32 GB free
    checker.getTotalMemory = () => 64 * 1024 * 1024 * 1024;

    const res = checker.canRunModel(dummyModel);
    assert.equal(res.canRun, true);
    assert.equal(res.freeRamGb, 32);
  });

  test('should block execution when free memory is below headroom threshold', () => {
    const checker = new CapabilityChecker({ minHeadroomBytes: 14 * 1024 * 1024 * 1024 });
    checker.getFreeMemory = () => 12 * 1024 * 1024 * 1024; // 12 GB free (below 14 GB)
    checker.getTotalMemory = () => 64 * 1024 * 1024 * 1024;

    const res = checker.canRunModel(dummyModel);
    assert.equal(res.canRun, false);
    assert.ok(res.reason?.includes('headroom exhausted'));
  });
});
