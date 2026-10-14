/**
 * Unit Tests: LLM Provider Interface
 * Authority: Section 7.5, Section 18.1
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { MockLLMProvider, OllamaProvider, readSseData } from '../src/services/provider.js';

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

describe('OllamaProvider streaming', () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  async function withFakeOllama<T>(
    script: (res: http.ServerResponse) => Promise<void>,
    run: (baseUrl: string, requests: string[]) => Promise<T>
  ): Promise<T> {
    const requests: string[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        requests.push(body);
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        script(res).catch(() => res.destroy());
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      return await run(`http://127.0.0.1:${port}`, requests);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  const threeLines = async (res: http.ServerResponse) => {
    res.write('{"response":"Hello","done":false}\n');
    await sleep(30);
    res.write('{"response":" wor","done":false}\n');
    await sleep(30);
    res.write('{"response":"ld","done":false}\n');
    await sleep(30);
    res.end('{"response":"","done":true}\n');
  };

  test('generateStream yields one chunk per line, incrementally, and nothing for the done object', async () => {
    await withFakeOllama(threeLines, async (baseUrl, requests) => {
      const provider = new OllamaProvider({ baseUrl, model: 'test:1b' });
      const arrivals: number[] = [];
      const chunks: string[] = [];
      const start = Date.now();
      for await (const chunk of provider.generateStream('hi', { maxTokens: 16 })) {
        chunks.push(chunk);
        arrivals.push(Date.now() - start);
      }
      assert.deepEqual(chunks, ['Hello', ' wor', 'ld']);
      assert.ok(arrivals[2] - arrivals[0] >= 40, 'chunks must arrive incrementally, not in one burst');
      assert.equal(JSON.parse(requests[0]).stream, true);
    });
  });

  test('generateStream reassembles a line split across network chunks and a split multi-byte character', async () => {
    const raw = Buffer.from('{"response":"café ☃ ok","done":false}\n', 'utf8');
    const snowman = raw.indexOf(Buffer.from('☃'));
    await withFakeOllama(
      async (res) => {
        res.write(raw.subarray(0, 20));
        await sleep(20);
        res.write(raw.subarray(20, snowman + 1)); // ends mid-character
        await sleep(20);
        res.write(raw.subarray(snowman + 1));
        await sleep(20);
        res.end('{"response":"","done":true}\n');
      },
      async (baseUrl) => {
        const provider = new OllamaProvider({ baseUrl, model: 'test:1b' });
        const chunks: string[] = [];
        for await (const chunk of provider.generateStream('hi')) chunks.push(chunk);
        assert.deepEqual(chunks, ['café ☃ ok']);
      }
    );
  });

  test('generate() returns the concatenation of the stream', async () => {
    await withFakeOllama(threeLines, async (baseUrl) => {
      const provider = new OllamaProvider({ baseUrl, model: 'test:1b' });
      assert.equal(await provider.generate('hi'), 'Hello world');
    });
  });

  test('generateStream surfaces an Ollama mid-stream error line', async () => {
    await withFakeOllama(
      async (res) => {
        res.end('{"response":"a"}\n{"error":"model crashed"}\n');
      },
      async (baseUrl) => {
        const provider = new OllamaProvider({ baseUrl, model: 'test:1b' });
        await assert.rejects(async () => {
          for await (const _chunk of provider.generateStream('hi')) {
            // drain
          }
        }, /model crashed/);
      }
    );
  });

  test('aborting the signal cancels the HTTP call', async () => {
    let serverSawClose = false;
    await withFakeOllama(
      async (res) => {
        res.on('close', () => (serverSawClose = true));
        res.write('{"response":"first","done":false}\n');
        await sleep(2000);
        res.end();
      },
      async (baseUrl) => {
        const provider = new OllamaProvider({ baseUrl, model: 'test:1b' });
        const controller = new AbortController();
        await assert.rejects(async () => {
          for await (const _chunk of provider.generateStream('hi', { signal: controller.signal })) {
            controller.abort();
          }
        }, /abort/i);
        await sleep(50);
        assert.equal(serverSawClose, true);
      }
    );
  });

  test('readSseData yields data payloads, ignores other lines, and stops at [DONE]', async () => {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode('data: {"a":1}\n\nda'));
        controller.enqueue(enc.encode('ta: {"a":2}\n\n: keepalive\n\ndata: [DONE]\n\ndata: {"a":3}\n\n'));
        controller.close();
      },
    });
    const out: string[] = [];
    for await (const payload of readSseData(body)) out.push(payload);
    assert.deepEqual(out, ['{"a":1}', '{"a":2}']);
  });
});
