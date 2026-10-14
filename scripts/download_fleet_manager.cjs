/**
 * Jarvis Local AI: Model Fleet Sequential Downloader
 * Downloads the requested heavy models sequentially in order of size.
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const modelsToDownload = [
  { id: 'qwen3:14b', size: '~9.3 GB', desc: 'Qwen 3 14B High-Intelligence Mid-Tier' },
  { id: 'qwen3.8:27b', size: '~16.5 GB', desc: 'Qwen 3.8 27B High-Accuracy Reasoning' },
  { id: 'qwen3:32b', size: '~20 GB', desc: 'Qwen 3 32B Dense Powerhouse' },
  { id: 'rnogy/Nvidia_Llama-3_3-Nemotron-Super-49B-v1_5:q4_K_M', size: '~30.2 GB', desc: 'NVIDIA Llama 3.3 Nemotron Super 49B v1.5 Reasoning' },
  { id: 'bartowski/moonshotai_Kimi-Linear-48B-A3B-Instruct-GGUF', isGGUF: true, hfRepo: 'bartowski/moonshotai_Kimi-Linear-48B-A3B-Instruct-GGUF', hfFile: 'moonshotai_Kimi-Linear-48B-A3B-Instruct-Q4_K_M.gguf', size: '~29.8 GB', desc: 'Moonshot AI Kimi Linear 48B-A3B MoE (3B Active, 1M Context)' },
  { id: 'deepseek-r1:70b', size: '~43 GB', desc: 'DeepSeek R1 70B Flagship CoT Reasoning' },
  { id: 'qwen3:72b', isGGUF: true, hfRepo: 'mradermacher/Qwen3-72B-Instruct-GGUF', hfFile: 'Qwen3-72B-Instruct.Q4_K_M.gguf', size: '~47.4 GB', desc: 'Qwen 3 72B Flagship Multi-Domain Synthesis (Q4_K_M)' }
];

const logDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, 'model_fleet_download.log');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync(logFile, line);
  console.log(line.trim());
}

function getInstalledModels() {
  try {
    const out = execSync('ollama list', { encoding: 'utf8' });
    return out.split('\n').slice(1).map(l => l.split(/\s+/)[0]).filter(Boolean);
  } catch (e) {
    return [];
  }
}

async function pullModel(modelInfo) {
  return new Promise((resolve, reject) => {
    log(`Starting pull for ${modelInfo.id} (${modelInfo.size} - ${modelInfo.desc})...`);
    const child = spawn('ollama', ['pull', modelInfo.id], { stdio: ['ignore', 'pipe', 'pipe'] });

    let lastLoggedPercent = -1;
    const regex = /(\d+)%/;

    child.stdout.on('data', (data) => {
      const str = data.toString();
      const match = str.match(regex);
      if (match) {
        const pct = parseInt(match[1], 10);
        if (pct % 10 === 0 && pct !== lastLoggedPercent) {
          lastLoggedPercent = pct;
          log(`[${modelInfo.id}] Download Progress: ${pct}%`);
        }
      }
    });

    child.stderr.on('data', (data) => {
      const str = data.toString();
      const match = str.match(regex);
      if (match) {
        const pct = parseInt(match[1], 10);
        if (pct % 10 === 0 && pct !== lastLoggedPercent) {
          lastLoggedPercent = pct;
          log(`[${modelInfo.id}] Download Progress: ${pct}%`);
        }
      }
    });

    child.on('close', (code) => {
      if (code === 0) {
        log(`Successfully downloaded and installed ${modelInfo.id}!`);
        resolve(true);
      } else {
        log(`Failed pulling ${modelInfo.id} with exit code ${code}`);
        resolve(false);
      }
    });

    child.on('error', (err) => {
      log(`Error spawning pull for ${modelInfo.id}: ${err.message}`);
      resolve(false);
    });
  });
}

async function main() {
  log('=====================================================');
  log('Jarvis Model Fleet Auto-Downloader Started');
  log('Target fleet: Qwen3 (8B, 14B, 32B), Qwen 3.8 27B, Nemotron Super 49B, DeepSeek R1 70B, Qwen 72B');
  log('=====================================================');

  for (const m of modelsToDownload) {
    const installed = getInstalledModels();
    if (installed.includes(m.id)) {
      log(`Model ${m.id} is already installed in Ollama. Skipping.`);
      continue;
    }

    await pullModel(m);

    // Cleanup older models once modern replacements are ready
    if (m.id === 'qwen3:14b') {
      try {
        execSync('ollama rm qwen2.5:14b', { encoding: 'utf8' });
        log('Removed legacy qwen2.5:14b to free disk space.');
      } catch (_) {}
    }
    if (m.id === 'qwen3:32b') {
      try {
        execSync('ollama rm qwen2.5-coder:32b', { encoding: 'utf8' });
        log('Removed legacy qwen2.5-coder:32b to free disk space.');
      } catch (_) {}
    }
  }

  log('=====================================================');
  log('All requested smart models downloaded and installed successfully!');
  log('=====================================================');
}

main();
