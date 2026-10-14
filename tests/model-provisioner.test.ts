import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ModelProvisioner } from '../src/orchestration/provisioner.js';
import { MockLLMProvider } from '../src/services/provider.js';

describe('ModelProvisioner (On-Demand JIT Model Dispatch)', () => {
  test('should classify code tasks to qwen2.5-coder:7b', () => {
    const mockProvider = new MockLLMProvider();
    const provisioner = new ModelProvisioner(mockProvider);

    const c1 = provisioner.classifyTask('Write a Python script to scrape stock prices');
    assert.equal(c1.model, 'qwen2.5-coder:7b');
    assert.equal(c1.category, 'code');

    const c2 = provisioner.classifyTask('Fix the memory leak bug in this TypeScript loop');
    assert.equal(c2.model, 'qwen2.5-coder:7b');
    assert.equal(c2.category, 'code');
  });

  test('should classify deep reasoning tasks to deepseek-r1:7b', () => {
    const mockProvider = new MockLLMProvider();
    const provisioner = new ModelProvisioner(mockProvider);

    const c1 = provisioner.classifyTask('Why does quantum entanglement violate classical locality? Calculate probability');
    assert.equal(c1.model, 'deepseek-r1:7b');
    assert.equal(c1.category, 'reasoning');
  });

  test('should classify casual chat to qwen2.5:7b', () => {
    const mockProvider = new MockLLMProvider();
    const provisioner = new ModelProvisioner(mockProvider);

    const c1 = provisioner.classifyTask('Hello Jarvis, how are you today?');
    assert.equal(c1.model, 'qwen2.5:7b');
    assert.equal(c1.category, 'chat');
  });

  test('should dispatch immediately if model is already installed', async () => {
    const mockProvider = new MockLLMProvider();
    mockProvider.listModels = async () => ['qwen2.5-coder:7b', 'qwen2.5:7b'];

    let switchedTo = '';
    mockProvider.setModel = (m) => {
      switchedTo = m;
    };

    const provisioner = new ModelProvisioner(mockProvider);
    const decision = await provisioner.ensureAndDispatch({
      prompt: 'Write a quick PowerShell script',
    });

    assert.equal(decision.targetModel, 'qwen2.5-coder:7b');
    assert.equal(decision.wasInstalledOnDemand, false);
    assert.equal(switchedTo, 'qwen2.5-coder:7b');
  });

  test('should auto-pull model on-demand when missing and report progress', async () => {
    const mockProvider = new MockLLMProvider();
    // Simulate deepseek-r1:7b not yet installed
    mockProvider.listModels = async () => ['qwen2.5:7b'];

    let pulledModel = '';
    mockProvider.pullModel = async (name: string) => {
      pulledModel = name;
      return true;
    };

    const progressMessages: string[] = [];
    const provisioner = new ModelProvisioner(mockProvider);

    const decision = await provisioner.ensureAndDispatch({
      prompt: 'Calculate the mathematical probability of three independent coin flips',
      onProgress: (msg) => {
        progressMessages.push(msg);
      },
    });

    assert.equal(decision.targetModel, 'deepseek-r1:7b');
    assert.equal(decision.wasInstalledOnDemand, true);
    assert.equal(pulledModel, 'deepseek-r1:7b');
    assert.ok(progressMessages.length >= 2);
    assert.ok(progressMessages[0].includes('Auto-downloading'));
    assert.ok(progressMessages[1].includes('installed successfully'));
  });

  test('should escalate precise work to 30B-class model qwen2.5-coder:32b', () => {
    const mockProvider = new MockLLMProvider();
    const provisioner = new ModelProvisioner(mockProvider);

    const c1 = provisioner.classifyTask('Design a full architecture system blueprint with multi-file precision engineering');
    assert.equal(c1.model, 'qwen2.5-coder:32b');
    assert.equal(c1.category, 'precision');
    assert.equal(c1.is30BClass, true);

    const c2 = provisioner.classifyTask('I need a precise production grade implementation of the consensus engine');
    assert.equal(c2.model, 'qwen2.5-coder:32b');
    assert.equal(c2.category, 'precision');
    assert.equal(c2.is30BClass, true);
  });
});
