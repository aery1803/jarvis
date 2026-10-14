/**
 * Unit Tests: reasoning-block filter (`<think>` ... `</think>`)
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ThinkStreamFilter, stripThinking } from '../src/chat/thinking.js';

function run(chunks: string[]): { shown: string; unterminated: boolean; hadThinking: boolean } {
  const filter = new ThinkStreamFilter();
  let shown = '';
  for (const chunk of chunks) shown += filter.push(chunk);
  shown += filter.end();
  return { shown, unterminated: filter.unterminated, hadThinking: filter.hadThinking };
}

/** Every way of cutting `text` into two chunks, and into single characters. */
function everySplit(text: string): string[][] {
  const splits: string[][] = [[...text]];
  for (let at = 0; at <= text.length; at++) splits.push([text.slice(0, at), text.slice(at)]);
  return splits;
}

describe('ThinkStreamFilter', () => {
  test('removes a block and the blank line after it, however the tags are split across chunks', () => {
    for (const chunks of everySplit('<think>I should add them</think>\n\nThe answer is 4.')) {
      assert.equal(run(chunks).shown, 'The answer is 4.', JSON.stringify(chunks));
    }
  });

  test('text before a block is kept, and several blocks are all removed', () => {
    for (const chunks of everySplit('Sure. <think>a</think>Part one. <think>b</think> Part two.')) {
      assert.equal(run(chunks).shown, 'Sure. Part one. Part two.', JSON.stringify(chunks));
    }
  });

  test('tags are matched case-insensitively', () => {
    assert.equal(run(['<THINK>x</Think>Hello']).shown, 'Hello');
  });

  test('an unterminated block at the end of the stream is dropped and flagged', () => {
    const out = run(['Hello. <think>and then I', ' kept thinking']);
    assert.equal(out.shown, 'Hello. ');
    assert.equal(out.unterminated, true);
    assert.equal(out.hadThinking, true);
  });

  test('a lone "<" or "<thi" at the very end that never becomes a tag is released, not lost', () => {
    assert.equal(run(['1 <', ' 2']).shown, '1 < 2');
    assert.equal(run(['x <thi']).shown, 'x <thi');
    assert.equal(run(['x <thi', 'nk> y']).shown, 'x ');
  });

  test('a tag-like string that is not the tag is left alone', () => {
    assert.equal(run(['use <thinker> here']).shown, 'use <thinker> here');
    assert.equal(run(['a </think> b']).shown, 'a </think> b', 'a stray closing tag is text');
  });

  test('plain text passes through unchanged and nothing is held back at the end', () => {
    const out = run(['Hello ', 'there.']);
    assert.equal(out.shown, 'Hello there.');
    assert.equal(out.hadThinking, false);
  });
});

describe('stripThinking', () => {
  test('removes closed blocks and an unclosed trailing one', () => {
    assert.equal(stripThinking('<think>a</think>Answer'), 'Answer');
    assert.equal(stripThinking('Answer <think>trailing'), 'Answer ');
    assert.equal(stripThinking('<think>only reasoning'), '');
    assert.equal(stripThinking('no tags'), 'no tags');
  });
});
