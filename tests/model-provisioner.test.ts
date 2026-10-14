import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ModelProvisioner } from '../src/orchestration/provisioner.js';
import { MockLLMProvider } from '../src/services/provider.js';

describe('ModelProvisioner (On-Demand JIT Model Dispatch)', () => {
  test('should classify code tasks to resident baseline qwen3:8b', () => {
    const mockProvider = new MockLLMProvider();
    const provisioner = new ModelProvisioner(mockProvider);

    const c1 = provisioner.classifyTask('Write a Python script to scrape stock prices');
    assert.equal(c1.model, 'qwen3:8b');
    assert.equal(c1.category, 'code');

    const c2 = provisioner.classifyTask('Fix the memory leak bug in this TypeScript loop');
    assert.equal(c2.model, 'qwen3:8b');
    assert.equal(c2.category, 'code');
  });

  test('should classify deep reasoning tasks to deepseek-r1:70b', () => {
    const mockProvider = new MockLLMProvider();
    const provisioner = new ModelProvisioner(mockProvider);

    const c1 = provisioner.classifyTask('Why does quantum entanglement violate classical locality? Calculate deep math probability with rigorous proof');
    assert.equal(c1.model, 'deepseek-r1:70b');
    assert.equal(c1.category, 'reasoning');
  });

  test('should classify casual chat to qwen3:8b', () => {
    const mockProvider = new MockLLMProvider();
    const provisioner = new ModelProvisioner(mockProvider);

    const c1 = provisioner.classifyTask('Hello Jarvis, how are you today?');
    assert.equal(c1.model, 'qwen3:8b');
    assert.equal(c1.category, 'chat');
  });

  test('should dispatch immediately if model is already installed', async () => {
    const mockProvider = new MockLLMProvider();
    mockProvider.listModels = async () => ['qwen3:8b'];

    let switchedTo = '';
    mockProvider.setModel = (m) => {
      switchedTo = m;
    };

    const provisioner = new ModelProvisioner(mockProvider);
    const decision = await provisioner.ensureAndDispatch({
      prompt: 'Write a quick PowerShell script',
    });

    assert.equal(decision.targetModel, 'qwen3:8b');
    assert.equal(decision.wasInstalledOnDemand, false);
    assert.equal(switchedTo, 'qwen3:8b');
  });

  test('should auto-pull model on-demand when missing and report progress', async () => {
    const mockProvider = new MockLLMProvider();
    // Simulate deepseek-r1:70b not yet installed
    mockProvider.listModels = async () => ['qwen3:8b'];

    let pulledModel = '';
    mockProvider.pullModel = async (name: string) => {
      pulledModel = name;
      return true;
    };

    const progressMessages: string[] = [];
    const provisioner = new ModelProvisioner(mockProvider);

    const decision = await provisioner.ensureAndDispatch({
      prompt: 'Calculate deep math probability with rigorous proof',
      onProgress: (msg) => {
        progressMessages.push(msg);
      },
    });

    assert.equal(decision.targetModel, 'deepseek-r1:70b');
    assert.equal(decision.wasInstalledOnDemand, true);
    assert.equal(pulledModel, 'deepseek-r1:70b');
    assert.ok(progressMessages.length >= 2);
    assert.ok(progressMessages[0].includes('Auto-downloading'));
    assert.ok(progressMessages[1].includes('installed successfully'));
  });

  test('should escalate precise work to 32B-class model qwen3:32b', () => {
    const mockProvider = new MockLLMProvider();
    const provisioner = new ModelProvisioner(mockProvider);

    const c1 = provisioner.classifyTask('Design a full architecture system blueprint with multi-file precision engineering');
    assert.equal(c1.model, 'qwen3:32b');
    assert.equal(c1.category, 'precision');
    assert.equal(c1.is30BClass, true);

    const c2 = provisioner.classifyTask('I need a precise production grade implementation of the consensus engine');
    assert.equal(c2.model, 'qwen3:32b');
    assert.equal(c2.category, 'precision');
    assert.equal(c2.is30BClass, true);
  });
});
