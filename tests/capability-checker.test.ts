import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityChecker } from '../src/orchestration/capability.js';
import type { ModelDefinition } from '../src/orchestration/registry.js';

const GIB = 1024 * 1024 * 1024;

function model(gb: number): ModelDefinition {
  return {
    id: `test:${gb}`, name: 'Test Model', lane: 'balanced', family: 'test', parameterSize: '7B', quantization: 'q4_0',
    memoryRequirementBytes: gb * GIB, contextLength: 4096, measuredTokensPerSec: 40, strengths: [], isPrimary: true,
  };
}

function checker(freeGb: number, totalGb = 64, options = {}) {
  const c = new CapabilityChecker({ env: {}, ...options });
  c.getFreeMemory = () => freeGb * GIB;
  c.getTotalMemory = () => totalGb * GIB;
  return c;
}

describe('CapabilityChecker', () => {
  test('host-only mode allows a load that leaves the floor intact', () => {
    const res = checker(32, 64, { minHeadroomBytes: 14 * GIB }).canRunModel(model(5));
    assert.equal(res.canRun, true);
    assert.equal(res.mode, 'host');
    assert.equal(res.freeRamGb, 32);
  });

  test('host-only mode blocks when free memory is below the floor', () => {
    const res = checker(12, 64, { minHeadroomBytes: 14 * GIB }).canRunModel(model(5));
    assert.equal(res.canRun, false);
    assert.ok(res.reason?.includes('headroom exhausted'));
  });

  test('host-only mode enforces post-load headroom, not just pre-load', () => {
    const res = checker(16, 64, { minHeadroomBytes: 14 * GIB }).canRunModel(model(5));
    assert.equal(res.canRun, false);
    assert.match(res.reason ?? '', /below the 14\.0 GB floor/);
  });

  test('default floor is min(14 GB, 25% of host RAM)', () => {
    assert.equal(checker(0, 31.65).getHostFloorBytes(), 0.25 * 31.65 * GIB);
    assert.equal(checker(0, 128).getHostFloorBytes(), 14 * GIB);
  });

  test('floor is overridable by env and constructor option, option wins', () => {
    assert.equal(checker(0, 31.65, { env: { JARVIS_MIN_HOST_FREE_GB: '6' } }).getHostFloorBytes(), 6 * GIB);
    assert.equal(checker(0, 31.65, { env: { JARVIS_MIN_HOST_FREE_GB: '6' }, minHeadroomBytes: 3 * GIB }).getHostFloorBytes(), 3 * GIB);
    assert.equal(checker(0, 31.65, { env: { JARVIS_MIN_HOST_FREE_GB: 'junk' } }).getHostFloorBytes(), 0.25 * 31.65 * GIB);
  });

  test('with VRAM known, a 30 GB model fits the pool even though host RAM is only 14 GB free', () => {
    const c = checker(14, 31.65);
    c.setVramFree(45.4 * GIB);
    const res = c.canRunModel(model(30));
    assert.equal(res.canRun, true);
    assert.equal(res.mode, 'vram');
  });

  test('with VRAM known, requirement plus margin must fit', () => {
    const c = checker(14, 31.65, { vramMarginBytes: 1 * GIB });
    c.setVramFree(30.5 * GIB);
    assert.equal(c.canRunModel(model(30)).canRun, false);
    assert.match(c.canRunModel(model(30)).reason ?? '', /Insufficient VRAM/);
    c.setVramFree(31.5 * GIB);
    assert.equal(c.canRunModel(model(30)).canRun, true);
  });

  test('with VRAM known, host RAM must still be above the floor', () => {
    const c = checker(5, 31.65);
    c.setVramFree(45 * GIB);
    const res = c.canRunModel(model(8));
    assert.equal(res.canRun, false);
    assert.ok(res.reason?.includes('headroom exhausted'));
  });

  test('null VRAM falls back to the host comparison; policy allow skips it', () => {
    const c = checker(14, 31.65);
    c.setVramFree(45 * GIB);
    c.setVramFree(null);
    assert.equal(c.canRunModel(model(30)).mode, 'host');
    assert.equal(c.canRunModel(model(30)).canRun, false);

    const lenient = checker(14, 31.65, { unknownVramPolicy: 'allow' });
    assert.equal(lenient.canRunModel(model(30)).mode, 'unverified');
    assert.equal(lenient.canRunModel(model(30)).canRun, true);
  });
});
