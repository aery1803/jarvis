/**
 * Unit Tests: SearXNG Search Service
 * Authority: Section 10, Section 18.1
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SearXNGClient } from '../src/services/searxng.js';
import { config } from '../src/config.js';

describe('SearXNGClient', () => {
  test('should parse raw SearXNG JSON response into normalized SearchResult list', () => {
    const client = new SearXNGClient({ baseUrl: 'http://localhost:8080' });

    const rawJson = {
      query: 'AMD Radeon 8060S memory',
      results: [
        {
          title: 'ASUS ROG Flow Z13 Specifications',
          url: 'https://rog.asus.com/flow-z13',
          content: 'The 2025 ROG Flow Z13 features AMD Ryzen AI Max+ 395 and Radeon 8060S.',
          engine: 'google',
        },
        {
          title: 'AMD Strix Halo Technical Overview',
          url: 'https://anandtech.com/strix-halo',
          content: 'UMA memory architecture dynamically provides up to 54GB VRAM.',
          engine: 'bing',
        },
      ],
    };

    const parsed = client.parseResults(rawJson);
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].title, 'ASUS ROG Flow Z13 Specifications');
    assert.equal(parsed[0].url, 'https://rog.asus.com/flow-z13');
    assert.equal(parsed[1].engine, 'bing');
  });

  const ddgHtml = `
    <div class="result results_links results_links_deep web-result">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fgold&amp;rut=abc">Gold <b>price</b> today</a>
      <a class="result__snippet" href="x">Gold is &amp; trading at 1,000.</a>
    </div>
    <div class="result results_links result--ad">
      <a class="result__a" href="https://ads.example/x">Ad</a><a class="result__snippet" href="x">buy</a>
    </div>
    <div class="result results_links results_links_deep web-result">
      <a class="result__a" href="javascript:alert(1)">Bad scheme</a>
      <a class="result__snippet" href="x">nope</a>
    </div>`;

  function fakeFetch(handlers: { searxng?: () => Response | Promise<Response>; ddg?: () => Response | Promise<Response> }) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const impl = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes('duckduckgo.com')) {
        if (!handlers.ddg) throw new Error('ddg offline');
        return handlers.ddg();
      }
      if (!handlers.searxng) throw new Error('connect ECONNREFUSED');
      return handlers.searxng();
    }) as typeof fetch;
    return { impl, calls };
  }

  test('returns SearXNG results labelled source searxng and skips results without an http(s) url', async () => {
    const { impl } = fakeFetch({
      searxng: () =>
        new Response(
          JSON.stringify({ results: [{ title: 'A', url: 'https://a.example/x', content: 'c', engine: 'google' }, { title: 'B', url: 'file:///etc/passwd' }, { title: 'C' }] }),
          { status: 200 }
        ),
    });
    const client = new SearXNGClient({ fetchImpl: impl });
    const outcome = await client.searchDetailed('q');
    assert.equal(outcome.source, 'searxng');
    assert.deepEqual(outcome.results.map((r) => r.url), ['https://a.example/x']);
  });

  test('never fabricates results: offline with the live fallback disabled gives [] and a typed reason', async () => {
    const { impl, calls } = fakeFetch({});
    const client = new SearXNGClient({ enableLiveFallback: false, fetchImpl: impl });
    assert.deepEqual(await client.search('local AI agent architecture'), []);
    const outcome = await client.searchDetailed('local AI agent architecture');
    assert.equal(outcome.source, 'none');
    assert.match(outcome.unavailableReason ?? '', /live web fallback is disabled/);
    assert.ok(calls.every((c) => !c.url.includes('duckduckgo')));
  });

  test('live fallback labels results duckduckgo-live, sends only the query, and resolves redirect urls', async () => {
    const { impl, calls } = fakeFetch({ ddg: () => new Response(ddgHtml, { status: 200 }) });
    const client = new SearXNGClient({ enableLiveFallback: true, fetchImpl: impl });
    const outcome = await client.searchDetailed('gold   price today');
    assert.equal(outcome.source, 'duckduckgo-live');
    assert.equal(outcome.results.length, 1);
    assert.deepEqual(outcome.results[0], {
      title: 'Gold price today',
      url: 'https://example.com/gold',
      snippet: 'Gold is & trading at 1,000.',
      engine: 'duckduckgo-live',
    });
    const ddgCall = calls.find((c) => c.url.includes('duckduckgo.com'))!;
    assert.equal(ddgCall.url, 'https://html.duckduckgo.com/html/?q=gold%20price%20today');
    const headers = ddgCall.init?.headers as Record<string, string>;
    assert.ok(!/Mozilla|Chrome/.test(headers['User-Agent']));
    assert.equal(ddgCall.init?.method, undefined);
    assert.equal(ddgCall.init?.body, undefined);
  });

  test('both engines down returns [] with both errors reported', async () => {
    const { impl } = fakeFetch({});
    const outcome = await new SearXNGClient({ enableLiveFallback: true, fetchImpl: impl }).searchDetailed('x');
    assert.deepEqual(outcome.results, []);
    assert.equal(outcome.source, 'none');
    assert.match(outcome.liveError ?? '', /ddg offline/);
    assert.match(outcome.searxngError ?? '', /ECONNREFUSED/);
  });

  test('enableFallback false rethrows the SearXNG failure', async () => {
    const { impl } = fakeFetch({});
    await assert.rejects(new SearXNGClient({ enableFallback: false, fetchImpl: impl }).search('x'), /ECONNREFUSED/);
  });

  test('a bare client takes its live-fallback default from config.searchLiveFallback (off unless the owner enabled it)', async () => {
    const saved = config.searchLiveFallback;
    try {
      config.searchLiveFallback = false;
      const off = fakeFetch({ ddg: () => new Response(ddgHtml, { status: 200 }) });
      const outcome = await new SearXNGClient({ fetchImpl: off.impl }).searchDetailed('x');
      assert.equal(outcome.source, 'none');
      assert.ok(off.calls.every((c) => !c.url.includes('duckduckgo')));

      config.searchLiveFallback = true;
      const on = fakeFetch({ ddg: () => new Response(ddgHtml, { status: 200 }) });
      assert.equal((await new SearXNGClient({ fetchImpl: on.impl }).searchDetailed('x')).source, 'duckduckgo-live');
    } finally {
      config.searchLiveFallback = saved;
    }
  });
});
