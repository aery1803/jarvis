import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DocumentStore } from '../src/storage/collection.js';
import { SkillGenerator } from '../src/skills/generator.js';
import { ReflexCompiler } from '../src/skills/reflex.js';

describe('SkillGenerator & ReflexCompiler', () => {
  const testDbPath = path.resolve(process.cwd(), 'data', 'test-skills.db');
  let store: DocumentStore;
  let skills: SkillGenerator;
  let reflexes: ReflexCompiler;

  beforeEach(() => {
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
    store = new DocumentStore(testDbPath);
    skills = new SkillGenerator(store);
    reflexes = new ReflexCompiler(store);
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  test('should generate a skill and verify it passes benign sandbox test', async () => {
    const skill = await skills.generateSkill({
      name: 'FormatJSON',
      description: 'Formats raw json strings',
      executableCode: 'function format(str) { return JSON.stringify(JSON.parse(str), null, 2); }',
    });

    const testRes = await skills.testInSandbox(skill.id);
    assert.equal(testRes.passed, true);
    assert.equal(testRes.forbiddenActionsDetected, false);

    const promoted = await skills.promoteSkill(skill.id);
    assert.equal(promoted.status, 'active');
  });

  test('should detect forbidden constructs in sandbox testing', async () => {
    const maliciousSkill = await skills.generateSkill({
      name: 'MaliciousEval',
      description: 'Contains dangerous eval',
      executableCode: 'eval("rm -rf /")',
    });

    const testRes = await skills.testInSandbox(maliciousSkill.id);
    assert.equal(testRes.passed, false);
    assert.equal(testRes.forbiddenActionsDetected, true);
  });

  test('should compile workflows into macro reflexes and match them', async () => {
    const macro = await reflexes.compileReflex('morning status check', [
      'query_weather',
      'fetch_gmail_summaries',
      'report_workstation_health',
    ]);

    assert.ok(macro.id.startsWith('reflex-'));
    assert.equal(macro.steps.length, 3);

    const matched = await reflexes.findReflex('run morning status check now');
    assert.ok(matched);
    assert.equal(matched.id, macro.id);
  });

  test('static analysis rejects module access, escapes, globals and unlisted fetch targets', async () => {
    const bad = [
      "const fs = require('fs'); function run(){ return 1 }",
      "import fs from 'node:fs'; function run(){}",
      "function run(){ return process.env.SECRET }",
      "function run(){ return this.constructor.constructor('return process')() }",
      "function run(){ return new Function('return 1')() }",
      "function run(){ return globalThis }",
      "function run(){ return import('node:fs') }",
      "function run(){ return fetch('https://evil.example/x') }",
      "function run(u){ return fetch(u) }",
      "function run(){ require('child_process').exec('x') }",
      "function run(){ return Reflect.ownKeys({}) }",
      "function run(){ setTimeout(() => {}, 1) }",
    ];
    for (const code of bad) {
      const skill = await skills.generateSkill({ name: 'Bad', description: 'd', executableCode: code });
      const res = await skills.testInSandbox(skill.id);
      assert.equal(res.passed, false, code);
      assert.equal(res.forbiddenActionsDetected, true, code);
      assert.equal((await skills.getSkill(skill.id))?.status, 'draft');
    }
    const allowed = new SkillGenerator(store, { allowedFetchHosts: ['api.example.com'] });
    const ok = await allowed.generateSkill({ name: 'Net', description: 'd', executableCode: "function run(){ return fetch('https://api.example.com/x') }" });
    assert.equal((await allowed.testInSandbox(ok.id)).forbiddenActionsDetected, false);
  });

  test('sandbox actually executes the entry function against sample inputs', async () => {
    const skill = await skills.generateSkill({
      name: 'Doubler',
      description: 'doubles',
      executableCode: 'function run(input) { console.log("got", input.n); return { doubled: input.n * 2 }; }',
    });
    const res = await skills.testInSandbox(skill.id, { sampleInputs: [{ n: 2 }, { n: 21 }] });
    assert.equal(res.passed, true);
    assert.equal(res.executed, true);
    assert.deepEqual(res.samples.map((s) => s.output), [{ doubled: 4 }, { doubled: 42 }]);
    assert.ok(res.logs.includes('got 2'));
  });

  test('sandbox supports async entry points and arrow-function constants', async () => {
    const a = await skills.generateSkill({ name: 'Async', description: 'd', executableCode: 'async function run(x) { await null; return x + 1 }' });
    assert.deepEqual((await skills.testInSandbox(a.id, { sampleInputs: [1] })).samples[0].output, 2);
    const b = await skills.generateSkill({ name: 'Arrow', description: 'd', executableCode: 'const run = (x) => x.toUpperCase();' });
    assert.deepEqual((await skills.testInSandbox(b.id, { sampleInputs: ['abc'] })).samples[0].output, 'ABC');
  });

  test('a sample that throws, a syntax error, and a missing entry point all fail the sandbox', async () => {
    const throwing = await skills.generateSkill({ name: 'Throws', description: 'd', executableCode: 'function run() { throw new Error("boom") }' });
    const r1 = await skills.testInSandbox(throwing.id, { sampleInputs: [1] });
    assert.equal(r1.passed, false);
    assert.match(r1.errors.join(' '), /boom/);
    assert.equal(r1.forbiddenActionsDetected, false);

    const syntax = await skills.generateSkill({ name: 'Syntax', description: 'd', executableCode: 'function run( {' });
    assert.equal((await skills.testInSandbox(syntax.id)).passed, false);

    const noEntry = await skills.generateSkill({ name: 'Nothing', description: 'd', executableCode: 'var x = 1;' });
    assert.match((await skills.testInSandbox(noEntry.id)).errors.join(' '), /entry point/);
  });

  test('sandbox enforces the wall-clock limit on sync and microtask loops and caps output size', async () => {
    const spin = await skills.generateSkill({ name: 'Spin', description: 'd', executableCode: 'function run() { while (true) {} }' });
    const t1 = await skills.testInSandbox(spin.id, { sampleInputs: [1], timeoutMs: 100 });
    assert.equal(t1.passed, false);
    assert.match(t1.errors.join(' '), /timed out|wall-clock/i);

    const micro = await skills.generateSkill({ name: 'Micro', description: 'd', executableCode: 'async function run() { for (;;) { await null; } }' });
    const t2 = await skills.testInSandbox(micro.id, { sampleInputs: [1], timeoutMs: 100 });
    assert.equal(t2.passed, false);

    const big = await skills.generateSkill({ name: 'Big', description: 'd', executableCode: 'function run() { return "x".repeat(200000) }' });
    const t3 = await skills.testInSandbox(big.id, { sampleInputs: [1] });
    assert.equal(t3.passed, false);
    assert.match(t3.errors.join(' '), /Output exceeds/);
  });

  test('skill code cannot reach host objects, eval strings, or require', async () => {
    const probes = [
      'function run() { return typeof require + typeof process + typeof globalThis.process }',
      'function run() { try { return [].constructor.constructor("return 1")() } catch (e) { return "blocked" } }',
    ];
    const outputs: unknown[] = [];
    for (const code of probes) {
      // Bypass static analysis on purpose to prove the vm layer holds on its own.
      const { runInSandbox } = await import('../src/skills/sandbox.js');
      outputs.push((await runInSandbox(code, { input: null })).output);
    }
    assert.equal(outputs[0], 'undefinedundefinedundefined');
    assert.equal(outputs[1], 'blocked');
  });

  test('promotion requires a sandbox pass and unchanged code; runSkill refuses non-active and unapproved Tier 2', async () => {
    const draft = await skills.generateSkill({ name: 'Draft', description: 'd', executableCode: 'function run(x) { return x }' });
    await assert.rejects(skills.promoteSkill(draft.id), /must pass testInSandbox/);
    await assert.rejects(skills.runSkill(draft.id, 1), /not active/);

    await skills.testInSandbox(draft.id);
    await skills.promoteSkill(draft.id);
    const ran = await skills.runSkill(draft.id, { a: 1 }, { isTainted: true });
    assert.equal(ran.ok, true);
    assert.deepEqual(ran.output, { a: 1 });
    assert.equal(ran.isTainted, true);
    assert.equal((await skills.getSkill(draft.id))?.successCount, 1);

    const t2 = await skills.generateSkill({ name: 'Tier2', description: 'd', requiredTier: 2, executableCode: 'function run(x) { return x }' });
    await skills.testInSandbox(t2.id);
    await assert.rejects(skills.promoteSkill(t2.id), /Tier 2/);
    await skills.promoteSkill(t2.id, true);
    await assert.rejects(skills.runSkill(t2.id, 1), /Tier 2/);
    assert.equal((await skills.runSkill(t2.id, 1, { ownerApproved: true })).ok, true);
    await assert.rejects(skills.runSkill(t2.id, 1), /Tier 2/, 'approval is per run');
  });

  test('tampered code is refused at promotion and at run time', async () => {
    const skill = await skills.generateSkill({ name: 'Tamper', description: 'd', executableCode: 'function run() { return 1 }' });
    await skills.testInSandbox(skill.id);
    const col = store.getCollection<any>('skills');
    col.updateOne({ id: skill.id }, { executableCode: 'function run() { return 2 }' });
    await assert.rejects(skills.promoteSkill(skill.id), /code changed/);

    await skills.testInSandbox(skill.id);
    await skills.promoteSkill(skill.id);
    col.updateOne({ id: skill.id }, { executableCode: 'function run() { return 3 }' });
    await assert.rejects(skills.runSkill(skill.id, null), /does not match/);
  });

  test('listSkills filters by status and getSkill returns null for unknown ids', async () => {
    const a = await skills.generateSkill({ name: 'A', description: 'd', executableCode: 'function run(){ return 1 }' });
    await skills.generateSkill({ name: 'B', description: 'd', executableCode: 'function run(){ return 2 }' });
    await skills.testInSandbox(a.id);
    assert.equal((await skills.listSkills({ status: 'sandboxed' })).length, 1);
    assert.equal((await skills.listSkills()).length, 2);
    assert.equal(await skills.getSkill('nope'), null);
  });

  test('reflex matching is token-based: short substrings and single shared words do not match', async () => {
    await reflexes.compileReflex('morning status check', ['query_weather', 'report_workstation_health']);
    assert.equal(await reflexes.findReflex('a'), null);
    assert.equal(await reflexes.findReflex('check'), null);
    assert.equal(await reflexes.findReflex('status'), null);
    assert.equal(await reflexes.findReflex('what is the status of my tax return check'), null);
    assert.ok(await reflexes.findReflex('Morning   STATUS check'));
    assert.ok(await reflexes.findReflex('please run the morning status check now'));
  });

  test('prefix matches outrank loose overlaps and exact outranks both', async () => {
    const loose = await reflexes.compileReflex('deploy staging build', ['a']);
    const exact = await reflexes.compileReflex('deploy staging', ['b']);
    const match = await reflexes.findReflexMatch('deploy staging');
    assert.equal(match?.macro.id, exact.id);
    assert.equal(match?.kind, 'exact');
    const prefix = await reflexes.findReflexMatch('deploy staging build tonight');
    assert.equal(prefix?.macro.id, loose.id);
    assert.equal(prefix?.kind, 'prefix');
  });

  test('recompiling a mixed-case trigger updates the same reflex instead of duplicating it', async () => {
    const first = await reflexes.compileReflex('Morning Status Check', ['a']);
    const second = await reflexes.compileReflex('morning status check', ['b']);
    assert.equal(first.id, second.id);
    assert.equal((await reflexes.listReflexes()).length, 1);
    assert.equal(second.executionCount, 2);
  });

  test('recordFailure decays confidence until the reflex stops matching; locked reflexes are immune', async () => {
    const macro = await reflexes.compileReflex('rotate backups', ['list_files', 'copy_file']);
    for (let i = 0; i < 3; i++) await reflexes.recordFailure(macro.id);
    const stored = (await reflexes.listReflexes())[0];
    assert.ok(stored.confidence < 0.3);
    assert.equal(stored.failureCount, 3);
    assert.equal(await reflexes.findReflex('rotate backups'), null);

    const locked = await reflexes.compileReflex('lock me down', ['x']);
    await reflexes.setLocked(locked.id, true);
    for (let i = 0; i < 5; i++) await reflexes.recordFailure(locked.id);
    const lockedNow = (await reflexes.listReflexes()).find((m) => m.id === locked.id)!;
    assert.equal(lockedNow.confidence, 0.8);
    assert.ok(await reflexes.findReflex('lock me down'));

    const again = await reflexes.compileReflex('lock me down', ['y']);
    assert.deepEqual(again.steps, ['x'], 'locked steps are never overwritten');
  });

  test('recordSuccess raises confidence and keeps a running average duration; decayStale lowers idle reflexes', async () => {
    const macro = await reflexes.compileReflex('sync notes', ['a'], 100);
    await reflexes.recordSuccess(macro.id, 300);
    const used = (await reflexes.listReflexes())[0];
    assert.equal(used.confidence, 0.85);
    assert.equal(used.avgDurationMs, 200);

    const later = Date.now() + 65 * 24 * 60 * 60 * 1000;
    assert.equal(await reflexes.decayStale(later), 1);
    const decayed = (await reflexes.listReflexes())[0];
    assert.equal(decayed.confidence, 0.65);
    assert.equal(await reflexes.decayStale(later), 0, 'decay is not applied twice for the same idle period');
  });

  test('compileReflex rejects steps that are not tool names, and hintFor produces a planner hint', async () => {
    await assert.rejects(reflexes.compileReflex('x', ['rm -rf /']), /tool names/);
    await assert.rejects(reflexes.compileReflex('x', []), /tool names/);
    await reflexes.compileReflex('weekly report', ['fetch_gmail_summaries', 'report_workstation_health']);
    const hint = await reflexes.hintFor('weekly report please');
    assert.deepEqual(hint?.steps, ['fetch_gmail_summaries', 'report_workstation_health']);
  });

  test('the planner hint carries no confidence until outcomes earn one, and shows the counts', async () => {
    await reflexes.compileReflex('weekly report', ['fetch_gmail_summaries', 'report_workstation_health']);
    const fresh = await reflexes.hintFor('weekly report please');
    assert.equal(fresh?.confidence, undefined, 'the constant starting 0.8 is not evidence');
    assert.equal(fresh?.worked, 1);
    assert.equal(fresh?.failed, 0);

    const [macro] = await reflexes.listReflexes();
    await reflexes.recordSuccess(macro.id);
    await reflexes.recordSuccess(macro.id);
    await reflexes.recordFailure(macro.id);
    const earned = await reflexes.hintFor('weekly report please');
    assert.equal(earned?.worked, 3);
    assert.equal(earned?.failed, 1);
    assert.equal(earned?.confidence, 0.75, 'the observed success rate: 3 of 4');
  });
});

