/**
 * Jarvis Local AI Agent: Reasoning-Block Filter
 *
 * Reasoning models (qwen3, deepseek-r1) write their chain of thought between `<think>` and `</think>` in the same
 * stream as the answer. It must not reach the reply the owner reads, the saved transcript, the history fed back to
 * the model, the episode outcome or the summary input. Only the tags and what is inside them are removed.
 */

const OPEN = '<think>';
const CLOSE = '</think>';

/** Removes closed `<think>` blocks, and an unterminated trailing one (the model never reached an answer). */
export function stripThinking(text: string): string {
  const withoutClosed = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const open = withoutClosed.search(/<think>/i);
  return (open === -1 ? withoutClosed : withoutClosed.slice(0, open)).trimStart();
}

/** Length of the longest suffix of `text` that is a proper prefix of `tag` (a tag split across two chunks). */
function partialTagLength(text: string, tag: string): number {
  const lower = text.toLowerCase();
  for (let length = Math.min(tag.length - 1, lower.length); length > 0; length--) {
    if (tag.startsWith(lower.slice(lower.length - length))) return length;
  }
  return 0;
}

/**
 * Streaming-safe: `push` takes raw chunks and returns the text that is safe to show. A tag split across chunks is
 * held back until it is known whether it is a tag; `end` drops an unterminated block and releases a held fragment
 * that turned out not to be a tag.
 */
export class ThinkStreamFilter {
  private buffer = '';
  private inThink = false;
  private trimLeading = false;
  private sawThinking = false;

  push(chunk: string): string {
    this.buffer += chunk;
    let out = '';
    for (;;) {
      if (this.inThink) {
        const at = this.buffer.toLowerCase().indexOf(CLOSE);
        if (at === -1) {
          // Nothing inside the block is kept; only a possible start of the closing tag has to survive.
          this.buffer = this.buffer.slice(this.buffer.length - partialTagLength(this.buffer, CLOSE));
          break;
        }
        this.buffer = this.buffer.slice(at + CLOSE.length);
        this.inThink = false;
        this.trimLeading = true;
        continue;
      }
      const at = this.buffer.toLowerCase().indexOf(OPEN);
      if (at !== -1) {
        out += this.take(this.buffer.slice(0, at));
        this.buffer = this.buffer.slice(at + OPEN.length);
        this.inThink = true;
        this.sawThinking = true;
        continue;
      }
      const hold = partialTagLength(this.buffer, OPEN);
      out += this.take(this.buffer.slice(0, this.buffer.length - hold));
      this.buffer = this.buffer.slice(this.buffer.length - hold);
      break;
    }
    return out;
  }

  /** Whatever was held back for a tag that never completed; an unterminated reasoning block yields nothing. */
  end(): string {
    const rest = this.inThink ? '' : this.take(this.buffer);
    this.buffer = '';
    return rest;
  }

  /** The stream ended inside a `<think>` block: the model spent its output on reasoning and never answered. */
  get unterminated(): boolean {
    return this.inThink;
  }

  get hadThinking(): boolean {
    return this.sawThinking;
  }

  private take(text: string): string {
    if (!this.trimLeading) return text;
    const trimmed = text.replace(/^\s+/, '');
    if (trimmed !== '') this.trimLeading = false;
    return trimmed;
  }
}
