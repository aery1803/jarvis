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

describe('CapabilityChecker with resident models (the owner\'s 47.8 GiB pool)', () => {
  // The real registry requirements: weights plus 4%, on the real on-disk sizes.
  const real = (id: string, diskBytes: number): ModelDefinition => ({ ...model(0), id, memoryRequirementBytes: Math.round(diskBytes + Math.max(0.5 * GIB, diskBytes * 0.04)) });
  const q72 = real('qwen3:72b', 47415724625);
  const q8 = real('qwen3:8b', 5225388164);
  const total = 47.8 * GIB;
  const resident72 = 44.2 * GIB;

  function warm(resident: Array<{ name: string; sizeVramBytes: number }>, hostFreeGb = 14) {
    const c = checker(hostFreeGb, 31.65);
    c.setVramTotal(total);
    c.setResidentModels(resident);
    c.setVramFree(total - resident.reduce((sum, entry) => sum + entry.sizeVramBytes, 0));
    return c;
  }

  test('cold pool: the 72B fits and nothing needs to be unloaded', () => {
    const c = warm([]);
    const res = c.canRunModel(q72);
    assert.equal(res.canRun, true);
    assert.equal(res.evicts, undefined);
    assert.match(res.note ?? '', /without unloading anything/);
  });

  test('the 72B already resident fits itself again (3.6 GiB free, 44.2 GiB held by it)', () => {
    const c = warm([{ name: 'qwen3:72b', sizeVramBytes: resident72 }]);
    assert.ok(Math.abs((c.getVramFree() ?? 0) - 3.6 * GIB) < 0.01 * GIB);
    const res = c.canRunModel(q72);
    assert.equal(res.canRun, true);
    assert.equal(res.alreadyResident, true);
    assert.match(res.note ?? '', /already resident/);
  });

  test('with the 72B resident, the default 8B fits because Ollama unloads the idle 72B, and the note says so', () => {
    const c = warm([{ name: 'qwen3:72b', sizeVramBytes: resident72 }]);
    const res = c.canRunModel(q8);
    assert.equal(res.canRun, true);
    assert.deepEqual(res.evicts, ['qwen3:72b']);
    assert.match(res.note ?? '', /3\.6 GB of VRAM is free but qwen3:8b needs .* so Ollama will unload qwen3:72b/);
  });

  test('a resident model is matched by its canonical tag (:latest and case)', () => {
    const c = warm([{ name: 'QWEN3:72b', sizeVramBytes: resident72 }]);
    assert.equal(c.canRunModel(q72).alreadyResident, true);
  });

  test('resident bytes can never make the pool bigger than its real total', () => {
    // A stale resident list (the model was unloaded since) plus a fresh free figure must not promise more than exists.
    const c = checker(14, 31.65);
    c.setVramTotal(total);
    c.setResidentModels([{ name: 'qwen3:32b', sizeVramBytes: 30 * GIB }]);
    c.setVramFree(40 * GIB);
    const huge = real('huge:200b', 60e9);
    assert.equal(c.canRunModel(huge).canRun, false);
    assert.match(c.canRunModel(huge).reason ?? '', /47\.8 GB of VRAM is available/);
  });

  test('a model bigger than the whole pool is refused even with everything else evictable', () => {
    const c = warm([{ name: 'qwen3:8b', sizeVramBytes: 5 * GIB }]);
    const res = c.canRunModel(real('giant:120b', 60e9));
    assert.equal(res.canRun, false);
    assert.match(res.reason ?? '', /Insufficient VRAM/);
  });

  test('the host floor still applies to a load that is not resident, and not to one that is', () => {
    const resident = [{ name: 'qwen3:72b', sizeVramBytes: resident72 }];
    const starved = warm(resident, 3);
    assert.equal(starved.canRunModel(q8).canRun, false);
    assert.match(starved.canRunModel(q8).reason ?? '', /headroom exhausted/);
    assert.equal(starved.canRunModel(q72).canRun, true, 'nothing new is loaded for a resident model');
  });

  test('without a VRAM figure the resident list changes nothing', () => {
    const c = checker(14, 31.65, { unknownVramPolicy: 'allow' });
    c.setResidentModels([{ name: 'qwen3:72b', sizeVramBytes: resident72 }]);
    const res = c.canRunModel(q8);
    assert.equal(res.mode, 'unverified');
    assert.equal(res.canRun, true);
  });
});

