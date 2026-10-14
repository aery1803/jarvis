/**
 * Jarvis Local AI: owner approval banner (Tier 2 actions wait here until the owner decides)
 * Authority: CODING_RULES.md section 5
 */

import { requestJson, jsonRequest, h, tierBadge } from './api.js';

const POLL_MS = 2500;

const banner = document.getElementById('approvalBanner');
const busyIds = new Set();
let lastSignature = null;

/** Everything in `metadata` except the structured `args`, in full; the owner approves what they can read. */
function previewMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return '';
  try {
    const { args, ...rest } = metadata;
    return Object.keys(rest).length > 0 ? JSON.stringify(rest) : '';
  } catch {
    return '';
  }
}

/** One line per argument, as the gateway recorded them; a value that was cut says how much is missing. */
function argumentList(metadata) {
  const args = metadata && Array.isArray(metadata.args) ? metadata.args.filter((arg) => arg && typeof arg.name === 'string') : [];
  if (args.length === 0) return null;
  return h(
    'ul',
    { class: 'approval-args', dataset: { testid: 'approval-args' } },
    args.map((arg) => {
      const omitted = Number(arg.omittedChars) > 0;
      return h(
        'li',
        { class: omitted ? 'approval-arg is-cut' : 'approval-arg' },
        h('strong', {}, `${arg.name}: `),
        h('code', {}, String(arg.value ?? '')),
        omitted ? h('em', { class: 'approval-arg-cut' }, ` (+${arg.omittedChars} characters not shown${arg.securityRelevant ? '; do not approve what you cannot read' : ''})`) : null
      );
    })
  );
}

let pendingList = [];
let pendingFocus = null;
const errorsById = new Map();

/** After the last approval clears there is no banner left to hold focus, so it goes back to the page. */
function focusAfterClear() {
  const input = document.getElementById('promptInput');
  const target = input && input.offsetParent !== null ? input : document.querySelector('[role="tab"][aria-selected="true"]');
  target?.focus();
}

function restoreFocus(key) {
  if (!key) return;
  const item = key.id ? banner.querySelector(`[data-approval-id="${CSS.escape(key.id)}"]`) : null;
  if (item) {
    const button = key.testid ? item.querySelector(`[data-testid="${key.testid}"]:not(:disabled)`) : null;
    (button ?? item).focus();
    return;
  }
  const next = banner.querySelector('[data-testid="approval-approve"]');
  if (next) next.focus();
  else focusAfterClear();
}

async function decide(request, approved) {
  errorsById.delete(request.id);
  busyIds.add(request.id);
  pendingFocus = { id: request.id, testid: null };
  render();
  const result = await requestJson(`/api/approvals/${encodeURIComponent(request.id)}`, jsonRequest('POST', { approved }));
  busyIds.delete(request.id);
  // The banner is rebuilt on every state change, so the message lives in a map and `render` writes it into the new nodes.
  if (!result.ok) errorsById.set(request.id, result.error || 'The decision could not be recorded.');
  render();
  await refresh();
  pendingFocus = null;
  document.dispatchEvent(new CustomEvent('jarvis:approval-decided', { detail: { id: request.id, approved, ok: result.ok } }));
}

// Re-rendered only when the set of requests, a busy state or an error changed, so a poll never steals focus.
function render() {
  const errorKey = [...errorsById].map(([id, message]) => `${id}=${message}`).join('|');
  const signature = `${pendingList.map((request) => request.id).join('|')}#${[...busyIds].join('|')}#${errorKey}`;
  if (signature === lastSignature) return;
  lastSignature = signature;

  const active = document.activeElement;
  const focusKey = active && banner.contains(active)
    ? { id: active.closest('[data-approval-id]')?.dataset.approvalId ?? null, testid: active.dataset.testid ?? null }
    : active && active !== document.body
      ? null
      : pendingFocus;

  banner.replaceChildren();
  banner.hidden = pendingList.length === 0;
  if (pendingList.length === 0) {
    restoreFocus(focusKey);
    return;
  }

  banner.append(h('div', { class: 'approval-title' }, `${pendingList.length} action${pendingList.length === 1 ? '' : 's'} waiting for your approval`));
  pendingList.forEach((request) => {
    const error = errorsById.get(request.id);
    const errorEl = h('span', { class: 'approval-error', role: 'alert' }, error ? `Could not record your decision: ${error}` : null);
    const busy = busyIds.has(request.id);
    const metadata = previewMetadata(request.metadata);
    const args = argumentList(request.metadata);
    banner.append(
      h(
        'div',
        { class: 'approval-item', tabindex: '-1', dataset: { testid: 'approval-item', approvalId: request.id } },
        h(
          'div',
          { class: 'approval-body' },
          h('div', { class: 'approval-head' }, tierBadge(request.tier), h('strong', {}, request.actionType), h('span', { class: 'approval-by' }, `requested by ${request.requestedBy}`)),
          h('div', { class: 'approval-description', dataset: { testid: 'approval-description' } }, request.description),
          args,
          metadata ? h('code', { class: 'approval-metadata' }, metadata) : null,
          errorEl
        ),
        h(
          'div',
          { class: 'approval-actions' },
          h('button', { type: 'button', class: 'btn btn-primary', disabled: busy, dataset: { testid: 'approval-approve' }, onclick: () => decide(request, true) }, 'Approve'),
          h('button', { type: 'button', class: 'btn btn-danger', disabled: busy, dataset: { testid: 'approval-deny' }, onclick: () => decide(request, false) }, 'Deny')
        )
      )
    );
  });
  restoreFocus(focusKey);
}

export async function refresh() {
  const result = await requestJson('/api/approvals');
  if (!result.ok) return;
  pendingList = Array.isArray(result.data?.pending) ? result.data.pending : [];
  const stillPending = new Set(pendingList.map((request) => request.id));
  for (const id of errorsById.keys()) if (!stillPending.has(id)) errorsById.delete(id);
  render();
}

export function initApprovals() {
  refresh();
  setInterval(refresh, POLL_MS);
  document.addEventListener('jarvis:turn-finished', refresh);
}
