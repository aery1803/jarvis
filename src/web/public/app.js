/**
 * Jarvis Local AI: Client-Side Web Application
 * Authority: FEAT-004
 */

import { formatMarkdown, formatStreamingMarkdown, formatFinalMarkdown, escapeHtml } from './markdown.js';
import { createSseParser } from './sse.js';

let currentSessionId = null;
let activeStream = null; // { controller: AbortController, reader: ReadableStreamDefaultReader | null }
let sessionsById = new Map();
let selectionToken = 0;

const HEALTH_REFRESH_MS = 30_000;
const BYTES_PER_GB = 1024 * 1024 * 1024;

const sessionList = document.getElementById('sessionList');
const newChatBtn = document.getElementById('newChatBtn');
const modelSelect = document.getElementById('modelSelect');
const researchToggle = document.getElementById('researchToggle');
const currentChatTitle = document.getElementById('currentChatTitle');
const currentModelTag = document.getElementById('currentModelTag');
const messagesContainer = document.getElementById('messagesContainer');
const welcomeCard = document.getElementById('welcomeCard');
const chatForm = document.getElementById('chatForm');
const promptInput = document.getElementById('promptInput');
const sendBtn = document.getElementById('sendBtn');
const stopBtn = document.getElementById('stopBtn');
const statusText = document.getElementById('statusText');
const statusDot = document.getElementById('statusDot');
const killBanner = document.getElementById('killBanner');

/** Every state-changing request carries `X-Jarvis-Client`, which the server requires and a cross-site page cannot add. */
function apiFetch(url, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (options.method && options.method !== 'GET') {
    headers['X-Jarvis-Client'] = 'web';
  }
  return fetch(url, { ...options, headers });
}

function jsonRequest(method, body, extra = {}) {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...extra };
}

async function errorMessageFrom(res) {
  try {
    const data = await res.json();
    if (data && typeof data.error === 'string') return data.error;
  } catch {
    // Fall through to the status line.
  }
  return `HTTP ${res.status}${res.statusText ? `: ${res.statusText}` : ''}`;
}

/** Only http(s) URLs may become links; anything else (for example `javascript:`) is shown as text. */
function safeHttpUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function formatGb(bytes) {
  return (bytes / BYTES_PER_GB).toFixed(1);
}

function setModelTag(model) {
  currentModelTag.textContent = model || '';
}

// Host RAM and the separate GPU (Vulkan) pool, refreshed periodically; the dot reflects the last call.
async function checkHealth() {
  try {
    const res = await fetch('/api/health');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const lines = [`Host RAM: ${formatGb(data.freeMemoryBytes)} / ${formatGb(data.totalMemoryBytes)} GB free`];
    if (Number.isFinite(data.vramFreeBytes) && Number.isFinite(data.vramTotalBytes)) {
      lines.push(`GPU pool: ${formatGb(data.vramFreeBytes)} / ${formatGb(data.vramTotalBytes)} GB free`);
    }
    statusText.textContent = lines.join('\n');
    statusDot.className = 'status-dot is-ok';

    const killed = Boolean(data.killSwitch && data.killSwitch.engaged);
    killBanner.hidden = !killed;
    killBanner.textContent = killed ? `Kill switch engaged${data.killSwitch.reason ? `: ${data.killSwitch.reason}` : ''}. Jarvis is not answering.` : '';
  } catch (err) {
    statusText.textContent = 'Service: Offline';
    statusDot.className = 'status-dot is-bad';
  }
}

// Fetch and render conversation list
async function loadSessions() {
  try {
    const res = await fetch('/api/sessions');
    if (!res.ok) throw new Error(await errorMessageFrom(res));
    const sessions = await res.json();
    sessionsById = new Map(sessions.map((s) => [s.id, s]));
    sessionList.replaceChildren();

    if (sessions.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-sessions';
      empty.textContent = 'No chats yet';
      sessionList.appendChild(empty);
      return;
    }

    sessions.forEach((s) => {
      const item = document.createElement('div');
      item.className = `session-item ${s.id === currentSessionId ? 'active' : ''}`;

      const title = document.createElement('span');
      title.className = 'session-title';
      title.textContent = s.title || 'Untitled Chat';

      const del = document.createElement('button');
      del.className = 'delete-session-btn';
      del.title = 'Delete chat';
      del.dataset.id = s.id;
      del.textContent = '✕';

      item.append(title, del);
      item.addEventListener('click', (e) => {
        if (e.target.classList.contains('delete-session-btn')) {
          e.stopPropagation();
          deleteSession(s.id);
        } else {
          selectSession(s.id);
        }
      });

      sessionList.appendChild(item);
    });
  } catch (err) {
    console.error('Failed to load sessions:', err);
  }
}

/** Selects `model` in the dropdown, adding an option for a model that is no longer installed so the header never lies. */
function applyModel(model) {
  if (!model) return;
  if (![...modelSelect.options].some((o) => o.value === model)) {
    const opt = document.createElement('option');
    opt.value = model;
    opt.textContent = `${model} (not installed)`;
    modelSelect.appendChild(opt);
  }
  modelSelect.value = model;
  setModelTag(model);
}

// Create new chat session
async function createNewSession(initialTitle = 'New Conversation') {
  stopActiveStream();
  try {
    const model = modelSelect.value;
    const res = await apiFetch('/api/sessions', jsonRequest('POST', { title: initialTitle, model }));
    if (!res.ok) throw new Error(await errorMessageFrom(res));

    const session = await res.json();
    currentSessionId = session.id;
    currentChatTitle.textContent = session.title;
    setModelTag(session.model);
    await loadSessions();
    renderMessages([]);
    promptInput.focus();
    return true;
  } catch (err) {
    console.error('Failed to create session:', err);
    return false;
  }
}

// Select an existing session
async function selectSession(sessionId) {
  // A reply still streaming into the old chat is stopped (the server keeps the partial text) instead of
  // being left to render into a view that is gone.
  stopActiveStream();
  const token = ++selectionToken;
  currentSessionId = sessionId;

  try {
    const [res] = await Promise.all([fetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages`), loadSessions()]);
    if (!res.ok) throw new Error(await errorMessageFrom(res));
    const messages = await res.json();
    if (token !== selectionToken) return;
    renderMessages(messages);

    const session = sessionsById.get(sessionId);
    currentChatTitle.textContent = session?.title || 'Untitled Chat';
    if (session?.model) applyModel(session.model);
  } catch (err) {
    console.error('Failed to load messages:', err);
  }
}

// Delete session
async function deleteSession(sessionId) {
  try {
    if (currentSessionId === sessionId) stopActiveStream();
    const res = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(await errorMessageFrom(res));
    if (currentSessionId === sessionId) {
      currentSessionId = null;
      currentChatTitle.textContent = 'New Conversation';
      renderMessages([]);
    }
    await loadSessions();
  } catch (err) {
    console.error('Failed to delete session:', err);
  }
}

// Render message list
function renderMessages(messages) {
  messagesContainer.replaceChildren();

  if (messages.length === 0) {
    messagesContainer.appendChild(welcomeCard);
    welcomeCard.style.display = 'block';
    return;
  }

  welcomeCard.style.display = 'none';

  messages.forEach((m) => {
    appendMessageBubble(m.role, m.content, m.meta);
  });

  scrollToBottom();
}

function appendMessageBubble(role, content, meta = null) {
  if (welcomeCard) welcomeCard.style.display = 'none';

  const row = document.createElement('div');
  row.className = `message-row ${role}`;

  const avatar = document.createElement('div');
  avatar.className = `avatar ${role === 'user' ? 'user' : 'ai'}`;
  avatar.textContent = role === 'user' ? '👤' : '⚡';

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  bubble.innerHTML = role === 'user' ? formatMarkdown(content) : formatFinalMarkdown(content);

  if (meta && meta.partial) {
    bubble.insertAdjacentHTML('beforeend', '<div class="stream-stopped">Response stopped early</div>');
  }
  if (meta && meta.sources) {
    appendSourcePills(bubble, meta.sources);
  }

  if (role === 'user') {
    row.appendChild(bubble);
    row.appendChild(avatar);
  } else {
    row.appendChild(avatar);
    row.appendChild(bubble);
  }

  messagesContainer.appendChild(row);
  scrollToBottom();
  return bubble;
}

function appendSourcePills(bubble, sources) {
  if (!Array.isArray(sources) || sources.length === 0) return;
  const sourcesDiv = document.createElement('div');
  sourcesDiv.className = 'source-pill-container';
  sources.forEach((src, idx) => {
    const href = safeHttpUrl(src);
    const label = `🔗 Source ${idx + 1}`;
    if (!href) {
      const text = document.createElement('span');
      text.className = 'source-pill';
      text.textContent = `${label} (link withheld)`;
      sourcesDiv.appendChild(text);
      return;
    }
    const a = document.createElement('a');
    a.className = 'source-pill';
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = label;
    sourcesDiv.appendChild(a);
  });
  bubble.appendChild(sourcesDiv);
}

function appendStreamError(bubble, message) {
  const box = document.createElement('div');
  box.className = 'stream-error';
  box.setAttribute('role', 'alert');
  box.textContent = message;
  bubble.appendChild(box);
}

function scrollToBottom() {
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function setStreamingUi(isStreaming) {
  sendBtn.disabled = isStreaming;
  if (stopBtn) stopBtn.hidden = !isStreaming;
}

function stopActiveStream() {
  if (!activeStream) return;
  activeStream.controller.abort();
  if (activeStream.reader) activeStream.reader.cancel().catch(() => {});
}

if (stopBtn) {
  stopBtn.addEventListener('click', stopActiveStream);
}

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

// Handle Form Submission with Real-Time Streaming
chatForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const prompt = promptInput.value.trim();
  if (!prompt || activeStream) return;

  if (!currentSessionId) {
    if (!(await createNewSession(prompt.slice(0, 30)))) return;
  }
  const streamSessionId = currentSessionId;

  // Clear input
  promptInput.value = '';
  promptInput.style.height = 'auto';

  // Append user bubble
  appendMessageBubble('user', prompt);

  // Append empty AI bubble for streaming; this stream stays bound to it whatever the view does later.
  const aiBubble = appendMessageBubble('assistant', 'Thinking...');
  const controller = new AbortController();
  activeStream = { controller, reader: null };
  setStreamingUi(true);

  let accumulated = '';
  let sources = [];
  let streamError = null;

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
        },
        { signal: controller.signal }
      )
    );

    if (!res.ok) {
      throw new Error(await errorMessageFrom(res));
    }

    aiBubble.innerHTML = '';
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
      if (typeof data.error === 'string') streamError = data.error;
    };

    while (!receivedDone) {
      const { value, done } = await reader.read();
      const payloads = done ? parser.end() : parser.push(value);
      payloads.forEach(handlePayload);
      aiBubble.innerHTML = formatStreamingMarkdown(accumulated);
      scrollToBottom();
      if (done) break;
    }
    if (receivedDone) {
      await reader.cancel().catch(() => {});
    }

    aiBubble.innerHTML = formatFinalMarkdown(accumulated);
    if (controller.signal.aborted) {
      aiBubble.insertAdjacentHTML('beforeend', '<div class="stream-stopped">Stopped</div>');
    }
    appendSourcePills(aiBubble, sources);
  } catch (err) {
    if (controller.signal.aborted) {
      aiBubble.innerHTML = `${formatFinalMarkdown(accumulated)}<div class="stream-stopped">Stopped</div>`;
      appendSourcePills(aiBubble, sources);
    } else {
      aiBubble.innerHTML = accumulated ? formatFinalMarkdown(accumulated) : '';
      streamError = err.message;
    }
  } finally {
    if (streamError) {
      appendStreamError(aiBubble, accumulated ? streamError : `Jarvis could not answer: ${streamError}`);
      // The prompt was not answered, so it goes back into the composer ready to resend.
      if (!accumulated && !promptInput.value) {
        promptInput.value = prompt;
        promptInput.dispatchEvent(new Event('input'));
      }
    }
    activeStream = null;
    setStreamingUi(false);
    promptInput.focus();
    loadSessions(); // Update session timestamp & order
  }
});

// Prompt chips click handler
document.querySelectorAll('.prompt-chip').forEach((btn) => {
  btn.addEventListener('click', () => {
    promptInput.value = btn.dataset.prompt;
    promptInput.focus();
  });
});

// Auto-expand textarea
promptInput.addEventListener('input', () => {
  promptInput.style.height = 'auto';
  promptInput.style.height = `${Math.min(promptInput.scrollHeight, 140)}px`;
});

// Shift+Enter vs Enter
promptInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    chatForm.dispatchEvent(new Event('submit'));
  }
});

newChatBtn.addEventListener('click', () => createNewSession());
modelSelect.addEventListener('change', () => {
  setModelTag(modelSelect.value);
});

function describeModel(model) {
  const parts = [];
  if (model.parameterSize) parts.push(model.parameterSize);
  if (Number.isFinite(model.sizeBytes)) parts.push(`${formatGb(model.sizeBytes)} GB`);
  const lane = model.name.includes('coder') ? ' (code)' : '';
  return parts.length > 0 ? `${model.name}${lane} (${parts.join(', ')})` : `${model.name}${lane}`;
}

async function loadModels() {
  try {
    const res = await fetch('/api/models');
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !Array.isArray(data.models) || data.models.length === 0) {
      const message = data.error || (res.ok ? 'No models installed' : `HTTP ${res.status}`);
      modelSelect.replaceChildren();
      const opt = document.createElement('option');
      opt.value = '';
      opt.disabled = true;
      opt.selected = true;
      opt.textContent = `Models unavailable: ${message}`;
      modelSelect.appendChild(opt);
      setModelTag('');
      return;
    }

    const details = new Map((data.modelDetails ?? []).map((d) => [d.name, d]));
    modelSelect.replaceChildren();
    data.models.forEach((name) => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = describeModel(details.get(name) ?? { name });
      modelSelect.appendChild(opt);
    });
    // The server's resident baseline is preselected; a restored session overrides it in `selectSession`.
    const initial = data.models.includes(data.active) ? data.active : data.models[0];
    modelSelect.value = initial;
    setModelTag(initial);
  } catch (err) {
    console.error('Failed to load models:', err);
  }
}

// Benchmark Button Handler
const benchmarkBtn = document.getElementById('benchmarkBtn');
const benchmarkBtnText = document.getElementById('benchmarkBtnText');

function number(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function benchmarkCardHtml(card) {
  const categories = Object.values(card.categories || {})
    .map(
      (c) =>
        `<div>• <strong>${escapeHtml(String(c.category).toUpperCase())}</strong>: ${number(c.percentage)}% (${number(c.passed)}/${number(c.total)}) — avg ${number(c.avgLatencyMs)}ms</div>`
    )
    .join('');
  const lanes = (card.recommendedLanes || []).map((l) => escapeHtml(String(l).toUpperCase())).join(', ');
  const failedCases = (card.results || []).filter((r) => r.notes && String(r.notes).startsWith('Failed:')).length;
  const failedNote = failedCases > 0 ? `<div class="benchmark-meta">${failedCases} case(s) errored and count as failed.</div>` : '';
  return `
    <div class="benchmark-card">
      <h3 class="benchmark-title">Model Benchmark Scorecard</h3>
      <div class="benchmark-headline">
        Model: <code>${escapeHtml(String(card.modelName))}</code> | Score: <span class="benchmark-score">${number(card.overallScore)}%</span> (Grade: ${escapeHtml(String(card.grade))})
      </div>
      <div class="benchmark-meta">
        Estimated throughput: ~${number(card.estimatedTokensPerSec)} t/s | Avg latency: ${number(card.avgLatencyMs)}ms | Host RAM: ${number(card.systemSpecs?.freeMemoryGB)} GB free
      </div>
      ${failedNote}
      <div class="benchmark-categories">${categories}</div>
      <div class="benchmark-lane">Recommended lane: <strong>${lanes}</strong></div>
    </div>`;
}

if (benchmarkBtn) {
  benchmarkBtn.addEventListener('click', async () => {
    const selectedModel = modelSelect.value;
    if (!selectedModel) return;
    if (!currentSessionId && !(await createNewSession('Model Benchmark Report'))) return;

    benchmarkBtn.disabled = true;
    if (benchmarkBtnText) benchmarkBtnText.textContent = 'Testing Model...';

    appendMessageBubble('user', `Run benchmark on model: ${selectedModel}`);
    const bubble = appendMessageBubble('assistant', 'Running the standard benchmark across reasoning, coding, tool calling and retrieval...');

    try {
      const res = await apiFetch('/api/benchmark', jsonRequest('POST', { model: selectedModel }));
      if (!res.ok) {
        throw new Error(await errorMessageFrom(res));
      }
      bubble.innerHTML = benchmarkCardHtml(await res.json());
    } catch (err) {
      bubble.replaceChildren();
      appendStreamError(bubble, `Benchmark failed: ${err.message}`);
    } finally {
      benchmarkBtn.disabled = false;
      if (benchmarkBtnText) benchmarkBtnText.textContent = 'Benchmark Model';
      scrollToBottom();
    }
  });
}

// Initial boot
checkHealth();
setInterval(checkHealth, HEALTH_REFRESH_MS);
loadModels();
loadSessions();
