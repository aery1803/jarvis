/**
 * Unit Tests: LLM Provider Interface
 * Authority: Section 7.5, Section 18.1
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  GeminiProvider,
  HybridProvider,
  MockLLMProvider,
  OllamaProvider,
  readSseData,
  DEFAULT_CONTEXT_TOKENS,
  type GenerationUsage,
  type PullProgress,
} from '../src/services/provider.js';

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

describe('OllamaProvider request contract', () => {
  type Handler = (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void | Promise<void>;

  async function withServer<T>(handler: Handler, run: (baseUrl: string, seen: Array<{ url: string; body: string }>) => Promise<T>): Promise<T> {
    const seen: Array<{ url: string; body: string }> = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ url: req.url ?? '', body });
        Promise.resolve(handler(req, body, res)).catch(() => res.destroy());
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      return await run(`http://127.0.0.1:${port}`, seen);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  const doneLine =
    '{"response":"","done":true,"prompt_eval_count":1200,"eval_count":50,"total_duration":3000000000,"load_duration":100000000,"prompt_eval_duration":500000000,"eval_duration":2000000000}\n';

  test('done_reason "length" is reported as a truncated generation; "stop" is not', async () => {
    const lengthLine = '{"response":"","done":true,"done_reason":"length","prompt_eval_count":10,"eval_count":2048}\n';
    const stopLine = '{"response":"","done":true,"done_reason":"stop","prompt_eval_count":10,"eval_count":12}\n';
    for (const [line, truncated] of [[lengthLine, true], [stopLine, false]] as const) {
      await withServer(
        (_req, _body, res) => {
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
          res.write('{"response":"The steps are","done":false}\n');
          res.end(line);
        },
        async (baseUrl) => {
          const provider = new OllamaProvider({ baseUrl, model: 'test:1b' });
          const usages: GenerationUsage[] = [];
          for await (const _c of provider.generateStream('p', { maxTokens: 2048, onUsage: (u) => usages.push(u) })) {
            // drain
          }
          assert.equal(usages[0].truncated, truncated ? true : undefined);
          assert.equal(usages[0].doneReason, truncated ? 'length' : 'stop');
        }
      );
    }
  });

  test('a done line with no counts but done_reason "length" still reports the truncation', async () => {
    await withServer(
      (_req, _body, res) => {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.end('{"response":"cut","done":false}\n{"response":"","done":true,"done_reason":"length"}\n');
      },
      async (baseUrl) => {
        const usages: GenerationUsage[] = [];
        for await (const _c of new OllamaProvider({ baseUrl, model: 'test:1b' }).generateStream('p', { onUsage: (u) => usages.push(u) })) {
          // drain
        }
        assert.equal(usages.length, 1);
        assert.equal(usages[0].truncated, true);
        assert.equal(usages[0].completionTokens, 0, 'no counts are invented');
      }
    );
  });

  test('without a done_reason, producing as many tokens as the limit allowed counts as truncated', async () => {
    await withServer(
      (_req, _body, res) => {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.end('{"response":"x","done":false}\n{"response":"","done":true,"prompt_eval_count":5,"eval_count":300}\n');
      },
      async (baseUrl) => {
        const usages: GenerationUsage[] = [];
        for await (const _c of new OllamaProvider({ baseUrl, model: 'test:1b' }).generateStream('p', { maxTokens: 300, onUsage: (u) => usages.push(u) })) {
          // drain
        }
        assert.equal(usages[0].truncated, true);
      }
    );
  });

  test('generateStream sends num_ctx (default and caller-supplied) and reports real usage from the done line', async () => {
    await withServer(
      (_req, _body, res) => {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write('{"response":"hi","done":false}\n');
        res.end(doneLine);
      },
      async (baseUrl, seen) => {
        const provider = new OllamaProvider({ baseUrl, model: 'test:1b' });
        const usages: GenerationUsage[] = [];
        for await (const _c of provider.generateStream('p', { onUsage: (u) => usages.push(u) })) {
          // drain
        }
        const usage = usages[0];
        assert.equal(JSON.parse(seen[0].body).options.num_ctx, DEFAULT_CONTEXT_TOKENS);
        assert.deepEqual(usage, {
          model: 'test:1b',
          promptTokens: 1200,
          completionTokens: 50,
          totalDurationMs: 3000,
          evalDurationMs: 2000,
          promptEvalDurationMs: 500,
          loadDurationMs: 100,
          tokensPerSec: 25,
        });

        await provider.generate('p', { contextTokens: 32768 });
        assert.equal(JSON.parse(seen[1].body).options.num_ctx, 32768);
      }
    );
  });

  test('generateStream rejects when the stream ends without a done line', async () => {
    await withServer(
      (_req, _body, res) => {
        res.writeHead(200);
        res.end('{"response":"partial","done":false}\n');
      },
      async (baseUrl) => {
        const provider = new OllamaProvider({ baseUrl, model: 'test:1b' });
        await assert.rejects(provider.generate('p'), /ended before the final done/);
      }
    );
  });

  test('generate rejects on an HTTP error instead of returning an empty string', async () => {
    await withServer(
      (_req, _body, res) => {
        res.writeHead(500, 'Internal Error');
        res.end('boom');
      },
      async (baseUrl) => {
        const provider = new OllamaProvider({ baseUrl, model: 'test:1b' });
        await assert.rejects(provider.generate('p'), /Ollama error 500/);
      }
    );
  });

  test('chat sends num_ctx, reports usage, and honours an abort signal', async () => {
    await withServer(
      async (_req, body, res) => {
        if (JSON.parse(body).messages[0].content === 'slow') {
          await new Promise((r) => setTimeout(r, 2000));
          res.end('{}');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: { content: 'ok' }, prompt_eval_count: 7, eval_count: 3, eval_duration: 1000000000 }));
      },
      async (baseUrl, seen) => {
        const provider = new OllamaProvider({ baseUrl, model: 'test:1b' });
        const usages: GenerationUsage[] = [];
        const out = await provider.chat([{ role: 'user', content: 'hi' }], { contextTokens: 8192, onUsage: (u) => usages.push(u) });
        const usage = usages[0];
        assert.equal(out, 'ok');
        assert.equal(JSON.parse(seen[0].body).options.num_ctx, 8192);
        assert.equal(usage?.promptTokens, 7);
        assert.equal(usage?.completionTokens, 3);

        const controller = new AbortController();
        const pending = provider.chat([{ role: 'user', content: 'slow' }], { signal: controller.signal });
        setTimeout(() => controller.abort(), 20);
        await assert.rejects(pending, /abort/i);
      }
    );
  });

  test('chat times out via timeoutMs', async () => {
    await withServer(
      async (_req, _body, res) => {
        await new Promise((r) => setTimeout(r, 1000));
        res.end('{}');
      },
      async (baseUrl) => {
        const provider = new OllamaProvider({ baseUrl, model: 'test:1b' });
        await assert.rejects(provider.chat([{ role: 'user', content: 'x' }], { timeoutMs: 30 }));
      }
    );
  });

  test('listModels returns installed names; on failure it returns [] while listModelsStrict throws', async () => {
    await withServer(
      (_req, _body, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: 'qwen3:8b', size: 5225388164 }, { name: 'qwen3:14b', size: 9276198565 }] }));
      },
      async (baseUrl) => {
        const provider = new OllamaProvider({ baseUrl });
        assert.deepEqual(await provider.listModels(), ['qwen3:8b', 'qwen3:14b']);
        const detailed = await provider.listInstalledModels();
        assert.equal(detailed[1].sizeBytes, 9276198565);
      }
    );

    await withServer(
      (_req, _body, res) => {
        res.writeHead(503, 'Unavailable');
        res.end();
      },
      async (baseUrl) => {
        const provider = new OllamaProvider({ baseUrl, model: 'qwen3:8b' });
        assert.deepEqual(await provider.listModels(), []);
        await assert.rejects(provider.listModelsStrict(), /HTTP 503/);
      }
    );

    const dead = new OllamaProvider({ baseUrl: 'http://127.0.0.1:1' });
    assert.deepEqual(await dead.listModels(), []);
    await assert.rejects(dead.listModelsStrict());
  });

  test('pullModel streams progress, returns true only on success, and reports error lines as false', async () => {
    await withServer(
      (_req, body, res) => {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        if (JSON.parse(body).name === 'bad:1b') {
          res.end('{"status":"pulling manifest"}\n{"error":"pull model manifest: file does not exist"}\n');
          return;
        }
        res.write('{"status":"pulling manifest"}\n');
        res.write('{"status":"pulling abc","total":1000,"completed":250}\n');
        res.write('{"status":"pulling abc","total":1000,"completed":1000}\n');
        res.end('{"status":"success"}\n');
      },
      async (baseUrl, seen) => {
        const provider = new OllamaProvider({ baseUrl });
        const progress: PullProgress[] = [];
        assert.equal(await provider.pullModel('qwen3:8b', { onProgress: (p) => progress.push(p) }), true);
        assert.equal(JSON.parse(seen[0].body).stream, true);
        assert.equal(progress[1].percent, 25);
        assert.equal(progress[progress.length - 1].status, 'success');
        assert.equal(await provider.pullModel('bad:1b'), false);
      }
    );
  });

  test('pullModel honours abort and timeout and never throws', async () => {
    await withServer(
      async (_req, _body, res) => {
        res.writeHead(200);
        res.write('{"status":"pulling manifest"}\n');
        await new Promise((r) => setTimeout(r, 2000));
        res.end();
      },
      async (baseUrl) => {
        const provider = new OllamaProvider({ baseUrl });
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 30);
        assert.equal(await provider.pullModel('x:1b', { signal: controller.signal }), false);
        assert.equal(await provider.pullModel('x:1b', { timeoutMs: 30 }), false);
      }
    );
  });
});

describe('GeminiProvider', () => {
  test('sends the API key in x-goog-api-key and never in the URL', async () => {
    const realFetch = globalThis.fetch;
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      calls.push({ url: String(input), headers: init?.headers as Record<string, string> });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'hello' }] } }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 } }), {
        status: 200,
      });
    }) as typeof fetch;
    try {
      const provider = new GeminiProvider({ apiKey: 'test-key-123', model: 'gemini-2.0-flash' });
      let promptTokens = 0;
      assert.equal(await provider.generate('hi', { onUsage: (u) => (promptTokens = u.promptTokens) }), 'hello');
      await provider.chat([
        { role: 'system', content: 's' },
        { role: 'user', content: 'u' },
      ]);
      assert.equal(promptTokens, 4);
      for (const call of calls) {
        assert.ok(!call.url.includes('test-key-123'), 'key must not appear in the URL');
        assert.ok(!call.url.includes('key='));
        assert.equal(call.headers['x-goog-api-key'], 'test-key-123');
      }
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('without a key it lists no models and refuses to generate', async () => {
    const provider = new GeminiProvider({ apiKey: '' });
    const saved = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      assert.deepEqual(await new GeminiProvider({ apiKey: '' }).listModels(), []);
      await assert.rejects(provider.generate('x'), /GEMINI_API_KEY/);
    } finally {
      if (saved !== undefined) process.env.GEMINI_API_KEY = saved;
    }
  });
});

describe('HybridProvider abort handling', () => {
  test('does not fall back to local when the caller aborted', async () => {
    const cloud = new MockLLMProvider();
    cloud.generate = async () => {
      throw new Error('aborted by caller');
    };
    const hybrid = new HybridProvider({ localProvider: new MockLLMProvider({ cannedResponse: 'local' }), cloudProvider: cloud, preferCloud: true });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(hybrid.generate('x', { signal: controller.signal }), /aborted/);
  });
});
