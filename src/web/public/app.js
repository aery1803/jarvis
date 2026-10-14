/**
 * Jarvis Local AI: Client-Side Web Application
 * Authority: FEAT-004
 *
 * Boots the Chat and Dashboard tabs, the owner-approval banner, and the health and kill-switch indicators.
 */

import { requestJson, formatGb } from './api.js';
import { initChat } from './chat.js';
import { initApprovals } from './approvals.js';
import { initDashboard } from './dashboard.js';

const HEALTH_REFRESH_MS = 10_000;

const statusText = document.getElementById('statusText');
const statusDot = document.getElementById('statusDot');
const killBanner = document.getElementById('killBanner');
const tabs = [
  { button: document.getElementById('tabChat'), panel: document.getElementById('panelChat'), name: 'chat' },
  { button: document.getElementById('tabDashboard'), panel: document.getElementById('panelDashboard'), name: 'dashboard' },
];

// Host RAM and the separate GPU (Vulkan) pool, refreshed periodically; the dot reflects the last call.
async function checkHealth() {
  const result = await requestJson('/api/health');
  if (!result.ok) {
    statusText.textContent = 'Service: Offline';
    statusDot.className = 'status-dot is-bad';
    return;
  }
  const data = result.data;
  const lines = [`Host RAM: ${formatGb(data.freeMemoryBytes)} / ${formatGb(data.totalMemoryBytes)} GB free`];
  if (Number.isFinite(data.vramFreeBytes) && Number.isFinite(data.vramTotalBytes)) {
    lines.push(`GPU pool: ${formatGb(data.vramFreeBytes)} / ${formatGb(data.vramTotalBytes)} GB free`);
  }
  statusText.textContent = lines.join(' · ');
  statusDot.className = 'status-dot is-ok';

  const killed = Boolean(data.killSwitch && data.killSwitch.engaged);
  killBanner.hidden = !killed;
  killBanner.textContent = killed ? `Kill switch engaged${data.killSwitch.reason ? `: ${data.killSwitch.reason}` : ''}. Jarvis is not answering. Reset it on the Dashboard.` : '';
}

const dashboard = initDashboard({ onKillChange: checkHealth });
let chat = null;

function selectTab(name, { focus = false } = {}) {
  tabs.forEach((tab) => {
    const active = tab.name === name;
    tab.button.classList.toggle('is-active', active);
    tab.button.setAttribute('aria-selected', String(active));
    tab.button.tabIndex = active ? 0 : -1;
    tab.panel.hidden = !active;
    if (active && focus) tab.button.focus();
  });
  if (name === 'dashboard') {
    dashboard.show();
    chat?.reloadModels();
  } else dashboard.hide();
  try {
    history.replaceState(null, '', name === 'dashboard' ? '#dashboard' : '#chat');
  } catch {
    // The hash is only a convenience.
  }
}

tabs.forEach((tab, index) => {
  tab.button.addEventListener('click', () => selectTab(tab.name));
  tab.button.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const next = tabs[(index + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    selectTab(next.name, { focus: true });
  });
});

document.addEventListener('jarvis:approval-decided', () => void checkHealth());

chat = initChat();
initApprovals();
checkHealth();
setInterval(checkHealth, HEALTH_REFRESH_MS);
selectTab(location.hash === '#dashboard' ? 'dashboard' : 'chat');
