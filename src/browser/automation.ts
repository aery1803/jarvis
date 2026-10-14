import type {
  DistilledPageView,
  DistilledElement,
  DistilledForm,
  BrowserAction,
  BrowserActionResult,
  BrowserDriver,
  BrowserDriverPage,
  BrowserDriverResult,
} from './types.js';
import type { ActionGateway } from '../devagent/action-gateway.js';
import { ContentDistiller } from '../services/scraper.js';
import { fenceUntrusted, stripControlChars } from '../bridge/untrusted.js';
import { fetchPageGuarded } from './fetch.js';
import type { FetchedPage } from './fetch.js';

const NO_DRIVER_MESSAGE = 'no browser driver available';
const MAX_ELEMENTS = 200;
const MAX_TEXT_CHARS = 8000;
const SKIPPED_CONTENT_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg']);
const VOID_NAME_TAGS = new Set(['input', 'textarea', 'select']);

const FINANCIAL_PATTERN = /\b(buy|purchase|pay|payment|payments|paypal|checkout|check out|transfer|confirm order|place order|subscribe|donate)\b/;
const SOCIAL_PATTERN = /\b(tweet|retweet|publish post|share update|send direct message|send dm|post comment|post reply)\b/;
const PAYMENT_FIELD_PATTERN = /\b(card|cvv|cvc|ccnum|cc number|iban|routing|expiry|billing)\b/;
const SUBMIT_PATTERN = /\bsubmit\b/;

type HtmlToken =
  | { kind: 'open'; name: string; attrs: Map<string, string>; selfClosing: boolean }
  | { kind: 'close'; name: string }
  | { kind: 'text'; text: string };

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === '#') {
      const code = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

function normalizeText(text: string, limit = 300): string {
  return stripControlChars(decodeEntities(text)).replace(/\s+/g, ' ').trim().slice(0, limit);
}

function* scanHtml(html: string): Generator<HtmlToken> {
  const lower = html.toLowerCase();
  const length = html.length;
  let i = 0;
  while (i < length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      yield { kind: 'text', text: html.slice(i) };
      return;
    }
    if (lt > i) yield { kind: 'text', text: html.slice(i, lt) };

    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end === -1 ? length : end + 3;
      continue;
    }
    const next = html[lt + 1];
    if (next === '!' || next === '?') {
      const end = html.indexOf('>', lt);
      i = end === -1 ? length : end + 1;
      continue;
    }
    const isClose = next === '/';
    const nameStart = lt + (isClose ? 2 : 1);
    const nameMatch = /^[A-Za-z][A-Za-z0-9:-]*/.exec(html.slice(nameStart, nameStart + 40));
    if (!nameMatch) {
      yield { kind: 'text', text: '<' };
      i = lt + 1;
      continue;
    }

    const name = nameMatch[0].toLowerCase();
    let j = nameStart + nameMatch[0].length;
    const attrs = new Map<string, string>();
    let selfClosing = false;
    while (j < length) {
      const ch = html[j];
      if (ch === '>') {
        j++;
        break;
      }
      if (ch === '/') {
        if (html[j + 1] === '>') {
          selfClosing = true;
          j += 2;
          break;
        }
        j++;
        continue;
      }
      if (/\s/.test(ch)) {
        j++;
        continue;
      }
      let k = j;
      while (k < length && !/[\s=>/]/.test(html[k])) k++;
      const attrName = html.slice(j, k).toLowerCase();
      j = k;
      while (j < length && /\s/.test(html[j])) j++;
      let value = '';
      if (html[j] === '=') {
        j++;
        while (j < length && /\s/.test(html[j])) j++;
        const quote = html[j];
        if (quote === '"' || quote === "'") {
          const end = html.indexOf(quote, j + 1);
          value = end === -1 ? html.slice(j + 1) : html.slice(j + 1, end);
          j = end === -1 ? length : end + 1;
        } else {
          let end = j;
          while (end < length && !/[\s>]/.test(html[end])) end++;
          value = html.slice(j, end);
          j = end;
        }
      } else if (attrName === '') {
        j++;
      }
      if (attrName && !attrs.has(attrName)) attrs.set(attrName, decodeEntities(value));
    }
    i = j;

    if (isClose) {
      yield { kind: 'close', name };
      continue;
    }
    yield { kind: 'open', name, attrs, selfClosing };
    if (SKIPPED_CONTENT_TAGS.has(name) && !selfClosing) {
      const end = lower.indexOf(`</${name}`, i);
      if (end === -1) {
        i = length;
      } else {
        const gt = html.indexOf('>', end);
        i = gt === -1 ? length : gt + 1;
      }
    }
  }
}

function cssString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function idSelector(id: string): string {
  return /^[A-Za-z][\w-]*$/.test(id) ? `#${id}` : `[id="${cssString(id)}"]`;
}

interface Collector {
  tag: string;
  kind: 'link' | 'button' | 'block' | 'label' | 'title';
  attrs: Map<string, string>;
  text: string;
  element?: DistilledElement;
}

/** Splits an identifier or selector into lowercase words so `pay` never matches inside `payload`. */
function toWords(text: string): string {
  return ` ${text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
}

export interface BrowserEngineOptions {
  /** Plug in a real browser (e.g. Playwright). Without one, click/fill/press/wait report that none is available. */
  driver?: BrowserDriver;
  /** Replaces the built-in guarded fetch used by `navigate`; tests inject a fake. */
  fetchPage?: (url: string) => Promise<FetchedPage>;
}

export class BrowserAutomationEngine {
  private currentUrl = 'about:blank';
  private currentView: DistilledPageView | null = null;
  private readonly driver?: BrowserDriver;
  private readonly fetchPage: (url: string) => Promise<FetchedPage>;
  private readonly distiller = new ContentDistiller();

  constructor(private gateway?: ActionGateway, options: BrowserEngineOptions = {}) {
    this.driver = options.driver;
    this.fetchPage = options.fetchPage ?? ((url) => fetchPageGuarded(url));
  }

  /**
   * Distills raw HTML into a compact, token-efficient representation (role, text, actions, selectors).
   * The result is always untrusted and also carries a fenced copy of the text for prompts.
   */
  distillHtml(html: string, url: string, title?: string): DistilledPageView {
    const elements: DistilledElement[] = [];
    const forms: DistilledForm[] = [];
    const blockTexts: string[] = [];
    const labelFor = new Map<string, string>();
    const pendingInputs: Array<{ element: DistilledElement; id?: string; fallback: string }> = [];
    const stack: Collector[] = [];
    const tagCounts = new Map<string, number>();
    const formStack: DistilledForm[] = [];
    let documentTitle = '';

    const finalize = (collector: Collector): void => {
      const text = normalizeText(collector.text);
      switch (collector.kind) {
        case 'title':
          if (!documentTitle) documentTitle = text;
          break;
        case 'label': {
          const target = collector.attrs.get('for');
          if (target && text) labelFor.set(target, text);
          break;
        }
        case 'block':
          if (text.length > 5) blockTexts.push(text);
          break;
        default:
          if (collector.element) collector.element.name = text || collector.element.name;
      }
    };

    const closeFrom = (index: number): void => {
      while (stack.length > index) finalize(stack.pop() as Collector);
    };

    const nextIndex = (tag: string): number => {
      const index = tagCounts.get(tag) ?? 0;
      tagCounts.set(tag, index + 1);
      return index;
    };

    for (const token of scanHtml(html)) {
      if (token.kind === 'text') {
        for (const collector of stack) collector.text += token.text;
        continue;
      }
      if (token.kind === 'close') {
        if (token.name === 'form') formStack.pop();
        let index = -1;
        for (let s = stack.length - 1; s >= 0; s--) {
          if (stack[s].tag === token.name) {
            index = s;
            break;
          }
        }
        if (index !== -1) closeFrom(index);
        continue;
      }

      const { name, attrs } = token;
      const nth = nextIndex(name);
      const attr = (key: string): string | undefined => attrs.get(key);

      if (name === 'p' || name === 'li') {
        const top = stack[stack.length - 1];
        if (top && top.kind === 'block' && (top.tag === 'p' || top.tag === 'li')) finalize(stack.pop() as Collector);
      }

      if (name === 'form') {
        const form: DistilledForm = { action: attr('action'), method: (attr('method') ?? 'get').toLowerCase(), fields: [] };
        forms.push(form);
        if (!token.selfClosing) formStack.push(form);
      } else if (name === 'a') {
        const href = attr('href');
        if (href !== undefined && elements.length < MAX_ELEMENTS) {
          let resolved: string | undefined = href;
          try {
            const target = new URL(href, url);
            resolved = target.protocol === 'javascript:' ? undefined : target.href;
          } catch {
            resolved = href;
          }
          const id = attr('id');
          const element: DistilledElement = {
            role: 'link',
            name: attr('aria-label') ?? '',
            selector: id ? idSelector(id) : `a[href="${cssString(href)}"]`,
            href: resolved,
            isClickable: true,
          };
          elements.push(element);
          if (!token.selfClosing) stack.push({ tag: name, kind: 'link', attrs, text: '', element });
        }
      } else if (name === 'button') {
        if (elements.length < MAX_ELEMENTS) {
          const id = attr('id');
          const field = attr('name');
          const element: DistilledElement = {
            role: 'button',
            name: attr('aria-label') ?? '',
            selector: id ? idSelector(id) : field ? `button[name="${cssString(field)}"]` : `button >> nth=${nth}`,
            isClickable: true,
            inputType: (attr('type') ?? 'submit').toLowerCase(),
            inForm: formStack.length > 0,
          };
          elements.push(element);
          if (!token.selfClosing) stack.push({ tag: name, kind: 'button', attrs, text: '', element });
        }
      } else if (VOID_NAME_TAGS.has(name)) {
        const inputType = name === 'input' ? (attr('type') ?? 'text').toLowerCase() : name;
        if (inputType !== 'hidden' && elements.length < MAX_ELEMENTS) {
          const id = attr('id');
          const field = attr('name');
          const selector = id ? idSelector(id) : field ? `${name}[name="${cssString(field)}"]` : `${name} >> nth=${nth}`;
          if (name === 'input' && ['submit', 'button', 'reset', 'image'].includes(inputType)) {
            elements.push({
              role: 'button',
              name: normalizeText(attr('value') ?? attr('aria-label') ?? inputType),
              selector,
              isClickable: true,
              inputType,
              inForm: formStack.length > 0,
            });
          } else {
            const element: DistilledElement = { role: name === 'select' ? 'select' : 'input', selector, isInput: true, inputType };
            elements.push(element);
            pendingInputs.push({
              element,
              id,
              fallback: normalizeText(attr('aria-label') ?? attr('placeholder') ?? field ?? id ?? inputType),
            });
            const form = formStack[formStack.length - 1];
            if (form) form.fields.push([field, id, attr('autocomplete'), attr('placeholder')].filter(Boolean).join(' '));
          }
        } else if (inputType === 'hidden') {
          const form = formStack[formStack.length - 1];
          if (form && attr('name')) form.fields.push(attr('name') as string);
        }
      } else if (name === 'label') {
        if (!token.selfClosing) stack.push({ tag: name, kind: 'label', attrs, text: '' });
      } else if (name === 'title') {
        if (!token.selfClosing) stack.push({ tag: name, kind: 'title', attrs, text: '' });
      } else if (name === 'p' || name === 'li' || /^h[1-6]$/.test(name)) {
        if (!token.selfClosing) stack.push({ tag: name, kind: 'block', attrs, text: '' });
      }
    }
    closeFrom(0);

    const finalElements = elements.filter((element) => element.role === 'input' || element.role === 'select' || element.name);
    for (const pending of pendingInputs) {
      const label = pending.id ? labelFor.get(pending.id) : undefined;
      pending.element.name = label ?? pending.fallback;
    }

    const textChunks: string[] = [];
    for (const element of finalElements) {
      const label = element.role === 'link' ? 'Link' : element.role === 'button' ? 'Button' : 'Input';
      textChunks.push(`[${label}: ${element.name}]`);
    }
    textChunks.push(...blockTexts);

    const extractedText = this.distiller.sanitizeForContext(textChunks.join('\n')).slice(0, MAX_TEXT_CHARS);
    const view: DistilledPageView = {
      url,
      title: title ?? (documentTitle || 'Page'),
      elements: finalElements,
      forms,
      isUntrusted: true, // Web page content is always untrusted per Principle 2
      extractedText,
      estimatedTokens: Math.ceil(extractedText.length / 4),
    };
    view.fencedText = fenceUntrusted('web_page', extractedText, { url, title: view.title });

    this.currentUrl = url;
    this.currentView = view;
    return view;
  }

  /**
   * Assesses whether a browser action touches money, public posting or a form submission. Matching is on whole
   * words (so `payload` is not `pay`), plus URL-path and form heuristics against the last distilled page.
   */
  assessActionRisk(action: BrowserAction): { isRisky: boolean; reason?: string } {
    // `navigate` is one GET through the SSRF-guarded fetch: it cannot buy, post or submit anything, and scoring the
    // URL's words would make `browse_page` (a Tier 1 read) refuse pages like /wiki/Payment with no approval path.
    if (action.type === 'navigate') return { isRisky: false };
    const known = action.selector ? this.currentView?.elements.find((element) => element.selector === action.selector) : undefined;
    const parts = [action.selector ?? '', known?.name ?? ''];
    if (action.type === 'click' || action.type === 'press') parts.push(action.value ?? '');
    if (action.url) {
      try {
        const target = new URL(action.url);
        parts.push(target.hostname, decodeURIComponent(target.pathname));
      } catch {
        parts.push(action.url);
      }
    }
    const words = toWords(parts.join(' '));

    const financial = FINANCIAL_PATTERN.exec(words);
    if (financial) {
      return {
        isRisky: true,
        reason: `Action involves financial transaction ('${financial[1]}'). Explicit Tier 2 owner confirmation required.`,
      };
    }
    const social = SOCIAL_PATTERN.exec(words);
    if (social) {
      return {
        isRisky: true,
        reason: `Action involves public social media publication ('${social[1]}'). Explicit Tier 2 owner confirmation required.`,
      };
    }

    const forms = this.currentView?.forms ?? [];
    const rawSelector = (action.selector ?? '').toLowerCase();
    const clicksSubmit =
      action.type === 'click' &&
      (SUBMIT_PATTERN.test(words) || /type\s*=\s*["']?submit/.test(rawSelector) || (known?.role === 'button' && known.inputType === 'submit' && known.inForm === true));
    const pressesEnter = action.type === 'press' && /^(enter|return)$/i.test(action.value ?? '') && forms.length > 0;
    if (clicksSubmit || pressesEnter) {
      const paymentLike = forms.some((form) => PAYMENT_FIELD_PATTERN.test(toWords(form.fields.join(' '))) || FINANCIAL_PATTERN.test(toWords(form.action ?? '')));
      return {
        isRisky: true,
        reason: paymentLike
          ? 'Action submits a form that looks like a financial transaction (payment fields or payment URL). Explicit Tier 2 owner confirmation required.'
          : 'Action submits a browser form (state-changing). Explicit Tier 2 owner confirmation required.',
      };
    }

    return { isRisky: false };
  }

  /**
   * Executes a browser action under Action Gateway safeguards. `navigate` really fetches the page; click, fill,
   * press and wait need an injected `BrowserDriver` and otherwise report failure instead of pretending.
   */
  async executeAction(action: BrowserAction, isOwnerExplicitlyApproved = false): Promise<BrowserActionResult> {
    const risk = this.assessActionRisk(action);

    if (risk.isRisky && !isOwnerExplicitlyApproved) {
      throw new Error(`Action Blocked by Browser Safeguards: ${risk.reason}`);
    }

    if (risk.isRisky && this.gateway) {
      await this.gateway.executeTier2Action('BROWSER_ACTION', risk.reason ?? 'High impact browser action', action.selector, undefined, {
        isOwnerExplicitlyApproved: true,
      });
    }

    switch (action.type) {
      case 'navigate':
        return this.navigate(action);
      case 'click':
        return this.driven(action, (driver, selector) => driver.click(selector), true);
      case 'fill':
        return this.driven(action, (driver, selector) => driver.fill(selector, action.value ?? ''), true);
      case 'press':
        return this.driven(action, (driver, selector) => driver.press(action.value ?? '', selector), false);
      case 'wait':
        return this.driven(
          action,
          (driver, selector) => driver.wait({ selector: selector || undefined, timeoutMs: Math.min(Math.max(Number(action.value) || 5000, 0), 30_000) }),
          false
        );
      case 'snapshot':
      default:
        return { action: 'snapshot', success: true, message: this.currentView ? undefined : 'no page loaded', pageView: this.snapshot() };
    }
  }

  /** The last distilled page, or an empty `about:blank` view when nothing has been loaded. */
  snapshot(): DistilledPageView {
    if (this.currentView) return this.currentView;
    return {
      url: 'about:blank',
      title: 'Blank Page',
      elements: [],
      forms: [],
      isUntrusted: true,
      extractedText: '',
      fencedText: fenceUntrusted('web_page', '', { url: 'about:blank' }),
      estimatedTokens: 0,
    };
  }

  getCurrentUrl(): string {
    return this.currentUrl;
  }

  private async navigate(action: BrowserAction): Promise<BrowserActionResult> {
    if (!action.url) return { action: 'navigate', success: false, message: 'navigate requires a url' };
    try {
      const page: BrowserDriverPage | FetchedPage = this.driver ? await this.driver.navigate(action.url) : await this.fetchPage(action.url);
      const title = 'title' in page ? page.title : undefined;
      const pageView = this.distillHtml(page.html, page.url, title);
      const truncated = 'truncated' in page && page.truncated ? ' (content truncated at the size cap)' : '';
      return { action: 'navigate', success: true, message: `Navigated to ${page.url}${truncated}`, pageView };
    } catch (err: unknown) {
      return { action: 'navigate', success: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  private async driven(
    action: BrowserAction,
    run: (driver: BrowserDriver, selector: string) => Promise<BrowserDriverResult>,
    requiresSelector: boolean
  ): Promise<BrowserActionResult> {
    if (!this.driver) return { action: action.type, success: false, message: NO_DRIVER_MESSAGE };
    if (requiresSelector && !action.selector) return { action: action.type, success: false, message: `${action.type} requires a selector` };
    try {
      const outcome = await run(this.driver, action.selector ?? '');
      if (!outcome.success) return { action: action.type, success: false, message: outcome.message };
      const page = await this.driver.content();
      const pageView = this.distillHtml(page.html, page.url, page.title);
      return { action: action.type, success: true, message: outcome.message, pageView };
    } catch (err: unknown) {
      return { action: action.type, success: false, message: err instanceof Error ? err.message : String(err) };
    }
  }
}
