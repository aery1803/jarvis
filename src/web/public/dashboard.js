/**
 * Jarvis Local AI: Dashboard tab. One card per capability; every card shows an honest loading, empty,
 * unavailable or error state and never a placeholder posing as data.
 * Authority: FEAT-004
 */

import { formatFinalMarkdown } from './markdown.js';
import { deviceStatusCells } from './ui-logic.js';
import {
  requestJson,
  jsonRequest,
  h,
  clear,
  meterBar,
  badge,
  tierBadge,
  stateLine,
  table,
  sourceLinks,
  number,
  formatGb,
  formatBytes,
  formatPercent,
  formatDuration,
  formatTime,
} from './api.js';

const RESOURCE_REFRESH_MS = 10_000;
const BENCHMARK_POLL_MS = 1000;
const EVAL_POLL_MS = 2000;

function createCard(id, title, description) {
  const body = h('div', { class: 'card-body' });
  const refreshButton = h('button', { type: 'button', class: 'btn btn-ghost', 'aria-label': `Refresh ${title}`, dataset: { testid: `refresh-${id}` } }, 'Refresh');
  const section = h(
    'section',
    { class: 'card', id: `card-${id}`, dataset: { testid: `card-${id}` }, 'aria-labelledby': `card-${id}-title` },
    h('div', { class: 'card-header' }, h('div', {}, h('h3', { id: `card-${id}-title` }, title), description ? h('p', { class: 'card-description' }, description) : null), refreshButton),
    body
  );
  return { id, section, body, refreshButton };
}

/** Runs `render` into the card body, or shows why there is nothing to show. */
function setLoading(card, text = 'Loading...') {
  if (card.body.childElementCount === 0) card.body.append(stateLine('loading', text));
}

function showError(card, text) {
  clear(card.body).append(stateLine('error', text));
}

// ---- Resources ---------------------------------------------------------------------------------------------------

function buildResources() {
  const card = createCard('resources', 'Resources', 'Host RAM and the separate GPU (Vulkan) pool where model weights live. Refreshes every 10 seconds.');
  card.refresh = async () => {
    setLoading(card);
    const [health, status] = await Promise.all([requestJson('/api/health'), requestJson('/api/status')]);
    if (!health.ok) {
      showError(card, `Resources unavailable: ${health.error}`);
      return;
    }
    const data = health.data;
    const usedHost = number(data.totalMemoryBytes) - number(data.freeMemoryBytes);
    const children = [
      meterBar('Host RAM', usedHost / Math.max(1, number(data.totalMemoryBytes)), `${formatGb(usedHost)} / ${formatGb(data.totalMemoryBytes)} GB used`, 'meter-host-ram'),
    ];
    if (Number.isFinite(data.vramTotalBytes) && Number.isFinite(data.vramFreeBytes)) {
      const usedVram = data.vramTotalBytes - data.vramFreeBytes;
      children.push(meterBar('GPU pool (VRAM)', usedVram / Math.max(1, data.vramTotalBytes), `${formatGb(usedVram)} / ${formatGb(data.vramTotalBytes)} GB used`, 'meter-vram'));
    } else {
      children.push(stateLine('empty', 'GPU pool: unknown (the GPU probe returned no figures on this machine).'));
    }
    if (status.ok) {
      const s = status.data;
      const facts = [
        ['Ollama', s.inventory?.status ?? 'unknown'],
        ['Loaded models', (s.loadedModels ?? []).map((m) => m.name).join(', ') || 'none'],
        ['Heavy model lease', s.activeHeavyModel ?? 'free'],
        ['Queued turns', String(number(s.queueLength))],
        ['Turns running', String(number(s.inFlight))],
        ['Tools registered', String(number(s.toolCount))],
      ];
      children.push(h('dl', { class: 'facts' }, facts.map(([term, value]) => [h('dt', {}, term), h('dd', {}, value)])));
      if (Array.isArray(s.issues) && s.issues.length > 0) {
        children.push(h('ul', { class: 'issue-list', dataset: { testid: 'runtime-issues' } }, s.issues.map((issue) => h('li', {}, issue))));
      }
    } else {
      children.push(stateLine('error', `Runtime status unavailable: ${status.error}`));
    }
    clear(card.body).append(...children);
  };
  return card;
}

// ---- Models ------------------------------------------------------------------------------------------------------

function buildModels() {
  const card = createCard('models', 'Models', 'What Ollama has installed, what is resident now, and what fits in free VRAM right now.');
  card.latest = null;
  card.refresh = async () => {
    setLoading(card);
    const result = await requestJson('/api/models');
    if (!result.ok) {
      card.latest = null;
      showError(card, `Models unavailable: ${result.error}`);
      return;
    }
    const data = result.data;
    card.latest = data;
    if (!Array.isArray(data.modelDetails) || data.modelDetails.length === 0) {
      clear(card.body).append(stateLine('empty', 'Ollama reports no installed models.'));
      return;
    }
    const rows = data.modelDetails.map((model) => [
      h('span', {}, model.name, model.name === data.active ? [' ', badge('default', 'info')] : null),
      model.sizeBytes === null ? 'unknown' : formatBytes(model.sizeBytes),
      model.parameterSize ?? '-',
      model.loaded ? badge('loaded', 'ok') : badge('not loaded', 'neutral'),
      model.fits === true ? badge('fits', 'ok') : model.fits === false ? badge('does not fit now', 'warn', { title: model.fitReason ?? '' }) : badge('unknown', 'neutral'),
    ]);
    clear(card.body).append(
      ...(data.stale ? [stateLine('error', `Ollama stopped answering; this is the last known list (${data.error ?? 'no detail'}).`)] : []),
      table(['Model', 'Size', 'Parameters', 'Resident', 'Fits now'], rows, 'models-table')
    );
  };
  return card;
}

// ---- Cost ledger -------------------------------------------------------------------------------------------------

function buildLedger() {
  const card = createCard('ledger', 'Cost ledger', 'Real token counts and timings reported by the model backend for every call.');
  card.refresh = async () => {
    setLoading(card);
    const result = await requestJson('/api/ledger?limit=15');
    if (!result.ok) {
      showError(card, `Ledger unavailable: ${result.error}`);
      return;
    }
    const { summary, byModel, recent } = result.data;
    if (!summary || number(summary.totalInvocations) === 0) {
      clear(card.body).append(stateLine('empty', 'No model calls recorded yet. Send a chat message and the real usage appears here.'));
      return;
    }
    const modelRows = Object.entries(byModel ?? {}).map(([model, s]) => [model, String(s.totalInvocations), String(s.totalPromptTokens), String(s.totalCompletionTokens), `${number(s.avgTokensPerSec).toFixed(1)}`, formatDuration(s.avgLatencyMs)]);
    const recentRows = (recent ?? []).map((entry) => [formatTime(entry.timestamp), entry.modelId, entry.lane, `${entry.promptTokens} / ${entry.completionTokens}`, number(entry.tokensPerSec).toFixed(1), formatDuration(entry.latencyMs)]);
    clear(card.body).append(
      h('p', { class: 'card-summary', dataset: { testid: 'ledger-summary' } }, `${summary.totalInvocations} calls, ${summary.totalTokens} tokens (${summary.totalPromptTokens} prompt, ${summary.totalCompletionTokens} completion), ${number(summary.avgTokensPerSec).toFixed(1)} tokens/s on average, ${formatDuration(summary.avgLatencyMs)} average latency.`),
      h('h4', {}, 'Per model'),
      table(['Model', 'Calls', 'Prompt tokens', 'Completion tokens', 'Tokens/s', 'Avg latency'], modelRows, 'ledger-models'),
      h('h4', {}, 'Recent calls'),
      table(['When', 'Model', 'Lane', 'Prompt / completion', 'Tokens/s', 'Latency'], recentRows, 'ledger-recent')
    );
  };
  return card;
}

// ---- Benchmark ---------------------------------------------------------------------------------------------------

function buildBenchmark(getModels) {
  const card = createCard('benchmark', 'Benchmark', 'Runs a fixed set of reasoning, coding, tool-calling and retrieval cases on one model at a time.');
  const select = h('select', { id: 'benchmarkModel', 'aria-label': 'Model to benchmark', dataset: { testid: 'benchmark-model' } });
  const runButton = h('button', { type: 'button', class: 'btn btn-primary', id: 'benchmarkRun', dataset: { testid: 'benchmark-run' } }, 'Run benchmark');
  const progressEl = h('div', { class: 'progress-line', dataset: { testid: 'benchmark-progress' }, hidden: true });
  const messageEl = h('div', { class: 'card-message', dataset: { testid: 'benchmark-message' } });
  const results = h('div', { class: 'benchmark-results', dataset: { testid: 'benchmark-results' } });
  card.body.append(h('div', { class: 'control-row' }, h('label', { for: 'benchmarkModel' }, 'Model'), select, runButton), progressEl, messageEl, results);
  let pollTimer = null;
  let localRun = false;

  const renderCards = (cards, lastError) => {
    clear(results);
    if (lastError) results.append(stateLine('error', `Last failed run (${lastError.model}): ${lastError.error}`));
    if (!cards || cards.length === 0) {
      results.append(stateLine('empty', 'No benchmark has completed yet. Choose a model and run one.'));
      return;
    }
    const rows = cards.map((c) => [
      c.modelName,
      c.status === 'complete' ? badge(c.grade, 'ok') : c.status === 'partial' ? badge(`${c.grade} (partial)`, 'warn') : badge(String(c.status), 'error'),
      c.status === 'error' ? 'no score' : `${number(c.overallScore)}%`,
      `${number(c.estimatedTokensPerSec)} (${c.tokensPerSecSource})`,
      formatDuration(c.avgLatencyMs),
      `${c.answeredCases} answered, ${c.erroredCases} errored`,
      formatTime(c.timestamp),
    ]);
    results.append(table(['Model', 'Grade', 'Score', 'Tokens/s', 'Avg latency', 'Cases', 'Run at'], rows, 'benchmark-table'));
    cards.filter((c) => c.error).forEach((c) => results.append(stateLine('error', `${c.modelName}: ${c.error}`)));
  };

  const applyStatus = (data) => {
    const running = data.running;
    runButton.disabled = Boolean(running) || localRun;
    progressEl.hidden = !running;
    clear(progressEl);
    if (running) {
      const p = data.progress;
      const label = p && p.total > 0 ? `Running ${running.model}: case ${p.completed} of ${p.total}` : `Running ${running.model}...`;
      progressEl.append(
        h('span', {}, label),
        h('progress', { max: p && p.total > 0 ? String(p.total) : '1', value: p && p.total > 0 ? String(p.completed) : null, 'aria-label': 'Benchmark progress' })
      );
    }
    renderCards(data.cards, data.lastError);
  };

  // A poll that fires while the browser tab is hidden is not re-armed; `resumePoll` restarts it on visibilitychange.
  const schedulePoll = (running) => {
    clearTimeout(pollTimer);
    card.wantsPoll = running;
    if (running && !document.hidden) pollTimer = setTimeout(() => card.refresh(), BENCHMARK_POLL_MS);
  };
  card.resumePoll = () => {
    if (card.wantsPoll && !document.hidden) void card.refresh();
  };
  card.stopPoll = () => {
    clearTimeout(pollTimer);
    card.wantsPoll = false;
  };

  const fillModels = () => {
    const data = getModels();
    const previous = select.value;
    clear(select);
    if (!data || !Array.isArray(data.modelDetails) || data.modelDetails.length === 0) {
      select.append(h('option', { value: '' }, 'No models available'));
      runButton.disabled = true;
      return;
    }
    data.modelDetails.forEach((m) => select.append(h('option', { value: m.name }, `${m.name}${m.fits === false ? ' (does not fit now)' : ''}`)));
    select.value = data.modelDetails.some((m) => m.name === previous) ? previous : data.models.includes(data.active) ? data.active : data.models[0];
  };
  card.fillModels = fillModels;

  card.refresh = async () => {
    const result = await requestJson('/api/benchmark');
    if (!result.ok) {
      clear(results).append(stateLine('error', `Benchmarks unavailable: ${result.error}`));
      return;
    }
    applyStatus(result.data);
    schedulePoll(Boolean(result.data.running));
  };

  runButton.addEventListener('click', async () => {
    const model = select.value;
    if (!model) {
      messageEl.textContent = 'There is no installed model to benchmark.';
      return;
    }
    localRun = true;
    runButton.disabled = true;
    messageEl.textContent = '';
    messageEl.className = 'card-message';
    schedulePoll(true);
    const result = await requestJson('/api/benchmark', jsonRequest('POST', { model }));
    localRun = false;
    if (!result.ok) {
      messageEl.textContent = result.status === 409 ? result.error : `Benchmark failed: ${result.error}`;
      messageEl.className = 'card-message is-error';
    } else {
      messageEl.textContent = `Benchmark of ${model} finished: ${number(result.data.overallScore)}% (grade ${result.data.grade}).`;
      messageEl.className = 'card-message is-ok';
    }
    await card.refresh();
  });
  return card;
}

// ---- Tools and MCP -----------------------------------------------------------------------------------------------

function buildTools() {
  const card = createCard('tools', 'Tools', 'What the model may call. Tier 2 tools wait for your approval every time.');
  card.refresh = async () => {
    setLoading(card);
    const result = await requestJson('/api/tools');
    if (!result.ok) {
      showError(card, `Tools unavailable: ${result.error}`);
      return;
    }
    const { tools, mcp } = result.data;
    const children = [];
    if (!tools || tools.length === 0) children.push(stateLine('empty', 'No tools are registered.'));
    else {
      children.push(
        table(
          ['Tool', 'Tier', 'Source', 'Description'],
          tools.map((tool) => [h('code', {}, tool.name), tierBadge(tool.tier), tool.untrusted ? badge('mcp (untrusted)', 'warn') : tool.source, tool.description]),
          'tools-table'
        )
      );
    }
    const mcpChildren = [h('h4', {}, 'MCP servers')];
    if (!mcp || (mcp.servers.length === 0 && mcp.failures.length === 0)) {
      mcpChildren.push(stateLine('empty', 'No MCP servers are configured.'));
    } else {
      if (mcp.servers.length > 0) mcpChildren.push(h('p', { dataset: { testid: 'mcp-servers' } }, `Running: ${mcp.servers.join(', ')}`));
      mcp.failures.forEach((failure) => mcpChildren.push(stateLine('error', `MCP server "${failure.server}" is unavailable: ${failure.error}`)));
      mcp.changed.forEach((change) =>
        mcpChildren.push(stateLine('error', `MCP tool "${change.name}" from "${change.server}" changed its description or schema since you approved it. It stays disabled until you approve the change.`))
      );
    }
    children.push(h('div', { dataset: { testid: 'mcp-status' } }, mcpChildren));
    clear(card.body).append(...children);
  };
  return card;
}

// ---- Skills ------------------------------------------------------------------------------------------------------

function sandboxView(sandbox) {
  const lines = [h('div', {}, sandbox.passed ? badge('sandbox passed', 'ok') : badge('sandbox failed', 'error'), ` ${sandbox.executionTimeMs} ms`)];
  (sandbox.errors ?? []).forEach((error) => lines.push(stateLine('error', error)));
  (sandbox.samples ?? []).forEach((sample) =>
    lines.push(h('p', { class: 'sample-line' }, `Sample ${JSON.stringify(sample.input)} -> ${sample.ok ? JSON.stringify(sample.output) : `failed: ${sample.error}`}`))
  );
  return h('div', { class: 'sandbox-result', dataset: { testid: 'skill-sandbox' } }, lines);
}

function buildSkills() {
  const card = createCard('skills', 'Skills', 'Small sandboxed programs the model writes for you. A skill is tested first and only activates when you promote it.');
  const description = h('textarea', { id: 'skillDescription', rows: '3', maxlength: '2000', placeholder: 'Describe what the skill should do, e.g. "count the words in a text".', 'aria-label': 'Skill description', dataset: { testid: 'skill-description' } });
  const createButton = h('button', { type: 'button', class: 'btn btn-primary', id: 'skillCreate', dataset: { testid: 'skill-create' } }, 'Generate and test');
  const messageEl = h('div', { class: 'card-message', role: 'status', dataset: { testid: 'skill-message' } });
  const resultEl = h('div', { dataset: { testid: 'skill-result' } });
  const listEl = h('div', { dataset: { testid: 'skill-list' } });
  card.body.append(h('div', { class: 'form-stack' }, description, h('div', { class: 'control-row' }, createButton)), messageEl, resultEl, listEl);

  const say = (text, kind = '') => {
    messageEl.textContent = text;
    messageEl.className = `card-message${kind ? ` is-${kind}` : ''}`;
  };

  const renderList = (skills, approvals) => {
    clear(listEl);
    if (!skills || skills.length === 0) {
      listEl.append(stateLine('empty', 'No skills yet.'));
      return;
    }
    skills.forEach((skill) => {
      const promote = h('button', { type: 'button', class: 'btn', disabled: skill.status !== 'sandboxed', dataset: { testid: 'skill-promote' }, onclick: async () => {
        say(`Promoting ${skill.name}...`);
        const result = await requestJson(`/api/skills/${encodeURIComponent(skill.id)}/promote`, jsonRequest('POST', {}));
        if (!result.ok) say(`Could not promote: ${result.error}`, 'error');
        else if (result.status === 202) say(`${skill.name} needs your approval: see the approval banner.`, 'warn');
        else say(`${skill.name} is now active.`, 'ok');
        await card.refresh();
      } }, 'Promote');
      const retest = h('button', { type: 'button', class: 'btn btn-ghost', dataset: { testid: 'skill-retest' }, onclick: async () => {
        const result = await requestJson(`/api/skills/${encodeURIComponent(skill.id)}/test`, jsonRequest('POST', {}));
        if (!result.ok) say(`Could not test: ${result.error}`, 'error');
        else clear(resultEl).append(sandboxView(result.data.sandbox));
        await card.refresh();
      } }, 'Re-test');
      listEl.append(
        h(
          'article',
          { class: 'skill-item', dataset: { testid: 'skill-item', skillId: skill.id } },
          h('div', { class: 'skill-head' }, h('strong', {}, skill.name), badge(skill.status, skill.status === 'active' ? 'ok' : skill.status === 'sandboxed' ? 'info' : 'neutral', { dataset: { testid: 'skill-status' } }), tierBadge(skill.requiredTier)),
          h('p', { class: 'card-description' }, skill.description),
          h('p', { class: 'card-description' }, `Used ${skill.successCount} times OK, ${skill.failureCount} failed.`),
          h('details', {}, h('summary', {}, 'Code'), h('pre', { class: 'code-view' }, skill.executableCode || '(no code)')),
          h('div', { class: 'control-row' }, promote, retest)
        )
      );
    });
    (approvals ?? []).slice(0, 3).forEach((a) => listEl.append(stateLine(a.state === 'failed' || a.state === 'denied' ? 'error' : 'empty', `Promotion request: ${a.state}${a.detail ? ` - ${a.detail}` : ''}`)));
  };

  card.refresh = async () => {
    const result = await requestJson('/api/skills');
    if (!result.ok) {
      clear(listEl).append(stateLine('error', `Skills unavailable: ${result.error}`));
      return;
    }
    renderList(result.data.skills, result.data.approvals);
  };

  createButton.addEventListener('click', async () => {
    const text = description.value.trim();
    if (text.length < 5) {
      say('Describe the skill in at least a few words.', 'error');
      return;
    }
    createButton.disabled = true;
    say('The model is writing the skill and the sandbox is testing it...');
    clear(resultEl);
    const result = await requestJson('/api/skills', jsonRequest('POST', { description: text }));
    createButton.disabled = false;
    if (!result.ok) {
      say(`No skill was created: ${result.error}`, 'error');
      return;
    }
    say(result.data.sandbox.passed ? `Skill ${result.data.skill.name} passed the sandbox. Promote it to activate.` : `Skill ${result.data.skill.name} failed the sandbox and stays a draft.`, result.data.sandbox.passed ? 'ok' : 'error');
    resultEl.append(sandboxView(result.data.sandbox));
    description.value = '';
    await card.refresh();
  });
  return card;
}

// ---- Multi-agent research ----------------------------------------------------------------------------------------

function buildResearch() {
  const card = createCard('research', 'Multi-agent research', 'A researcher, a verifier and an orchestrator search the web, compare sources and write a cited answer.');
  const goal = h('textarea', { id: 'researchGoal', rows: '2', maxlength: '1000', placeholder: 'What should the agents find out?', 'aria-label': 'Research goal', dataset: { testid: 'research-goal' } });
  const runButton = h('button', { type: 'button', class: 'btn btn-primary', id: 'researchRun', dataset: { testid: 'research-run' } }, 'Run research');
  const messageEl = h('div', { class: 'card-message', role: 'status', dataset: { testid: 'research-message' } });
  const resultEl = h('div', { dataset: { testid: 'research-result' } });
  card.body.append(h('div', { class: 'form-stack' }, goal, h('div', { class: 'control-row' }, runButton)), messageEl, resultEl);

  card.refresh = async () => {};

  runButton.addEventListener('click', async () => {
    const text = goal.value.trim();
    if (text.length < 3) {
      messageEl.textContent = 'Enter a research goal first.';
      messageEl.className = 'card-message is-error';
      return;
    }
    runButton.disabled = true;
    messageEl.textContent = 'Researching: searching, fetching pages and checking sources...';
    messageEl.className = 'card-message';
    clear(resultEl);
    const result = await requestJson('/api/agents/research', jsonRequest('POST', { goal: text }));
    runButton.disabled = false;
    if (!result.ok) {
      messageEl.textContent = `Research did not run: ${result.error}`;
      messageEl.className = 'card-message is-error';
      return;
    }
    const r = result.data;
    messageEl.textContent = r.status === 'success' ? 'Research finished.' : `Research ended with status "${r.status}".`;
    messageEl.className = `card-message is-${r.status === 'success' ? 'ok' : 'error'}`;
    const answer = h('div', { class: 'research-answer', dataset: { testid: 'research-answer' } });
    answer.innerHTML = formatFinalMarkdown(r.finalAnswer || '');
    const urls = (r.sources ?? []).map((s) => s.url);
    resultEl.append(
      h('div', { class: 'research-report' }, [
      h('div', { class: 'badge-row' }, r.isTainted ? badge('Tainted: built from web content', 'warn', { dataset: { testid: 'tainted-badge' } }) : null, badge(`${number(r.totalTokens)} tokens`, 'neutral'), badge(`status: ${r.status}`, r.status === 'success' ? 'ok' : 'error')),
      answer,
      r.consensus ? h('p', { class: 'card-description', dataset: { testid: 'research-consensus' } }, consensusText(r.consensus)) : null,
      r.degraded ? stateLine('error', `Degraded: ${r.degraded}`) : null,
      urls.length > 0 ? sourceLinks(urls) : stateLine('empty', 'No sources were found.'),
      table(['Agent', 'Status', 'Tokens', 'Time', 'Note'], (r.steps ?? []).map((step) => [step.role, step.status, String(number(step.tokens)), formatDuration(step.durationMs), step.error ?? step.degraded ?? '']), 'research-steps')
      ])
    );
  });
  return card;
}

// ---- Evaluation --------------------------------------------------------------------------------------------------

function buildEval() {
  const card = createCard('eval', 'Evaluation', 'Checks the default model against fixed cases. The target is at least 90% accuracy.');
  const runButton = h('button', { type: 'button', class: 'btn btn-primary', id: 'evalRun', dataset: { testid: 'eval-run' } }, 'Run evaluation');
  const messageEl = h('div', { class: 'card-message', role: 'status', dataset: { testid: 'eval-message' } });
  const resultEl = h('div', { dataset: { testid: 'eval-result' } });
  card.body.append(h('div', { class: 'control-row' }, runButton), messageEl, resultEl);
  let pollTimer = null;
  let showingRunning = false;
  let localRun = false;

  const schedulePoll = (running) => {
    clearTimeout(pollTimer);
    card.wantsPoll = running;
    if (running && !document.hidden) pollTimer = setTimeout(() => card.refresh(), EVAL_POLL_MS);
  };
  card.resumePoll = () => {
    if (card.wantsPoll && !document.hidden) void card.refresh();
  };
  card.stopPoll = () => {
    clearTimeout(pollTimer);
    card.wantsPoll = false;
  };

  const render = (snapshot, target) => {
    clear(resultEl);
    if (!snapshot) {
      resultEl.append(stateLine('empty', 'No evaluation has run yet.'));
      return;
    }
    const report = snapshot.report;
    const meets = report.meetsTarget;
    const bar = meterBar('Accuracy', report.accuracyRate, `${formatPercent(report.accuracyRate)} of ${formatPercent(target)} target`, 'eval-accuracy');
    resultEl.append(
      bar,
      h('p', { class: 'card-summary' }, meets ? badge('meets the 90% target', 'ok') : badge('below the 90% target', 'error'), ` ${report.passedTests} of ${report.totalTests} passed on ${snapshot.model}; ${report.erroredTests} could not be answered; average latency ${formatDuration(report.avgLatencyMs)}.${report.aborted ? ' The run was stopped early.' : ''}`),
      table(['Case', 'Category', 'Result', 'Latency', 'Note'], report.results.map((r) => [r.testId, r.category, r.passed ? badge('pass', 'ok') : r.errored ? badge('error', 'error') : badge('fail', 'warn'), formatDuration(r.latencyMs), r.notes ?? '']), 'eval-table')
    );
  };

  card.refresh = async () => {
    const result = await requestJson('/api/eval');
    if (!result.ok) {
      clear(resultEl).append(stateLine('error', `Evaluation unavailable: ${result.error}`));
      return;
    }
    const running = result.data.running;
    runButton.disabled = Boolean(running) || localRun;
    if (running) {
      messageEl.textContent = `An evaluation is running on ${running.model}.`;
      messageEl.className = 'card-message';
      showingRunning = true;
    } else if (showingRunning) {
      // The run that this line described has ended, so the line must not keep claiming it is running.
      messageEl.textContent = '';
      showingRunning = false;
    }
    render(result.data.last, result.data.targetAccuracy);
    schedulePoll(Boolean(running));
  };

  runButton.addEventListener('click', async () => {
    runButton.disabled = true;
    localRun = true;
    showingRunning = false;
    messageEl.textContent = 'Running the evaluation cases...';
    messageEl.className = 'card-message';
    schedulePoll(true);
    const result = await requestJson('/api/eval', jsonRequest('POST', {}));
    localRun = false;
    schedulePoll(false);
    runButton.disabled = false;
    if (!result.ok) {
      messageEl.textContent = `Evaluation failed: ${result.error}`;
      messageEl.className = 'card-message is-error';
      if (result.data && result.data.report) render(result.data, result.data.targetAccuracy ?? 0.9);
      return;
    }
    messageEl.textContent = 'Evaluation finished.';
    messageEl.className = 'card-message is-ok';
    render(result.data, result.data.targetAccuracy);
  });
  return card;
}

// ---- Email -------------------------------------------------------------------------------------------------------

function buildEmail() {
  const card = createCard('email', 'Email inbox', 'Mail you add here is treated as untrusted text. Replies are drafts; sending needs a mail transport and your approval.');
  const field = (id, label, attrs = {}) => [h('label', { for: id }, label), h('input', { id, type: 'text', maxlength: '320', dataset: { testid: id }, ...attrs })];
  const bodyField = h('textarea', { id: 'emailBody', rows: '4', placeholder: 'Paste the message text', 'aria-label': 'Message body', dataset: { testid: 'emailBody' } });
  const summarize = h('input', { id: 'emailSummarize', type: 'checkbox', checked: true, dataset: { testid: 'emailSummarize' } });
  const ingestButton = h('button', { type: 'button', class: 'btn btn-primary', id: 'emailIngest', dataset: { testid: 'email-ingest' } }, 'Add to inbox');
  const messageEl = h('div', { class: 'card-message', role: 'status', dataset: { testid: 'email-message' } });
  const listEl = h('div', { dataset: { testid: 'email-list' } });
  card.body.append(
    h('details', { class: 'form-details', open: true }, h('summary', {}, 'Add a message'), h('div', { class: 'form-grid' }, field('emailFrom', 'From'), field('emailTo', 'To'), field('emailSubject', 'Subject', { maxlength: '500' }), bodyField), h('label', { class: 'inline-check' }, summarize, ' Summarize with the model'), h('div', { class: 'control-row' }, ingestButton)),
    messageEl,
    listEl
  );

  const say = (text, kind = '') => {
    messageEl.textContent = text;
    messageEl.className = `card-message${kind ? ` is-${kind}` : ''}`;
  };

  const renderList = (data) => {
    clear(listEl);
    if (!data.emails || data.emails.length === 0) {
      listEl.append(stateLine('empty', 'The inbox is empty.'));
    }
    if (!data.transportConfigured) listEl.append(stateLine('empty', 'No email transport is configured: replies can be drafted but nothing can be sent.'));
    (data.emails ?? []).forEach((email) => {
      const draftBox = h('div', { class: 'draft-box', dataset: { testid: 'email-draft' }, hidden: !email.draftReply });
      if (email.draftReply) draftBox.append(h('strong', {}, `Draft (${email.draftKind === 'llm' ? 'written by the model' : 'fixed template, no model was used'})`), h('pre', { class: 'code-view' }, email.draftReply));
      const draftButton = h('button', { type: 'button', class: 'btn', dataset: { testid: 'email-draft-button' }, onclick: async () => {
        say(`Drafting a reply to "${email.subject}"...`);
        const result = await requestJson(`/api/email/${encodeURIComponent(email.id)}/draft`, jsonRequest('POST', {}));
        if (!result.ok) {
          say(`Could not draft: ${result.error}`, 'error');
          return;
        }
        say(result.data.kind === 'llm' ? 'Draft written by the model.' : `A fixed template was used because ${result.data.fallbackReason ?? 'no model was available'}.`, result.data.kind === 'llm' ? 'ok' : 'warn');
        await card.refresh();
      } }, 'Draft reply');
      const sendButton = h('button', { type: 'button', class: 'btn', disabled: !email.draftReply, dataset: { testid: 'email-send-button' }, onclick: async () => {
        const result = await requestJson(`/api/email/${encodeURIComponent(email.id)}/send`, jsonRequest('POST', {}));
        if (!result.ok) say(`Not sent: ${result.error}`, 'error');
        else say(`Approval requested to send to ${result.data.to}: see the approval banner.`, 'warn');
        await card.refresh();
      } }, 'Request send');
      listEl.append(
        h(
          'article',
          { class: 'email-item', dataset: { testid: 'email-item', emailId: email.id } },
          h('div', { class: 'email-head' }, h('strong', {}, email.subject || '(no subject)'), badge(email.importance, email.importance === 'urgent' ? 'error' : email.importance === 'high' ? 'warn' : 'neutral'), badge(email.status, 'neutral'), badge('untrusted', 'warn')),
          h('div', { class: 'card-description' }, `From ${email.from} to ${email.to}`),
          email.summary ? h('p', { dataset: { testid: 'email-summary' } }, h('strong', {}, 'Model summary: '), email.summary) : h('p', { dataset: { testid: 'email-excerpt' } }, h('strong', {}, 'Excerpt (not a summary): '), email.excerpt),
          h('details', {}, h('summary', {}, 'Message text'), h('pre', { class: 'code-view' }, email.bodyPreview)),
          draftBox,
          h('div', { class: 'control-row' }, draftButton, sendButton)
        )
      );
    });
    (data.sends ?? []).slice(0, 5).forEach((send) => listEl.append(stateLine(send.state === 'failed' || send.state === 'denied' ? 'error' : 'empty', `Send request (${send.description}): ${send.state}${send.detail ? ` - ${send.detail}` : ''}`)));
  };

  card.refresh = async () => {
    const result = await requestJson('/api/email');
    if (!result.ok) {
      clear(listEl).append(stateLine('error', `Inbox unavailable: ${result.error}`));
      return;
    }
    renderList(result.data);
  };

  ingestButton.addEventListener('click', async () => {
    const value = (id) => document.getElementById(id).value.trim();
    const payload = { from: value('emailFrom'), to: value('emailTo'), subject: document.getElementById('emailSubject').value, body: document.getElementById('emailBody').value, summarize: summarize.checked };
    if (!payload.from || !payload.to || !payload.body.trim()) {
      say('From, To and the message text are required.', 'error');
      return;
    }
    ingestButton.disabled = true;
    say('Adding the message...');
    const result = await requestJson('/api/email/ingest', jsonRequest('POST', payload));
    ingestButton.disabled = false;
    if (!result.ok) {
      say(`Not added: ${result.error}`, 'error');
      return;
    }
    say(result.data.summaryError ?? 'Message added and summarized.', result.data.summaryError ? 'warn' : 'ok');
    ['emailFrom', 'emailTo', 'emailSubject', 'emailBody'].forEach((id) => (document.getElementById(id).value = ''));
    await card.refresh();
  });
  return card;
}

// ---- Phone -------------------------------------------------------------------------------------------------------

function consensusText(consensus) {
  if (consensus.insufficientSources === 'none') return 'Source agreement: not computed, no readable source.';
  if (consensus.insufficientSources === 'single_source') return 'Source agreement: single source, not corroborated.';
  if (consensus.insufficientSources === 'same_origin') return 'Source agreement: all sources share one origin, not corroborated.';
  return `Source agreement: ${consensus.status}, score ${number(consensus.score).toFixed(2)} across ${consensus.independentSources} independent source(s). ${consensus.summary}`;
}

function buildPhone() {
  const card = createCard('phone', 'Phone', 'Devices and notifications read over adb. Notification text comes from other apps and is untrusted.');
  card.refresh = async () => {
    setLoading(card);
    const result = await requestJson('/api/phone');
    if (!result.ok) {
      showError(card, `Phone unavailable: ${result.error}`);
      return;
    }
    const { devices, notifications, problems } = result.data;
    const children = [];
    (problems ?? []).forEach((problem) => children.push(stateLine('error', problem)));
    if (!devices || devices.length === 0) children.push(stateLine('empty', 'No phone is connected.'));
    else {
      children.push(table(['Device', 'Platform', 'Battery', 'Charging', 'Connected', 'Last sync'], devices.map((d) => {
        const cells = deviceStatusCells(d);
        const connection = d.connected ? badge('connected', 'ok') : badge('disconnected', 'error');
        return [d.deviceId, d.platform, cells.battery, cells.charging, cells.reason ? h('span', {}, connection, ' ', cells.reason) : connection, cells.lastSync ? formatTime(cells.lastSync) : 'unknown'];
      }), 'phone-devices'));
    }
    children.push(h('h4', {}, 'Notifications', ' ', badge('untrusted', 'warn')));
    if (!notifications || notifications.length === 0) children.push(stateLine('empty', 'No notifications.'));
    else {
      children.push(h('ul', { class: 'notification-list', dataset: { testid: 'phone-notifications' } }, notifications.map((n) => h('li', {}, h('strong', {}, `${n.appName}: ${n.title}`), h('div', {}, n.text), h('small', {}, formatTime(n.timestamp))))));
    }
    clear(card.body).append(...children);
  };
  return card;
}

// ---- Kill switch -------------------------------------------------------------------------------------------------

function buildKill(onChange) {
  const card = createCard('kill', 'Kill switch', 'Stops every running turn, denies waiting approvals and refuses new work until you reset it.');
  const killButton = h('button', { type: 'button', class: 'btn btn-kill', id: 'killButton', dataset: { testid: 'kill-button' } }, 'STOP EVERYTHING');
  const resetButton = h('button', { type: 'button', class: 'btn btn-primary', id: 'killReset', dataset: { testid: 'kill-reset' }, hidden: true }, 'Reset kill switch');
  const stateEl = h('p', { class: 'card-state', role: 'status', dataset: { testid: 'kill-state' } }, 'Checking...');
  const messageEl = h('div', { class: 'card-message', role: 'status' });
  card.body.append(stateEl, h('div', { class: 'control-row' }, killButton, resetButton), messageEl);

  const apply = (engaged, reason) => {
    killButton.disabled = engaged;
    resetButton.hidden = !engaged;
    stateEl.className = `card-state is-${engaged ? 'error' : 'empty'}`;
    stateEl.textContent = engaged ? `Engaged${reason ? `: ${reason}` : ''}. Jarvis is not answering.` : 'Not engaged. Jarvis is running normally.';
  };
  card.apply = apply;

  card.refresh = async () => {
    const result = await requestJson('/api/health');
    if (!result.ok) {
      stateEl.className = 'card-state is-error';
      stateEl.textContent = `Kill switch state unknown: ${result.error}`;
      return;
    }
    apply(Boolean(result.data.killSwitch?.engaged), result.data.killSwitch?.reason ?? '');
  };

  killButton.addEventListener('click', async () => {
    killButton.disabled = true;
    const result = await requestJson('/api/kill', jsonRequest('POST', { reason: 'Emergency stop from the dashboard' }));
    messageEl.textContent = result.ok ? `Stopped. ${result.data.tasksAborted} background task(s) cancelled.` : `The kill switch could not be engaged: ${result.error}`;
    messageEl.className = `card-message is-${result.ok ? 'ok' : 'error'}`;
    await card.refresh();
    onChange();
  });
  resetButton.addEventListener('click', async () => {
    const result = await requestJson('/api/kill/reset', jsonRequest('POST', {}));
    messageEl.textContent = result.ok ? 'Reset. Jarvis can work again.' : `Reset failed: ${result.error}`;
    messageEl.className = `card-message is-${result.ok ? 'ok' : 'error'}`;
    await card.refresh();
    onChange();
  });
  return card;
}

// ---- Wiring ------------------------------------------------------------------------------------------------------

export function initDashboard({ onKillChange }) {
  const grid = document.getElementById('dashboardGrid');
  const models = buildModels();
  const getModels = () => models.latest;
  const cards = [buildResources(), models, buildLedger(), buildBenchmark(getModels), buildTools(), buildSkills(), buildResearch(), buildEval(), buildEmail(), buildPhone(), buildKill(onKillChange)];
  grid.append(...cards.map((card) => card.section));
  cards.forEach((card) => card.refreshButton.addEventListener('click', () => void card.refresh()));

  const benchmark = cards.find((card) => card.id === 'benchmark');
  const resources = cards.find((card) => card.id === 'resources');
  const refreshAll = async () => {
    await models.refresh();
    benchmark.fillModels();
    await Promise.all(cards.filter((card) => card.id !== 'models').map((card) => card.refresh()));
  };

  const byId = (id) => cards.find((card) => card.id === id);
  let visible = false;
  // Cards whose content changes when the owner decides an approval or a chat turn ends are refreshed in place.
  document.addEventListener('jarvis:approval-decided', () => {
    if (!visible) return;
    ['skills', 'email', 'tools'].forEach((id) => void byId(id).refresh());
  });
  document.addEventListener('jarvis:turn-finished', () => {
    if (!visible) return;
    ['ledger', 'resources', 'models'].forEach((id) => void byId(id).refresh());
  });
  document.addEventListener('visibilitychange', () => {
    if (visible && !document.hidden) cards.forEach((card) => card.resumePoll?.());
  });

  let timer = null;
  return {
    show() {
      visible = true;
      void refreshAll();
      clearInterval(timer);
      timer = setInterval(() => {
        if (!document.hidden) void resources.refresh();
      }, RESOURCE_REFRESH_MS);
    },
    hide() {
      visible = false;
      cards.forEach((card) => card.stopPoll?.());
      clearInterval(timer);
      timer = null;
    },
    refreshKill: () => cards.find((card) => card.id === 'kill').refresh(),
  };
}
