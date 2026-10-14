/**
 * Jarvis Local AI: Client-Side Web Application
 * Authority: FEAT-004
 */

import { formatMarkdown, formatStreamingMarkdown, escapeHtml } from './markdown.js';
import { createSseParser } from './sse.js';

let currentSessionId = null;
let activeStream = null; // { controller: AbortController, reader: ReadableStreamDefaultReader | null }

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

// Check system health on boot
async function checkHealth() {
  try {
    const res = await fetch('/api/health');
    const data = await res.json();
    const freeGb = (data.freeMemoryBytes / (1024 * 1024 * 1024)).toFixed(1);
    statusText.textContent = `Host RAM: ${freeGb} GB free`;
  } catch (err) {
    statusText.textContent = 'Service: Offline';
  }
}

// Fetch and render conversation list
async function loadSessions() {
  try {
    const res = await fetch('/api/sessions');
    const sessions = await res.json();
    sessionList.innerHTML = '';

    if (sessions.length === 0) {
      sessionList.innerHTML = '<div style="color:#64748b;font-size:0.8rem;padding:8px;">No chats yet</div>';
      return;
    }

    sessions.forEach((s) => {
      const item = document.createElement('div');
      item.className = `session-item ${s.id === currentSessionId ? 'active' : ''}`;
      item.innerHTML = `
        <span class="session-title">${escapeHtml(s.title || 'Untitled Chat')}</span>
        <button class="delete-session-btn" title="Delete chat" data-id="${s.id}">✕</button>
      `;

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

// Create new chat session
async function createNewSession(initialTitle = 'New Conversation') {
  try {
    const model = modelSelect.value;
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: initialTitle, model }),
    });

    const session = await res.json();
    currentSessionId = session.id;
    currentChatTitle.textContent = session.title;
    currentModelTag.textContent = session.model;
    await loadSessions();
    renderMessages([]);
    promptInput.focus();
  } catch (err) {
    console.error('Failed to create session:', err);
  }
}

// Select an existing session
async function selectSession(sessionId) {
  currentSessionId = sessionId;
  await loadSessions();

  try {
    const res = await fetch(`/api/sessions/${sessionId}/messages`);
    const messages = await res.json();
    renderMessages(messages);

    // Update header title
    const activeItem = document.querySelector(`.session-item.active .session-title`);
    if (activeItem) {
      currentChatTitle.textContent = activeItem.textContent;
    }
  } catch (err) {
    console.error('Failed to load messages:', err);
  }
}

// Delete session
async function deleteSession(sessionId) {
  try {
    await fetch(`/api/sessions/${sessionId}`, { method: 'DELETE' });
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
  messagesContainer.innerHTML = '';

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
  bubble.innerHTML = formatMarkdown(content);

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
    const a = document.createElement('a');
    a.className = 'source-pill';
    a.href = src;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = `🔗 Source ${idx + 1}`;
    sourcesDiv.appendChild(a);
  });
  bubble.appendChild(sourcesDiv);
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
    await createNewSession(prompt.slice(0, 30));
  }

  // Clear input
  promptInput.value = '';
  promptInput.style.height = 'auto';

  // Append user bubble
  appendMessageBubble('user', prompt);

  // Append empty AI bubble for streaming
  const aiBubble = appendMessageBubble('assistant', 'Thinking...');
  const controller = new AbortController();
  activeStream = { controller, reader: null };
  setStreamingUi(true);

  let accumulated = '';
  let sources = [];

  try {
    const res = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        sessionId: currentSessionId,
        prompt,
        model: modelSelect.value,
        useResearch: researchToggle.checked,
      }),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
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

    aiBubble.innerHTML = formatMarkdown(accumulated);
    if (controller.signal.aborted) {
      aiBubble.insertAdjacentHTML('beforeend', '<div class="stream-stopped">Stopped</div>');
    }
    appendSourcePills(aiBubble, sources);
  } catch (err) {
    if (controller.signal.aborted) {
      aiBubble.innerHTML = `${formatMarkdown(accumulated)}<div class="stream-stopped">Stopped</div>`;
      appendSourcePills(aiBubble, sources);
    } else {
      aiBubble.innerHTML = `<span style="color:#ff4d4f;">Error generating response: ${escapeHtml(err.message)}</span>`;
    }
  } finally {
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
  currentModelTag.textContent = modelSelect.value;
});

async function loadModels() {
  try {
    const res = await fetch('/api/models');
    const data = await res.json();
    if (data.models && data.models.length > 0) {
      modelSelect.innerHTML = '';
      data.models.forEach((m) => {
        const opt = document.createElement('option');
        opt.value = m;
        const lane = m.includes('coder') ? '(Code Lane - ~38 t/s)' : '(Reasoning Lane - ~41 t/s)';
        opt.textContent = `${m} ${lane}`;
        if (m === data.active || m.includes('7b')) {
          opt.selected = true;
          currentModelTag.textContent = m;
        }
        modelSelect.appendChild(opt);
      });
    }
  } catch {
    // Keep fallback options
  }
}

// Benchmark Button Handler
const benchmarkBtn = document.getElementById('benchmarkBtn');
const benchmarkBtnText = document.getElementById('benchmarkBtnText');

if (benchmarkBtn) {
  benchmarkBtn.addEventListener('click', async () => {
    const selectedModel = modelSelect.value || 'qwen2.5:7b';
    if (!currentSessionId) {
      await createNewSession('Model Benchmark Report');
    }

    benchmarkBtn.disabled = true;
    if (benchmarkBtnText) benchmarkBtnText.textContent = 'Testing Model...';

    // Add user message indicating benchmark started
    appendMessageBubble('user', `Run comprehensive intelligence benchmark on model: ${selectedModel}`);

    // Create assistant message container for results
    const assistantDiv = document.createElement('div');
    assistantDiv.className = 'message assistant-message';
    assistantDiv.innerHTML = `
      <div class="message-sender">⚡ Jarvis Intelligence Engine</div>
      <div class="message-content">⏳ <em>Running standardized benchmark across Reasoning, Coding, Tool Calling, and Retrieval...</em></div>
    `;
    messagesContainer.appendChild(assistantDiv);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;

    try {
      const res = await fetch('/api/benchmark', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: selectedModel }),
      });
      const card = await res.json();

      const contentDiv = assistantDiv.querySelector('.message-content');
      let catHtml = '';
      for (const [, c] of Object.entries(card.categories || {})) {
        const cat = c;
        catHtml += `<div>• <strong>${cat.category.toUpperCase()}</strong>: ${cat.percentage}% (${cat.passed}/${cat.total}) — avg ${cat.avgLatencyMs}ms</div>`;
      }

      contentDiv.innerHTML = `
        <div style="background: #1e293b; border-radius: 8px; padding: 14px; border: 1px solid #38bdf855;">
          <h3 style="color: #38bdf8; margin-top: 0; margin-bottom: 8px;">📊 Model Benchmark Scorecard</h3>
          <div style="font-size: 1.1rem; font-weight: bold; margin-bottom: 8px;">
            Model: <code style="color: #a5f3fc;">${escapeHtml(card.modelName)}</code> | Score: <span style="color: #4ade80;">${card.overallScore}%</span> (Grade: <span style="color: #facc15;">${card.grade}</span>)
          </div>
          <div style="color: #94a3b8; font-size: 0.9rem; margin-bottom: 12px;">
            Estimated Throughput: ~${card.estimatedTokensPerSec} t/s | Avg Latency: ${card.avgLatencyMs}ms | Headroom: ${card.systemSpecs?.freeMemoryGB} GB free
          </div>
          <div style="line-height: 1.6; margin-bottom: 10px;">
            ${catHtml}
          </div>
          <div style="border-top: 1px solid #334155; padding-top: 8px; font-size: 0.9rem; color: #38bdf8;">
            🎯 Recommended Lane: <strong>${(card.recommendedLanes || []).join(', ').toUpperCase()}</strong>
          </div>
        </div>
      `;
    } catch (err) {
      const contentDiv = assistantDiv.querySelector('.message-content');
      if (contentDiv) contentDiv.textContent = `Benchmark failed: ${err.message}`;
    } finally {
      benchmarkBtn.disabled = false;
      if (benchmarkBtnText) benchmarkBtnText.textContent = 'Benchmark Model';
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }
  });
}

// Initial boot
checkHealth();
loadModels();
loadSessions();
