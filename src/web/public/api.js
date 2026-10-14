/**
 * Jarvis Local AI: shared browser helpers (HTTP, formatting, DOM building).
 * Authority: FEAT-004
 *
 * Everything the UI shows from the server (model output, mail, notifications, tool descriptions) is untrusted
 * text, so views are built with `h()`, which only ever sets `textContent`; `innerHTML` is reserved for the
 * Markdown renderer, which escapes before it formats.
 */

const BYTES_PER_GB = 1024 * 1024 * 1024;
const BYTES_PER_MB = 1024 * 1024;

/** Every state-changing request carries `X-Jarvis-Client`, which the server requires and a cross-site page cannot add. */
export function apiFetch(url, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (options.method && options.method !== 'GET') {
    headers['X-Jarvis-Client'] = 'web';
  }
  return fetch(url, { ...options, headers });
}

export function jsonRequest(method, body, extra = {}) {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}), ...extra };
}

export async function errorMessageFrom(res) {
  try {
    const data = await res.json();
    if (data && typeof data.error === 'string') return data.error;
  } catch {
    // Fall through to the status line.
  }
  return `HTTP ${res.status}${res.statusText ? `: ${res.statusText}` : ''}`;
}

/** GET or POST JSON; resolves `{ ok, status, data, error }` and never throws, so a card can always show a state. */
export async function requestJson(url, options = {}) {
  try {
    const res = await apiFetch(url, options);
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) {
      const error = data && typeof data.error === 'string' ? data.error : `HTTP ${res.status}${res.statusText ? `: ${res.statusText}` : ''}`;
      return { ok: false, status: res.status, data, error };
    }
    return { ok: true, status: res.status, data, error: null };
  } catch (err) {
    return { ok: false, status: 0, data: null, error: `Could not reach the Jarvis server: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Only http(s) URLs may become links; anything else (for example `javascript:`) is shown as text. */
export function safeHttpUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

export function number(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

export function formatGb(bytes) {
  return (number(bytes) / BYTES_PER_GB).toFixed(1);
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes === null) return 'unknown size';
  return bytes >= BYTES_PER_GB ? `${(bytes / BYTES_PER_GB).toFixed(1)} GB` : `${(bytes / BYTES_PER_MB).toFixed(0)} MB`;
}

export function formatPercent(fraction) {
  return `${(number(fraction) * 100).toFixed(0)}%`;
}

export function formatDuration(ms) {
  const value = number(ms);
  return value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`;
}

export function formatTime(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? String(iso ?? '') : date.toLocaleString();
}

/**
 * Builds an element. Attributes: `class`, `text`, `dataset`, `on<event>` handlers; `true` is a boolean attribute and
 * `false`, `null` and `undefined` are skipped. Children may be nodes, strings, numbers or nested arrays; text is
 * always inserted as text.
 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = String(value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function clear(el) {
  el.replaceChildren();
  return el;
}

/** A bar whose fill is `fraction` (0..1); the width is set through CSSOM, which the page's CSP allows. */
export function meterBar(label, fraction, caption, testId) {
  const clamped = Math.max(0, Math.min(1, number(fraction)));
  const fill = h('div', { class: `meter-fill${clamped > 0.9 ? ' is-high' : ''}` });
  fill.style.width = `${(clamped * 100).toFixed(1)}%`;
  return h(
    'div',
    { class: 'meter', dataset: testId ? { testid: testId } : {} },
    h('div', { class: 'meter-label' }, h('span', {}, label), h('span', { class: 'meter-caption' }, caption)),
    h('div', { class: 'meter-track', role: 'progressbar', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(clamped * 100)) }, fill)
  );
}

export function badge(text, kind = 'neutral', extra = {}) {
  return h('span', { class: `badge badge-${kind}`, ...extra }, text);
}

export function tierBadge(tier) {
  const value = number(tier);
  return badge(`Tier ${value}`, `tier-${value}`, { dataset: { testid: 'tier-badge' } });
}

/** An empty, loading or error state that always says what is going on. */
export function stateLine(kind, text) {
  return h('p', { class: `card-state is-${kind}`, role: kind === 'error' ? 'alert' : 'status' }, text);
}

export function table(headers, rows, testId) {
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      { class: 'data-table', dataset: testId ? { testid: testId } : {} },
      h('thead', {}, h('tr', {}, headers.map((header) => h('th', { scope: 'col' }, header)))),
      h('tbody', {}, rows.map((row) => h('tr', {}, row.map((cell) => h('td', {}, cell)))))
    )
  );
}

export function sourceLinks(urls) {
  const wrap = h('div', { class: 'source-pill-container' });
  (urls ?? []).forEach((url, index) => {
    const href = safeHttpUrl(url);
    if (!href) {
      wrap.append(h('span', { class: 'source-pill' }, `Source ${index + 1} (link withheld)`));
      return;
    }
    wrap.append(h('a', { class: 'source-pill', href, target: '_blank', rel: 'noopener noreferrer' }, `Source ${index + 1}: ${new URL(href).hostname}`));
  });
  return wrap;
}
