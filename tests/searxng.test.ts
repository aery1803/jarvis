/**
 * Unit Tests: SearXNG Search Service
 * Authority: Section 10, Section 18.1
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SearXNGClient } from '../src/services/searxng.js';

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

  test('should return mock results when fallback is enabled and service is offline', async () => {
    const client = new SearXNGClient({
      baseUrl: 'http://127.0.0.1:9999', // unreachable port
      enableFallback: true,
    });

    const results = await client.search('local AI agent architecture');
    assert.ok(results.length > 0);
    assert.match(results[0].title, /local AI agent/i);
  });
});
