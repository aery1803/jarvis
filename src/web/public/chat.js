/**
 * Jarvis Local AI: Chat tab (sessions, model picker, streaming, tool chips, image attachments)
 * Authority: FEAT-004
 */

import { formatMarkdown, formatStreamingMarkdown, formatFinalMarkdown } from './markdown.js';
import { createSseParser } from './sse.js';
import { isDrawerHidden, createRequestGate, deriveSessionTitle, planImageFiles, attachmentLimitMessage, createToolChipTracker, modelRetryDelayMs } from './ui-logic.js';
import { apiFetch, jsonRequest, errorMessageFrom, requestJson, safeHttpUrl, formatBytes, h } from './api.js';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENTS = 4;

let currentSessionId = null;
let activeStream = null; // { controller: AbortController, reader: ReadableStreamDefaultReader | null }
let sessionsById = new Map();
const selectionGate = createRequestGate();
let submitting = false;
let modelsUnavailable = false;
let modelRetryTimer = null;
let modelRetryAttempt = 0;
let attachments = []; // { id, name, dataUrl, state: 'describing' | 'ready' | 'unavailable', description?, reason?, model? }
let attachmentCounter = 0;

const $ = (id) => document.getElementById(id);
const sessionList = $('sessionList');
const newChatBtn = $('newChatBtn');
const modelSelect = $('modelSelect');
const modelNote = $('modelNote');
const researchToggle = $('researchToggle');
const currentChatTitle = $('currentChatTitle');
const currentModelTag = $('currentModelTag');
const messagesContainer = $('messagesContainer');
const welcomeCard = $('welcomeCard');
const chatForm = $('chatForm');
const promptInput = $('promptInput');
const sendBtn = $('sendBtn');
const stopBtn = $('stopBtn');
const attachBtn = $('attachBtn');
const imageInput = $('imageInput');
const attachmentTray = $('attachmentTray');
const dropZone = $('dropZone');
const sidebar = $('sidebar');
const sidebarToggle = $('sidebarToggle');
const announcer = $('chatAnnouncer');

/** Screen-reader announcements for the chat: start and finish only, never the streamed text itself. */
function announce(text) {
  announcer.textContent = text;
}

function setModelTag(model) {
  currentModelTag.textContent = model || '';
}

// Fetch and render conversation list
async function loadSessions() {
  const result = await requestJson('/api/sessions');
  if (!result.ok) {
    console.error('Failed to load sessions:', result.error);
    return;
  }
  const sessions = result.data;
  sessionsById = new Map(sessions.map((s) => [s.id, s]));
  sessionList.replaceChildren();

  if (sessions.length === 0) {
    sessionList.append(h('div', { class: 'empty-sessions' }, 'No chats yet'));
    return;
  }

  sessions.forEach((s) => {
    const del = h('button', { type: 'button', class: 'delete-session-btn', title: 'Delete chat', 'aria-label': `Delete chat ${s.title || 'Untitled Chat'}`, dataset: { id: s.id, testid: 'delete-session' } }, '✕');
    const open = h('button', { type: 'button', class: 'session-title', dataset: { testid: 'session-open' } }, s.title || 'Untitled Chat');
    const item = h('div', { class: `session-item ${s.id === currentSessionId ? 'active' : ''}`, dataset: { testid: 'session-item', sessionId: s.id } }, open, del);
    open.addEventListener('click', () => {
      selectSession(s.id);
      closeSidebarOnMobile();
    });
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      askDeleteConfirmation(item, open, del, s);
    });
    sessionList.append(item);
  });
}

/** Swaps the row's controls for an inline 'Delete? Yes / No' so one stray tap cannot remove a conversation. */
function askDeleteConfirmation(item, open, del, session) {
  const title = session.title || 'Untitled Chat';
  const yes = h('button', { type: 'button', class: 'session-confirm-btn is-danger', 'aria-label': `Yes, delete chat ${title}`, dataset: { testid: 'delete-session-confirm' } }, 'Yes');
  const no = h('button', { type: 'button', class: 'session-confirm-btn', 'aria-label': `No, keep chat ${title}`, dataset: { testid: 'delete-session-cancel' } }, 'No');
  const question = h('span', { class: 'session-confirm-text', role: 'alert' }, `Delete "${title}"?`);
  item.replaceChildren(question, yes, no);
  no.addEventListener('click', () => {
    item.replaceChildren(open, del);
    del.focus();
  });
  yes.addEventListener('click', async () => {
    yes.disabled = true;
    no.disabled = true;
    const wasCurrent = currentSessionId === session.id;
    const deleted = await deleteSession(session.id);
    if (!deleted) {
      item.replaceChildren(open, del);
      del.focus();
      return;
    }
    (wasCurrent ? promptInput : newChatBtn).focus();
  });
  yes.focus();
}

/** Selects `model` in the dropdown, adding an option for a model that is no longer installed so the header never lies. */
function applyModel(model) {
  if (!model) return;
  if (![...modelSelect.options].some((o) => o.value === model)) {
    modelSelect.append(h('option', { value: model }, `${model} (not installed)`));
  }
  modelSelect.value = model;
  setModelTag(model);
}

/**
 * '+ New Chat' only resets the view. The server session is created by the first send, so an unused click leaves
 * nothing behind and the title comes from the first message.
 */
function startNewChatView() {
  stopActiveStream();
  selectionGate.invalidate();
  currentSessionId = null;
  currentChatTitle.textContent = 'New Conversation';
  sessionList.querySelectorAll('.session-item.active').forEach((el) => el.classList.remove('active'));
  renderMessages([]);
  promptInput.focus();
}

async function createNewSession(initialTitle = 'New Conversation') {
  stopActiveStream();
  selectionGate.invalidate();
  const model = modelSelect.value;
  const result = await requestJson('/api/sessions', jsonRequest('POST', { title: initialTitle, model }));
  if (!result.ok) {
    console.error('Failed to create session:', result.error);
    return false;
  }
  const session = result.data;
  currentSessionId = session.id;
  currentChatTitle.textContent = session.title;
  setModelTag(session.model);
  await loadSessions();
  renderMessages([]);
  promptInput.focus();
  return true;
}

async function selectSession(sessionId) {
  // A reply still streaming into the old chat is stopped (the server keeps the partial text) instead of
  // being left to render into a view that is gone.
  stopActiveStream();
  const token = selectionGate.next();

  const result = await requestJson(`/api/sessions/${encodeURIComponent(sessionId)}/messages`);
  if (!selectionGate.isCurrent(token)) return;
  if (!result.ok) {
    // The id is committed only after the messages arrive, so a failed load leaves the visible chat the active one.
    console.error('Failed to load messages:', result.error);
    modelNote.textContent = `Could not open that chat: ${result.error}`;
    return;
  }
  currentSessionId = sessionId;
  await loadSessions();
  if (!selectionGate.isCurrent(token)) return;
  renderMessages(result.data);
  const session = sessionsById.get(sessionId);
  currentChatTitle.textContent = session?.title || 'Untitled Chat';
  if (session?.model) applyModel(session.model);
}

async function deleteSession(sessionId) {
  if (currentSessionId === sessionId) stopActiveStream();
  const result = await requestJson(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
  if (!result.ok) {
    console.error('Failed to delete session:', result.error);
    modelNote.textContent = `Could not delete that chat: ${result.error}`;
    return false;
  }
  selectionGate.invalidate();
  if (currentSessionId === sessionId) {
    currentSessionId = null;
    currentChatTitle.textContent = 'New Conversation';
    renderMessages([]);
  }
  await loadSessions();
  return true;
}

function renderMessages(messages) {
  messagesContainer.replaceChildren();
  if (messages.length === 0) {
    messagesContainer.append(welcomeCard);
    welcomeCard.style.display = 'block';
    return;
  }
  welcomeCard.style.display = 'none';
  messages.forEach((m) => {
    const bubble = appendMessageBubble(m.role, m.content, m.meta);
    if (m.role === 'assistant' && m.meta && Array.isArray(m.meta.toolCalls)) renderSavedToolCalls(bubble, m.meta.toolCalls);
  });
  scrollToBottom();
}

function renderSavedToolCalls(bubble, toolCalls) {
  if (toolCalls.length === 0) return;
  const strip = h('div', { class: 'turn-meta' });
  toolCalls.forEach((call) => {
    strip.append(toolChip(`tool: ${call.name} - ${call.ok ? 'done' : `error${call.error ? `: ${String(call.error).slice(0, 120)}` : ''}`}`, call.ok ? 'done' : 'error'));
  });
  bubble.prepend(strip);
}

const TRUNCATED_NOTICE = 'Reply cut off at the output limit; it is incomplete.';

function appendMessageBubble(role, content, meta = null) {
  if (welcomeCard) welcomeCard.style.display = 'none';

  const avatar = h('div', { class: `avatar ${role === 'user' ? 'user' : 'ai'}`, 'aria-hidden': 'true' }, role === 'user' ? '👤' : '⚡');
  const bubble = h('div', { class: 'message-bubble', dataset: { testid: role === 'user' ? 'user-message' : 'assistant-message' } });
  bubble.innerHTML = role === 'user' ? formatMarkdown(content) : formatFinalMarkdown(content);

  if (meta && meta.truncated) bubble.append(h('div', { class: 'stream-stopped', dataset: { testid: 'reply-truncated' } }, TRUNCATED_NOTICE));
  else if (meta && meta.partial) bubble.append(h('div', { class: 'stream-stopped' }, 'Response stopped early'));
  if (meta && meta.sources) appendSourcePills(bubble, meta.sources);

  const row = h('div', { class: `message-row ${role}` }, role === 'user' ? [bubble, avatar] : [avatar, bubble]);
  messagesContainer.append(row);
  scrollToBottom();
  return bubble;
}

function appendSourcePills(bubble, sources) {
  if (!Array.isArray(sources) || sources.length === 0) return;
  const container = h('div', { class: 'source-pill-container', dataset: { testid: 'sources' } });
  sources.forEach((src, idx) => {
    const href = safeHttpUrl(src);
    const label = `🔗 Source ${idx + 1}`;
    if (!href) {
      container.append(h('span', { class: 'source-pill' }, `${label} (link withheld)`));
      return;
    }
    container.append(h('a', { class: 'source-pill', href, target: '_blank', rel: 'noopener noreferrer' }, label));
  });
  bubble.append(container);
}

function appendStreamError(bubble, message) {
  bubble.append(h('div', { class: 'stream-error', role: 'alert', dataset: { testid: 'chat-error' } }, message));
}

function toolChip(text, state) {
  return h('span', { class: `tool-chip is-${state}`, dataset: { testid: 'tool-chip' } }, text);
}

function scrollToBottom() {
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function setStreamingUi(isStreaming) {
  sendBtn.disabled = isStreaming;
  stopBtn.hidden = !isStreaming;
}

function stopActiveStream() {
  if (!activeStream) return;
  activeStream.controller.abort();
  if (activeStream.reader) activeStream.reader.cancel().catch(() => {});
}

stopBtn.addEventListener('click', stopActiveStream);

// Copy buttons are rendered inside bubble HTML, so one delegated listener covers every code block.
messagesContainer.addEventListener('click', async (e) => {
  const btn = e.target.closest('.copy-code-btn');
  if (!btn) return;
  const code = btn.closest('.code-block')?.querySelector('code');
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code.textContent ?? '');
    btn.textContent = 'Copied';
  } catch (err) {
    console.error('[Jarvis] Copy to clipboard failed:', err);
    btn.textContent = 'Copy failed';
  }
  setTimeout(() => (btn.textContent = 'Copy'), 1500);
});

// ---- Image attachments -------------------------------------------------------------------------------------------

function renderAttachments() {
  attachmentTray.replaceChildren();
  attachmentTray.hidden = attachments.length === 0;
  attachments.forEach((item) => {
    const stateText =
      item.state === 'describing'
        ? 'Describing with a local vision model...'
        : item.state === 'ready'
          ? `Described by ${item.model || 'a vision model'}`
          : `Not described: ${item.reason}`;
    const remove = h(
      'button',
      {
        type: 'button',
        class: 'attachment-remove',
        'aria-label': `Remove ${item.name}`,
        dataset: { testid: 'attachment-remove' },
        onclick: () => {
          attachments = attachments.filter((candidate) => candidate.id !== item.id);
          renderAttachments();
        },
      },
      '✕'
    );
    attachmentTray.append(
      h(
        'div',
        { class: `attachment-chip is-${item.state}`, dataset: { testid: 'attachment' } },
        h('img', { src: item.dataUrl, alt: '', class: 'attachment-thumb' }),
        h('div', { class: 'attachment-info' }, h('span', { class: 'attachment-name' }, item.name), h('span', { class: 'attachment-state', role: 'status' }, stateText)),
        remove
      )
    );
  });
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'));
    reader.readAsDataURL(file);
  });
}

/** Applies the attachment cap to a whole batch (multi-select, drop, paste) before any file is read. */
function addImageFiles(files) {
  const plan = planImageFiles(files, attachments.length, MAX_ATTACHMENTS);
  if (plan.rejectedCount > 0) modelNote.textContent = attachmentLimitMessage(MAX_ATTACHMENTS, plan.rejectedCount);
  plan.accepted.forEach((file) => void addImageFile(file));
}

async function addImageFile(file) {
  // The slot is taken before the first `await`, so a batch of files cannot all pass the cap check in one tick.
  const item = { id: ++attachmentCounter, name: file.name || 'pasted image', dataUrl: 'data:,', state: 'describing' };
  attachments.push(item);
  renderAttachments();
  if (file.size > MAX_IMAGE_BYTES) {
    item.state = 'unavailable';
    item.reason = `the image is ${formatBytes(file.size)}, over the ${formatBytes(MAX_IMAGE_BYTES)} limit`;
    renderAttachments();
    return;
  }
  try {
    item.dataUrl = await readAsDataUrl(file);
  } catch (err) {
    item.state = 'unavailable';
    item.reason = err instanceof Error ? err.message : String(err);
    renderAttachments();
    return;
  }
  renderAttachments();

  const result = await requestJson('/api/media/describe', jsonRequest('POST', { imageBase64: item.dataUrl }));
  if (result.ok && result.data && result.data.available) {
    item.state = 'ready';
    item.description = result.data.text;
    item.model = result.data.model;
  } else {
    item.state = 'unavailable';
    item.reason = result.ok ? (result.data?.reason ?? 'no description was returned') : result.error;
  }
  renderAttachments();
}

attachBtn.addEventListener('click', () => imageInput.click());
imageInput.addEventListener('change', () => {
  addImageFiles([...imageInput.files]);
  imageInput.value = '';
});
promptInput.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files ?? [])].filter((file) => file.type.startsWith('image/'));
  if (files.length === 0) return;
  e.preventDefault();
  addImageFiles(files);
});
['dragenter', 'dragover'].forEach((type) =>
  dropZone.addEventListener(type, (e) => {
    if (![...(e.dataTransfer?.types ?? [])].includes('Files')) return;
    e.preventDefault();
    dropZone.classList.add('is-dragging');
  })
);
['dragleave', 'drop'].forEach((type) => dropZone.addEventListener(type, () => dropZone.classList.remove('is-dragging')));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  addImageFiles([...(e.dataTransfer?.files ?? [])]);
});

// ---- Sending -----------------------------------------------------------------------------------------------------

chatForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const prompt = promptInput.value.trim();
  if (!prompt || activeStream || submitting) return;
  if (attachments.some((item) => item.state === 'describing')) {
    modelNote.textContent = 'Wait for the image description to finish.';
    return;
  }

  // Set before the first `await`: a second Enter while the session is being created must not start another turn.
  submitting = true;
  sendBtn.disabled = true;
  if (!currentSessionId) {
    if (!(await createNewSession(deriveSessionTitle(prompt)))) {
      submitting = false;
      sendBtn.disabled = false;
      return;
    }
  }
  const streamSessionId = currentSessionId;
  const sentItems = attachments;
  const sentAttachments = attachments.map((item) => ({ kind: 'image', ...(item.state === 'ready' ? { description: item.description } : {}) }));
  const attachmentNote = attachments.map((item) => `📎 ${item.name}${item.state === 'ready' ? '' : ' (not described)'}`);

  promptInput.value = '';
  promptInput.style.height = 'auto';
  attachments = [];
  renderAttachments();

  const userBubble = appendMessageBubble('user', prompt);
  if (attachmentNote.length > 0) userBubble.append(h('div', { class: 'attachment-note' }, attachmentNote.join('  ')));

  // The AI bubble has a fixed structure so streaming only ever rewrites the text part.
  const aiBubble = appendMessageBubble('assistant', '');
  aiBubble.replaceChildren();
  const meta = h('div', { class: 'turn-meta', dataset: { testid: 'turn-meta' } });
  const textEl = h('div', { class: 'turn-text' }, 'Thinking...');
  aiBubble.append(meta, textEl);

  const controller = new AbortController();
  activeStream = { controller, reader: null };
  setStreamingUi(true);
  announce('Jarvis is answering.');

  let accumulated = '';
  let sources = [];
  let streamError = null;
  let partial = false;
  let truncated = false;
  const toolTracker = createToolChipTracker();
  const toolChips = new Map();
  let requestAccepted = false;
  const requestedModel = modelSelect.value;

  const showStatus = (text) => meta.append(h('div', { class: 'turn-status', role: 'status', dataset: { testid: 'turn-status' } }, text));
  const showTool = (tool) => {
    const update = toolTracker.update(tool);
    let chip = toolChips.get(update.callId);
    if (!chip) {
      chip = toolChip('', 'requested');
      toolChips.set(update.callId, chip);
      meta.append(chip);
    }
    chip.textContent = update.text;
    chip.className = `tool-chip is-${update.state}`;
    chip.title = update.title;
  };

  try {
    const res = await apiFetch(
      '/api/chat/stream',
      jsonRequest(
        'POST',
        {
          sessionId: streamSessionId,
          prompt,
          model: modelSelect.value || undefined,
          useResearch: researchToggle.checked,
          ...(sentAttachments.length > 0 ? { attachments: sentAttachments } : {}),
        },
        { signal: controller.signal }
      )
    );

    if (!res.ok) throw new Error(await errorMessageFrom(res));
    requestAccepted = true;

    textEl.textContent = '';
    const reader = res.body.getReader();
    activeStream.reader = reader;
    const parser = createSseParser();
    let receivedDone = false;

    const handlePayload = (payload) => {
      if (receivedDone) return;
      if (payload === '[DONE]') {
        receivedDone = true;
        return;
      }
      let data;
      try {
        data = JSON.parse(payload);
      } catch (err) {
        console.error('[Jarvis] Dropped unparseable SSE frame:', payload, err);
        return;
      }
      if (typeof data.chunk === 'string') accumulated += data.chunk;
      if (Array.isArray(data.sources)) sources = data.sources;
      if (typeof data.status === 'string') showStatus(data.status);
      if (data.model && typeof data.model === 'object') {
        // A different model than the one picked means the pipeline replaced it; its rationale says why.
        showStatus(
          requestedModel && data.model.model !== requestedModel
            ? `Using ${data.model.model} instead of ${requestedModel}: ${String(data.model.rationale ?? '').slice(0, 300)}`
            : `Model: ${data.model.model} (${data.model.lane})`
        );
        if (typeof data.model.model === 'string') setModelTag(data.model.model);
      }
      if (data.tool && typeof data.tool === 'object') showTool(data.tool);
      if (typeof data.error === 'string') streamError = data.error;
      if (data.partial === true) partial = true;
      if (data.truncated === true) truncated = true;
    };

    while (!receivedDone) {
      const { value, done } = await reader.read();
      const payloads = done ? parser.end() : parser.push(value);
      payloads.forEach(handlePayload);
      textEl.innerHTML = formatStreamingMarkdown(accumulated);
      scrollToBottom();
      if (done) break;
    }
    if (receivedDone) await reader.cancel().catch(() => {});

    textEl.innerHTML = accumulated ? formatFinalMarkdown(accumulated) : '';
    if (controller.signal.aborted) aiBubble.append(h('div', { class: 'stream-stopped' }, 'Stopped'));
    else if (truncated) aiBubble.append(h('div', { class: 'stream-stopped', dataset: { testid: 'reply-truncated' } }, TRUNCATED_NOTICE));
    else if (partial) aiBubble.append(h('div', { class: 'stream-stopped' }, 'Response stopped early'));
    appendSourcePills(aiBubble, sources);
  } catch (err) {
    if (controller.signal.aborted) {
      textEl.innerHTML = accumulated ? formatFinalMarkdown(accumulated) : '';
      aiBubble.append(h('div', { class: 'stream-stopped' }, 'Stopped'));
      appendSourcePills(aiBubble, sources);
    } else {
      textEl.innerHTML = accumulated ? formatFinalMarkdown(accumulated) : '';
      streamError = err instanceof Error ? err.message : String(err);
    }
  } finally {
    // A turn the server never accepted keeps its described images so the owner can resend without re-attaching.
    if (!requestAccepted && sentItems.length > 0) {
      attachments = [...sentItems, ...attachments].slice(0, MAX_ATTACHMENTS);
      renderAttachments();
    }
    if (streamError) {
      appendStreamError(aiBubble, accumulated ? streamError : `Jarvis could not answer: ${streamError}`);
      // The prompt was not answered, so it goes back into the composer ready to resend.
      if (!accumulated && !promptInput.value) {
        promptInput.value = prompt;
        promptInput.dispatchEvent(new Event('input'));
      }
    }
    activeStream = null;
    submitting = false;
    setStreamingUi(false);
    announce(streamError ? 'Jarvis could not finish answering.' : controller.signal.aborted ? 'Stopped.' : 'Jarvis finished answering.');
    promptInput.focus();
    loadSessions(); // Update session timestamp & order
    document.dispatchEvent(new CustomEvent('jarvis:turn-finished'));
  }
});

document.querySelectorAll('.prompt-chip').forEach((btn) => {
  btn.addEventListener('click', () => {
    promptInput.value = btn.dataset.prompt;
    promptInput.focus();
  });
});

promptInput.addEventListener('input', () => {
  promptInput.style.height = 'auto';
  promptInput.style.height = `${Math.min(promptInput.scrollHeight, 140)}px`;
});

promptInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    chatForm.requestSubmit();
  }
});

newChatBtn.addEventListener('click', () => {
  if (submitting) return;
  startNewChatView();
  closeSidebarOnMobile();
});
modelSelect.addEventListener('change', () => setModelTag(modelSelect.value));

// ---- Sidebar drawer on narrow screens ----------------------------------------------------------------------------

const narrowQuery = window.matchMedia('(max-width: 860px)');

/** A closed drawer is only translated off-screen by CSS, so `inert` is what removes it from the tab order. */
function syncDrawerAccessibility() {
  const hidden = isDrawerHidden(narrowQuery.matches, sidebar.classList.contains('is-open'));
  sidebar.inert = hidden;
  if (hidden) sidebar.setAttribute('aria-hidden', 'true');
  else sidebar.removeAttribute('aria-hidden');
}

function closeSidebarOnMobile({ restoreFocus = false } = {}) {
  sidebar.classList.remove('is-open');
  sidebarToggle.setAttribute('aria-expanded', 'false');
  syncDrawerAccessibility();
  if (restoreFocus && narrowQuery.matches) sidebarToggle.focus();
}

sidebarToggle.addEventListener('click', () => {
  const open = sidebar.classList.toggle('is-open');
  sidebarToggle.setAttribute('aria-expanded', String(open));
  syncDrawerAccessibility();
  if (open) (sidebar.querySelector('button, select, input') ?? sidebar).focus();
});
narrowQuery.addEventListener('change', syncDrawerAccessibility);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && sidebar.classList.contains('is-open') && narrowQuery.matches) closeSidebarOnMobile({ restoreFocus: true });
});
// The overlay is a box-shadow, so a tap outside the drawer arrives as a click on whatever lies beneath it.
document.addEventListener('click', (e) => {
  if (!sidebar.classList.contains('is-open') || !narrowQuery.matches) return;
  if (sidebar.contains(e.target) || sidebarToggle.contains(e.target)) return;
  closeSidebarOnMobile();
});
syncDrawerAccessibility();

// ---- Models ------------------------------------------------------------------------------------------------------

function describeModel(model) {
  const parts = [];
  if (model.parameterSize) parts.push(model.parameterSize);
  if (Number.isFinite(model.sizeBytes)) parts.push(formatBytes(model.sizeBytes));
  const flags = [];
  if (model.loaded) flags.push('loaded');
  if (model.fits === false) flags.push('does not fit now');
  const base = parts.length > 0 ? `${model.name} (${parts.join(', ')})` : model.name;
  return flags.length > 0 ? `${base} - ${flags.join(', ')}` : base;
}

const modelRetryButton = h('button', { type: 'button', class: 'btn btn-ghost model-retry', hidden: true, dataset: { testid: 'model-retry' } }, 'Retry loading models');
modelNote.after(modelRetryButton);
modelRetryButton.addEventListener('click', () => void loadModels());

function setModelsUnavailable(message) {
  modelsUnavailable = true;
  modelSelect.replaceChildren(h('option', { value: '', disabled: true, selected: true }, `Models unavailable: ${message}`));
  modelNote.textContent = message;
  modelRetryButton.hidden = false;
  setModelTag('');
  // Ollama may simply still be starting, so keep asking with a growing delay until it answers.
  clearTimeout(modelRetryTimer);
  modelRetryTimer = setTimeout(() => void loadModels(), modelRetryDelayMs(modelRetryAttempt++));
}

export async function loadModels() {
  clearTimeout(modelRetryTimer);
  const result = await requestJson('/api/models');
  const data = result.data ?? {};
  if (!result.ok || !Array.isArray(data.models) || data.models.length === 0) {
    setModelsUnavailable(result.error || 'No models installed');
    return;
  }
  modelsUnavailable = false;
  modelRetryAttempt = 0;
  modelRetryButton.hidden = true;
  const previous = modelSelect.value;
  modelSelect.replaceChildren();
  const details = new Map((data.modelDetails ?? []).map((d) => [d.name, d]));
  data.models.forEach((name) => {
    const detail = details.get(name) ?? { name };
    modelSelect.append(h('option', { value: name, dataset: { fits: String(detail.fits), loaded: String(Boolean(detail.loaded)) } }, describeModel(detail)));
  });
  // The server's resident baseline is preselected; a restored session overrides it in `selectSession`.
  const initial = data.models.includes(previous) ? previous : data.models.includes(data.active) ? data.active : data.models[0];
  modelSelect.value = initial;
  setModelTag(initial);
  modelNote.textContent = data.stale ? `Ollama stopped answering; showing the last known list (${data.error ?? 'no detail'}).` : '';
}

/** Re-fetches the list only while the picker is stuck on 'Models unavailable'. */
function reloadModelsIfUnavailable() {
  if (modelsUnavailable) void loadModels();
}
modelSelect.addEventListener('focus', reloadModelsIfUnavailable);

export function initChat() {
  loadModels();
  loadSessions();
  return { reloadModels: reloadModelsIfUnavailable };
}
