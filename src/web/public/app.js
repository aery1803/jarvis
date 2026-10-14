/**
 * Jarvis Local AI: Client-Side Web Application
 * Authority: FEAT-004
 */

let currentSessionId = null;

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

  // Render cited sources if present
  if (meta && meta.sources && meta.sources.length > 0) {
    const sourcesDiv = document.createElement('div');
    sourcesDiv.className = 'source-pill-container';
    meta.sources.forEach((src, idx) => {
      const a = document.createElement('a');
      a.className = 'source-pill';
      a.href = src;
      a.target = '_blank';
      a.textContent = `🔗 Source ${idx + 1}`;
      sourcesDiv.appendChild(a);
    });
    bubble.appendChild(sourcesDiv);
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

// Simple markdown formatter for bold, italics, code blocks, lists
function formatMarkdown(text) {
  if (!text) return '';
  let escaped = escapeHtml(text);

  // Code blocks: ```lang ... ```
  escaped = escaped.replace(/```([a-zA-Z0-9]*)\n([\s\S]*?)```/g, (match, lang, code) => {
    return `<pre><code>${code.trim()}</code></pre>`;
  });

  // Inline code: `...`
  escaped = escaped.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Bold: **...**
  escaped = escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // Italic: *...*
  escaped = escaped.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  // Line breaks
  escaped = escaped.replace(/\n/g, '<br>');

  return escaped;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function scrollToBottom() {
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// Handle Form Submission with Real-Time Streaming
chatForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const prompt = promptInput.value.trim();
  if (!prompt) return;

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
  sendBtn.disabled = true;

  try {
    const res = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
    let accumulated = '';
    let sources = [];

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let done = false;

    while (!done) {
      const { value, done: streamDone } = await reader.read();
      done = streamDone;
      if (value) {
        const text = decoder.decode(value);
        const lines = text.split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const dataStr = line.slice(6);
            if (dataStr === '[DONE]') break;
            try {
              const data = JSON.parse(dataStr);
              if (data.chunk) {
                accumulated += data.chunk;
                aiBubble.innerHTML = formatMarkdown(accumulated);
                scrollToBottom();
              }
              if (data.sources) {
                sources = data.sources;
              }
            } catch (err) {
              // Ignore non-json chunks
            }
          }
        }
      }
    }

    // Append source pills if present
    if (sources.length > 0) {
      const sourcesDiv = document.createElement('div');
      sourcesDiv.className = 'source-pill-container';
      sources.forEach((src, idx) => {
        const a = document.createElement('a');
        a.className = 'source-pill';
        a.href = src;
        a.target = '_blank';
        a.textContent = `🔗 Source ${idx + 1}`;
        sourcesDiv.appendChild(a);
      });
      aiBubble.appendChild(sourcesDiv);
    }
  } catch (err) {
    aiBubble.innerHTML = `<span style="color:#ff4d4f;">Error generating response: ${err.message}</span>`;
  } finally {
    sendBtn.disabled = false;
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
        const lane = m.includes('coder') ? '(Code Lane - 141 t/s)' : '(Reasoning Lane - 41 t/s)';
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

// Initial boot
checkHealth();
loadModels();
loadSessions();
