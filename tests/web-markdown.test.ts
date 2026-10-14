/**
 * Unit Tests: Web UI Markdown Renderer
 * Authority: FEAT-004
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { formatFinalMarkdown, formatMarkdown, formatStreamingMarkdown, splitStableMarkdown } from '../src/web/public/markdown.js';

function countOf(haystack: string, pattern: RegExp): number {
  return (haystack.match(pattern) ?? []).length;
}

function assertBalanced(html: string): void {
  for (const tag of ['pre', 'code', 'p', 'ul', 'ol', 'li', 'blockquote', 'strong', 'em', 'div', 'h2']) {
    assert.equal(countOf(html, new RegExp(`<${tag}[\\s>]`, 'g')), countOf(html, new RegExp(`</${tag}>`, 'g')), `unbalanced <${tag}> in ${html}`);
  }
}

describe('formatMarkdown', () => {
  test('a fenced code block keeps its indentation and newlines, with no <br> inside', () => {
    const code = 'function f() {\n    if (x) {\n        return 1;\n    }\n}';
    const html = formatMarkdown(`Here:\n\n\`\`\`ts\n${code}\n\`\`\`\n\nDone.`);
    const match = html.match(/<pre><code[^>]*>([\s\S]*?)<\/code><\/pre>/);
    assert.ok(match, html);
    assert.equal(match[1], code);
    assert.ok(!match[1].includes('<br>'));
  });

  test('markdown markers inside code are left alone', () => {
    const html = formatMarkdown('```\nconst a = b * c * d; // **not bold**\n```\nUse `a_b_c` and `**x**`.');
    assert.ok(html.includes('const a = b * c * d; // **not bold**'));
    assert.ok(html.includes('<code>a_b_c</code>'));
    assert.ok(html.includes('<code>**x**</code>'));
    assert.ok(!html.includes('<strong>not bold</strong>'));
  });

  test('a heading becomes <h2>', () => {
    assert.equal(formatMarkdown('## Summary'), '<h2>Summary</h2>');
  });

  test('a bullet list becomes <ul><li>, and an ordered list becomes <ol><li>', () => {
    assert.equal(formatMarkdown('- one\n- **two**\n+ three'), '<ul><li>one</li><li><strong>two</strong></li><li>three</li></ul>');
    assert.equal(formatMarkdown('1. first\n2. second'), '<ol><li>first</li><li>second</li></ol>');
  });

  test('blockquotes and paragraphs, with <br> only inside a paragraph', () => {
    assert.equal(formatMarkdown('> quoted\n> more'), '<blockquote><p>quoted<br>more</p></blockquote>');
    assert.equal(formatMarkdown('line one\nline two\n\nnext'), '<p>line one<br>line two</p><p>next</p>');
  });

  test('bold, italics and links', () => {
    assert.equal(
      formatMarkdown('**b** and *i* and [site](https://example.com/a_b)'),
      '<p><strong>b</strong> and <em>i</em> and <a href="https://example.com/a_b" target="_blank" rel="noopener noreferrer">site</a></p>'
    );
  });

  test('arithmetic asterisks and snake_case are not treated as emphasis', () => {
    assert.equal(formatMarkdown('2 * 3 * 4 = 24 in my_var_name'), '<p>2 * 3 * 4 = 24 in my_var_name</p>');
  });

  test('HTML in model output is escaped, so it renders as visible text', () => {
    const html = formatMarkdown('<script>alert(1)</script>\n<img src=x onerror="alert(2)">\n[x](javascript:alert(3))');
    assert.ok(!html.includes('<script'));
    assert.ok(!html.includes('<img'));
    assert.ok(!html.includes('href="javascript:'));
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(html.includes('&lt;img src=x onerror=&quot;alert(2)&quot;&gt;'));
  });

  test('HTML inside a code block is escaped too', () => {
    const html = formatMarkdown('```html\n<b onclick="x()">hi</b>\n```');
    assert.ok(html.includes('&lt;b onclick=&quot;x()&quot;&gt;hi&lt;/b&gt;'));
    assert.ok(!html.includes('<b '));
  });

  test('code blocks get a copy button', () => {
    assert.ok(formatMarkdown('```\nx\n```').includes('class="copy-code-btn"'));
  });
});

describe('emphasis nesting', () => {
  test('crossed or interleaved delimiters never produce mis-nested tags', () => {
    const samples = ['**a *b** c*', '*a **b* c**', '__a _b__ c_', '**bold *and italic* still bold**', '*x* **y** *z*', '***both***', '**a** and *b **c***', '**unclosed *x*'];
    for (const sample of samples) {
      const html = formatMarkdown(sample);
      assertBalanced(html);
      assert.ok(!/<strong>[^<]*<em>[^<]*<\/strong>/.test(html), html);
      assert.ok(!/<em>[^<]*<strong>[^<]*<\/em>/.test(html), html);
    }
    assert.equal(formatMarkdown('**bold *and italic* still bold**'), '<p><strong>bold <em>and italic</em> still bold</strong></p>');
  });
});

describe('formatFinalMarkdown', () => {
  test('a reply truncated inside a code fence stays a code block, not literal backticks', () => {
    const html = formatFinalMarkdown('Here:\n```ts\nconst a = 1;');
    assert.ok(!html.includes('```'), html);
    assert.ok(html.includes('const a = 1;'));
    assertBalanced(html);
  });

  test('a complete reply renders exactly like formatMarkdown', () => {
    const text = 'Done **now**.\n\n```\nx\n```';
    assert.equal(formatFinalMarkdown(text), formatMarkdown(text));
  });
});

describe('formatStreamingMarkdown', () => {
  test('partial text ending in an opening fence does not produce broken markup', () => {
    for (const partial of ['Here is code:\n```', 'Here is code:\n```ts', 'Here is code:\n```ts\nconst a = 1;\n  if (a) {']) {
      const html = formatStreamingMarkdown(partial);
      assert.ok(!html.includes('```'), html);
      assertBalanced(html);
      assert.ok(html.startsWith('<p>Here is code:</p>'), html);
    }
  });

  test('the in-progress code keeps its indentation while the fence is open', () => {
    const html = formatStreamingMarkdown('```ts\nconst a = 1;\n  if (a) {');
    assert.ok(html.includes('const a = 1;\n  if (a) {'), html);
  });

  test('an unclosed inline marker on the last line is shown as plain text, not half-formatted', () => {
    const { stable, tail } = splitStableMarkdown('Intro line\nThis is **bol');
    assert.equal(stable, 'Intro line\n');
    assert.equal(tail, 'This is **bol');
    const html = formatStreamingMarkdown('Intro line\nThis is **bol');
    assert.ok(html.includes('This is **bol'));
    assertBalanced(html);
  });

  test('complete text renders the same as formatMarkdown', () => {
    const text = '## Title\n\n- a\n- b\n\n```\ncode\n```\n';
    assert.equal(formatStreamingMarkdown(text), formatMarkdown(text));
  });
});
