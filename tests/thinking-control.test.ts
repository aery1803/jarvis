/**
 * Unit Tests: thinking control (`think` resolution and the Ollama request field)
 * Every request goes through a stubbed `fetch`; nothing reaches a network or a model.
 */

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { OllamaProvider, resetThinkingSupportCache } from '../src/services/provider.js';
import { parseThinkingMode, resolveThink } from '../src/services/thinking-control.js';

const NEMOTRON = 'rnogy/Nvidia_Llama-3_3-Nemotron-Super-49B-v1_5:q4_K_M';

describe('resolveThink', () => {
  test('off sends think:false to the qwen3 family only', () => {
    for (const model of ['qwen3:8b', 'qwen3:14b', 'qwen3:32b', 'qwen3:72b', 'qwen3.8:27b', 'Qwen3:8B', 'rnogy/qwen3-custom:q4']) {
      assert.equal(resolveThink('off', model), false, model);
    }
    for (const model of ['llama3.2:3b', 'gemma3:12b', 'qwen2.5:7b', 'mock-lane-7b']) {
      assert.equal(resolveThink('off', model), undefined, model);
    }
  });

  test('off leaves reasoning tasks and reasoning lanes on the model default', () => {
    assert.equal(resolveThink('off', 'qwen3:14b', 'reasoning'), undefined);
    assert.equal(resolveThink('off', 'qwen3:32b', 'precision'), undefined);
    assert.equal(resolveThink('off', 'qwen3:8b', 'code'), false);
    assert.equal(resolveThink('off', 'qwen3:8b', 'chat'), false);
    assert.equal(resolveThink('off', 'deepseek-r1:70b'), undefined);
    assert.equal(resolveThink('off', NEMOTRON), undefined);
  });

  test('auto always leaves the default and on always thinks', () => {
    assert.equal(resolveThink('auto', 'qwen3:8b'), undefined);
    assert.equal(resolveThink('auto', 'qwen3:8b', 'chat'), undefined);
    assert.equal(resolveThink('on', 'qwen3:8b'), true);
    assert.equal(resolveThink('on', 'llama3.2:3b', 'chat'), true);
  });

  test('parseThinkingMode accepts only the three modes', () => {
    assert.equal(parseThinkingMode(' ON '), 'on');
    assert.equal(parseThinkingMode('auto'), 'auto');
    assert.equal(parseThinkingMode('off'), 'off');
    assert.equal(parseThinkingMode('maybe'), undefined);
    assert.equal(parseThinkingMode(undefined), undefined);
  });
});

describe('OllamaProvider think field', () => {
  const realFetch = globalThis.fetch;
  const doneLine = '{"response":"OK","done":false}\n{"response":"","done":true,"done_reason":"stop","eval_count":2,"eval_duration":100000000}\n';

  interface Sent {
    url: string;
    body: Record<string, unknown>;
  }

  function stubFetch(respond: (sent: Sent, attempt: number) => Response): Sent[] {
    const sent: Sent[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const entry = { url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> };
      sent.push(entry);
      return respond(entry, sent.length);
    }) as typeof fetch;
    return sent;
  }

  const chatOk = (): Response => new Response(JSON.stringify({ message: { content: 'OK' } }), { status: 200 });
  const rejected = (model: string): Response =>
    new Response(JSON.stringify({ error: `"${model}" does not support thinking` }), { status: 400, statusText: 'Bad Request' });

  afterEach(() => {
    globalThis.fetch = realFetch;
    resetThinkingSupportCache();
  });

  test('think:false reaches /api/generate and /api/chat at the top level, not inside options', async () => {
    const sent = stubFetch((entry) => (entry.url.endsWith('/api/chat') ? chatOk() : new Response(doneLine, { status: 200 })));
    const provider = new OllamaProvider({ baseUrl: 'http://ollama.test', model: 'qwen3:8b' });
    assert.equal(await provider.generate('Reply with only the word OK.', { think: false }), 'OK');
    assert.equal(await provider.chat([{ role: 'user', content: 'hi' }], { think: false }), 'OK');
    assert.equal(sent.length, 2);
    for (const entry of sent) {
      assert.equal(entry.body.think, false);
      assert.ok(!('think' in (entry.body.options as Record<string, unknown>)));
    }
  });

  test('think:true is sent as given, and an undefined think leaves the field out', async () => {
    const sent = stubFetch(() => new Response(doneLine, { status: 200 }));
    const provider = new OllamaProvider({ baseUrl: 'http://ollama.test', model: 'llama3.2:3b' });
    await provider.generate('a', { think: true });
    await provider.generate('b', {});
    assert.equal(sent[0].body.think, true);
    assert.ok(!('think' in sent[1].body));
  });

  test('HTTP 400 "does not support thinking" retries once without think and remembers the model', async () => {
    const sent = stubFetch((entry) => {
      if ('think' in entry.body && entry.body.model === 'gemma3:12b') return rejected('gemma3:12b');
      return entry.url.endsWith('/api/chat') ? chatOk() : new Response(doneLine, { status: 200 });
    });
    const provider = new OllamaProvider({ baseUrl: 'http://ollama.test', model: 'gemma3:12b' });
    assert.equal(await provider.generate('first', { think: false }), 'OK');
    assert.equal(sent.length, 2, 'one rejected attempt and one retry');
    assert.equal(sent[0].body.think, false);
    assert.ok(!('think' in sent[1].body));

    // A fresh provider (they are created per call) still skips the field for this model.
    const again = new OllamaProvider({ baseUrl: 'http://ollama.test', model: 'gemma3:12b' });
    await again.generate('second', { think: false });
    await again.chat([{ role: 'user', content: 'third' }], { think: true });
    assert.equal(sent.length, 4, 'no further rejected attempts');
    assert.ok(!('think' in sent[2].body));
    assert.ok(!('think' in sent[3].body));

    // The memory is per model tag.
    await new OllamaProvider({ baseUrl: 'http://ollama.test', model: 'qwen3:8b' }).generate('other', { think: false });
    assert.equal(sent[4].body.think, false);
    assert.equal(sent.length, 5);
  });

  test('the retry works for /api/chat too', async () => {
    const sent = stubFetch((entry) => ('think' in entry.body ? rejected('gemma3:12b') : chatOk()));
    const provider = new OllamaProvider({ baseUrl: 'http://ollama.test', model: 'gemma3:12b' });
    assert.equal(await provider.chat([{ role: 'user', content: 'hi' }], { think: false }), 'OK');
    assert.equal(sent.length, 2);
  });

  test('any other HTTP 400 is an error, not a silent retry', async () => {
    const sent = stubFetch(() => new Response(JSON.stringify({ error: 'invalid options' }), { status: 400, statusText: 'Bad Request' }));
    const provider = new OllamaProvider({ baseUrl: 'http://ollama.test', model: 'qwen3:8b' });
    await assert.rejects(provider.generate('x', { think: false }), /Ollama error 400/);
    assert.equal(sent.length, 1);
    await provider.generate('y', { think: false }).catch(() => undefined);
    assert.equal(sent[1].body.think, false, 'the model was not marked as unsupported');
  });

  test('a second rejection after the retry is surfaced, not looped', async () => {
    const sent = stubFetch(() => rejected('gemma3:12b'));
    const provider = new OllamaProvider({ baseUrl: 'http://ollama.test', model: 'gemma3:12b' });
    await assert.rejects(provider.generate('x', { think: true }), /Ollama error 400/);
    assert.equal(sent.length, 2);
  });
});
