import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DocumentStore } from '../src/storage/collection.js';
import { CostLedger } from '../src/orchestration/ledger.js';
import { MultiAgentOrchestrator } from '../src/agents/orchestrator.js';

describe('MultiAgentOrchestrator & Taint Tracking', () => {
  const testDbPath = path.resolve(process.cwd(), 'data', 'test-multiagent.db');
  let store: DocumentStore;
  let ledger: CostLedger;
  let orchestrator: MultiAgentOrchestrator;

  beforeEach(() => {
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
    store = new DocumentStore(testDbPath);
    ledger = new CostLedger(store);
    orchestrator = new MultiAgentOrchestrator(undefined, ledger);
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  test('should propagate taint tracking when researcher ingests external data', async () => {
    const res = await orchestrator.executeTask({
      id: 'task-1',
      assignedRole: 'researcher',
      goal: 'Explore AI agent frameworks',
      inputPayload: {},
      isTainted: false,
    });

    assert.equal(res.status, 'success');
    assert.equal(res.isTainted, true); // External research is tainted by default
    assert.equal(orchestrator.isTainted('findings:task-1'), true);
  });

  test('should run coordinated pipeline and produce synthesized result with taint flags intact', async () => {
    const pipelineRes = await orchestrator.runCoordinatedPipeline('Quantum computing state in 2026');

    assert.ok(pipelineRes.finalAnswer.includes('Evidence Summary'));
    assert.ok(pipelineRes.finalAnswer.includes('Audit Check'));
    assert.equal(pipelineRes.isTainted, true);
    assert.equal(pipelineRes.agentsInvolved.length, 3);
    assert.ok(pipelineRes.totalTokens > 0);

    // Verify CostLedger recorded agent activities
    const summary = await ledger.getSummary();
    assert.equal(summary.totalInvocations, 3);
  });
});
