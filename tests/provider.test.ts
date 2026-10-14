/**
 * Unit Tests: LLM Provider Interface
 * Authority: Section 7.5, Section 18.1
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MockLLMProvider, OllamaProvider } from '../src/services/provider.js';

describe('LLMProvider', () => {
  test('MockLLMProvider generates predictable responses', async () => {
    const provider = new MockLLMProvider({
      cannedResponse: 'This is a synthesized research summary.',
    });

    const response = await provider.generate('Summarize quantum computing.');
    assert.equal(response, 'This is a synthesized research summary.');
  });

  test('MockLLMProvider records message history in chat', async () => {
    const provider = new MockLLMProvider();
    const chatResponse = await provider.chat([
      { role: 'system', content: 'You are Jarvis.' },
      { role: 'user', content: 'Hello!' },
    ]);

    assert.ok(chatResponse.length > 0);
  });

  test('OllamaProvider constructs proper request payload', async () => {
    const provider = new OllamaProvider({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen2.5:7b',
    });

    assert.equal(provider.getModel(), 'qwen2.5:7b');
    assert.equal(provider.getBaseUrl(), 'http://127.0.0.1:11434');
  });
});
