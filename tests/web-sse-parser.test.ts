/**
 * Unit Tests: Browser SSE Frame Parser
 * Authority: FEAT-004
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createSseParser } from '../src/web/public/sse.js';

function frames(chunks: string[]): string {
  return chunks.map((chunk) => `data: ${JSON.stringify({ chunk })}\n\n`).join('') + 'data: [DONE]\n\n';
}

function splitEvery(bytes: Uint8Array, size: number): Uint8Array[] {
  const parts: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) parts.push(bytes.subarray(i, i + size));
  return parts;
}

function assemble(parts: Uint8Array[]): { text: string; done: boolean } {
  const parser = createSseParser();
  let text = '';
  let done = false;
  const handle = (payload: string) => {
    if (payload === '[DONE]') {
      done = true;
      return;
    }
    text += JSON.parse(payload).chunk;
  };
  for (const part of parts) parser.push(part).forEach(handle);
  parser.end().forEach(handle);
  return { text, done };
}

describe('createSseParser', () => {
  const pieces = ['Héllo ', 'wörld ', '☃ ', '日本語 ', '🙂 emoji ', 'end.'];
  const expected = pieces.join('');
  const bytes = new TextEncoder().encode(frames(pieces));

  test('reassembles text exactly when split mid-frame and mid-multi-byte-character, at every chunk size', () => {
    for (let size = 1; size <= 17; size++) {
      const result = assemble(splitEvery(bytes, size));
      assert.equal(result.text, expected, `chunk size ${size}`);
      assert.equal(result.done, true);
    }
  });

  test('a split specifically inside a 4-byte emoji is reassembled', () => {
    const emojiAt = Buffer.from(bytes).indexOf(Buffer.from('🙂'));
    const result = assemble([bytes.subarray(0, emojiAt + 2), bytes.subarray(emojiAt + 2)]);
    assert.equal(result.text, expected);
  });

  test('incomplete frames are held back until the separator arrives', () => {
    const parser = createSseParser();
    const enc = new TextEncoder();
    assert.deepEqual(parser.push(enc.encode('data: {"chunk":"a"}\n')), []);
    assert.deepEqual(parser.push(enc.encode('\ndata: {"chu')), ['{"chunk":"a"}']);
    assert.deepEqual(parser.push(enc.encode('nk":"b"}\n\n')), ['{"chunk":"b"}']);
  });

  test('comment lines and CRLF separators are handled', () => {
    const parser = createSseParser();
    const out = parser.push(new TextEncoder().encode(': ping\r\n\r\ndata: {"chunk":"x"}\r\n\r\n'));
    assert.deepEqual(out, ['{"chunk":"x"}']);
  });
});
