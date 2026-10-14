import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ModelRegistry } from '../src/orchestration/registry.js';
import { MemoryGovernor } from '../src/orchestration/governor.js';
import { CascadeRouter } from '../src/orchestration/router.js';
import { CapabilityChecker } from '../src/orchestration/capability.js';

describe('CascadeRouter & MemoryGovernor', () => {
  test('should route code requests to code lane', async () => {
    const registry = new ModelRegistry();
    const checker = new CapabilityChecker({ minHeadroomBytes: 1024 * 1024 }); // 1MB for test isolation
    checker.getFreeMemory = () => 32 * 1024 * 1024 * 1024;
    const governor = new MemoryGovernor({ capabilityChecker: checker, pacingDelayMs: 0 });
    const router = new CascadeRouter(registry, governor);

    const decision = await router.route({
      prompt: 'Write a TypeScript function to calculate factorial',
    });

    assert.equal(decision.lane, 'code');
    assert.equal(decision.chosenModel.lane, 'code');
    assert.ok(decision.chosenModel.id.includes('qwen2.5-coder'));
    assert.equal(decision.isFallback, false);
  });

  test('should route complex analysis to balanced lane', async () => {
    const registry = new ModelRegistry();
    const checker = new CapabilityChecker({ minHeadroomBytes: 1024 * 1024 });
    checker.getFreeMemory = () => 32 * 1024 * 1024 * 1024;
    const governor = new MemoryGovernor({ capabilityChecker: checker, pacingDelayMs: 0 });
    const router = new CascadeRouter(registry, governor);

    const decision = await router.route({
      prompt: 'Synthesize consensus and compare the architectural differences between LanceDB and SQLite',
    });

    assert.equal(decision.lane, 'balanced');
    assert.equal(decision.chosenModel.id, 'qwen2.5:7b');
  });

  test('should cascade down to lighter model when heavy model exceeds memory headroom', async () => {
    const registry = new ModelRegistry();
    // Simulate memory headroom restriction: 3 GB free (qwen2.5:7b requires ~4.8 GB so it won't fit, but 1.5B requires 1.2 GB and fits)
    const checker = new CapabilityChecker({ minHeadroomBytes: 1024 * 1024 });
    checker.getFreeMemory = () => 2.5 * 1024 * 1024 * 1024; // 2.5 GB free
    const governor = new MemoryGovernor({ capabilityChecker: checker, pacingDelayMs: 0 });
    const router = new CascadeRouter(registry, governor);

    const decision = await router.route({
      prompt: 'Analyze complex multi-agent system architecture',
      taskType: 'reasoning',
    });

    assert.equal(decision.isFallback, true);
    assert.ok(decision.chosenModel.memoryRequirementBytes < 2.5 * 1024 * 1024 * 1024);
  });
});
