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
});
