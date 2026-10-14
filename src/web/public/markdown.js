/**
 * Jarvis Local AI: Safe Markdown renderer for chat bubbles.
 * Authority: FEAT-004
 *
 * Pipeline: code is pulled out into placeholders first, the rest is HTML-escaped, block structure is
 * built line by line, inline rules run on what is left, and code is restored (escaped) last, so no
 * later rule can touch code contents and no model output can inject HTML.
 */

const BLOCK_MARK = '';
const INLINE_CODE_MARK = '';
const LINK_MARK = '';
const FENCE_RE = /^[ \t]*```([^\n`]*)\n([\s\S]*?)^[ \t]*```[ \t]*$/gm;

export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function codeBlockHtml(lang, code) {
  const langClass = /^[\w+-]+$/.test(lang) ? ` class="language-${lang}"` : '';
  return (
    '<div class="code-block"><div class="code-block-header">' +
    `<span class="code-lang">${escapeHtml(lang) || 'text'}</span>` +
    '<button type="button" class="copy-code-btn" aria-label="Copy code">Copy</button></div>' +
    `<pre><code${langClass}>${escapeHtml(code)}</code></pre></div>`
  );
}

function isWellNested(html) {
  const tag = /<(\/?)(strong|em)>/g;
  const open = [];
  for (const match of html.matchAll(tag)) {
    if (!match[1]) {
      open.push(match[2]);
    } else if (open.pop() !== match[2]) {
      return false;
    }
  }
  return open.length === 0;
}

function renderEmphasis(text) {
  // A match whose content would split another tag (crossed delimiters like `**a *b** c*`) stays literal,
  // so the output is always well-formed.
  const wrap = (tagName, lead = '') => (match, ...groups) => {
    const inner = groups[lead ? 1 : 0];
    if (!isWellNested(inner)) return match;
    return `${lead ? groups[0] : ''}<${tagName}>${inner}</${tagName}>`;
  };
  return (
    text
      .replace(/\*\*(?=[^\s*])([^\n]*?[^\s*])\*\*/g, wrap('strong'))
      .replace(/(^|[^\w])__(?=[^\s_])([^\n]*?[^\s_])__(?!\w)/g, wrap('strong', 'lead'))
      // Openers must touch a word and closers must not be followed by one, so `2 * 3 * 4` and
      // `my_var_name` stay literal.
      .replace(/(^|[^\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/g, wrap('em', 'lead'))
      .replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g, wrap('em', 'lead'))
  );
}

function renderInline(text) {
  const links = [];
  // Only http(s) targets become links, so `javascript:` URLs stay visible text.
  const withLinks = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label, href) => {
    links.push(`<a href="${href}" target="_blank" rel="noopener noreferrer">${renderEmphasis(label)}</a>`);
    return `${LINK_MARK}${links.length - 1}${LINK_MARK}`;
  });
  return renderEmphasis(withLinks).replace(new RegExp(`${LINK_MARK}(\\d+)${LINK_MARK}`, 'g'), (_m, i) => links[Number(i)]);
}

function renderBlocks(lines, blocks) {
  const out = [];
  let paragraph = [];
  let list = null;
  let quote = null;

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      out.push(`<p>${paragraph.map(renderInline).join('<br>')}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      const start = list.type === 'ol' && list.start !== 1 ? ` start="${list.start}"` : '';
      out.push(`<${list.type}${start}>${list.items.map((item) => `<li>${renderInline(item)}</li>`).join('')}</${list.type}>`);
      list = null;
    }
  };
  const flushQuote = () => {
    if (quote) {
      out.push(`<blockquote>${renderBlocks(quote, blocks)}</blockquote>`);
      quote = null;
    }
  };

  for (const line of lines) {
    let match = line.match(new RegExp(`^\\s*${BLOCK_MARK}(\\d+)${BLOCK_MARK}\\s*$`));
    if (match) {
      flushParagraph();
      flushList();
      flushQuote();
      out.push(blocks[Number(match[1])]);
      continue;
    }

    // Input is already escaped, so a blockquote marker arrives as `&gt;`.
    match = line.match(/^\s*&gt;\s?(.*)$/);
    if (match) {
      flushParagraph();
      flushList();
      (quote ??= []).push(match[1]);
      continue;
    }
    flushQuote();

    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    match = line.match(/^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/);
    if (match) {
      flushParagraph();
      flushList();
      const level = match[1].length;
      out.push(`<h${level}>${renderInline(match[2])}</h${level}>`);
      continue;
    }

    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushParagraph();
      flushList();
      out.push('<hr>');
      continue;
    }

    match = line.match(/^\s*[-*+]\s+(.*)$/);
    if (match) {
      flushParagraph();
      if (list?.type !== 'ul') {
        flushList();
        list = { type: 'ul', start: 1, items: [] };
      }
      list.items.push(match[1]);
      continue;
    }

    match = line.match(/^\s*(\d{1,9})[.)]\s+(.*)$/);
    if (match) {
      flushParagraph();
      if (list?.type !== 'ol') {
        flushList();
        list = { type: 'ol', start: Number(match[1]), items: [] };
      }
      list.items.push(match[2]);
      continue;
    }

    if (list && /^\s{2,}\S/.test(line)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  flushParagraph();
  flushList();
  flushQuote();
  return out.join('');
}

export function formatMarkdown(text) {
  if (!text) return '';
  const blocks = [];
  const inlineCode = [];

  let source = String(text).replace(/[-]/g, '').replace(/\r\n?/g, '\n');
  source = source.replace(FENCE_RE, (_match, lang, code) => {
    blocks.push(codeBlockHtml(lang.trim(), code.replace(/\n$/, '')));
    return `${BLOCK_MARK}${blocks.length - 1}${BLOCK_MARK}`;
  });
  source = source.replace(/`([^`\n]+)`/g, (_match, code) => {
    inlineCode.push(`<code>${escapeHtml(code)}</code>`);
    return `${INLINE_CODE_MARK}${inlineCode.length - 1}${INLINE_CODE_MARK}`;
  });

  const html = renderBlocks(escapeHtml(source).split('\n'), blocks);
  return html.replace(new RegExp(`${INLINE_CODE_MARK}(\\d+)${INLINE_CODE_MARK}`, 'g'), (_m, i) => inlineCode[Number(i)]);
}

function hasOpenInlineMarker(line) {
  const withoutBold = line.replace(/\*\*/g, '');
  return (
    (line.match(/`/g) ?? []).length % 2 === 1 ||
    (line.match(/\*\*/g) ?? []).length % 2 === 1 ||
    (line.match(/__/g) ?? []).length % 2 === 1 ||
    /(^|[^\w*])\*(?=[^\s*])[^*]*$/.test(withoutBold) ||
    /\[[^\]]*$/.test(line) ||
    /\]\([^)]*$/.test(line)
  );
}

/**
 * Splits streamed text into a prefix that is safe to render as Markdown and an in-progress tail:
 * either an unclosed code fence, or a last line with an unclosed inline marker.
 */
export function splitStableMarkdown(text) {
  const source = String(text ?? '').replace(/\r\n?/g, '\n');
  let inFence = false;
  let fenceStart = -1;
  let offset = 0;
  for (const line of source.split('\n')) {
    if (!inFence && /^[ \t]*```/.test(line)) {
      inFence = true;
      fenceStart = offset;
    } else if (inFence && /^[ \t]*```[ \t]*$/.test(line)) {
      inFence = false;
    }
    offset += line.length + 1;
  }
  if (inFence) {
    return { stable: source.slice(0, fenceStart), tail: source.slice(fenceStart), tailIsCode: true };
  }

  const lastNewline = source.lastIndexOf('\n');
  const lastLine = source.slice(lastNewline + 1);
  if (lastLine && hasOpenInlineMarker(lastLine)) {
    return { stable: source.slice(0, lastNewline + 1), tail: lastLine, tailIsCode: false };
  }
  return { stable: source, tail: '', tailIsCode: false };
}

/**
 * Renders partial streamed text without flicker: the stable prefix as Markdown, and the tail either as
 * an open code block (so code does not jump once the fence closes) or as plain escaped text.
 */
export function formatStreamingMarkdown(text) {
  const { stable, tail, tailIsCode } = splitStableMarkdown(text);
  let html = formatMarkdown(stable);
  if (tailIsCode) {
    const newline = tail.indexOf('\n');
    const lang = (newline === -1 ? tail : tail.slice(0, newline)).replace(/^[ \t]*```/, '').trim();
    const code = newline === -1 ? '' : tail.slice(newline + 1);
    html += codeBlockHtml(lang, code);
  } else if (tail) {
    html += `<p class="streaming-tail">${escapeHtml(tail)}</p>`;
  }
  return html;
}

/**
 * Renders a finished (or aborted) reply. A reply cut off inside a code fence keeps its open-fence rendering
 * instead of falling back to literal backticks; everything else renders as plain Markdown.
 */
export function formatFinalMarkdown(text) {
  return splitStableMarkdown(text).tailIsCode ? formatStreamingMarkdown(text) : formatMarkdown(text);
}
