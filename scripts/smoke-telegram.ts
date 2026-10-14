/**
 * Jarvis Local AI Agent: Telegram bot smoke test (no Telegram network, no token)
 * Authority: FEAT-004, Phase 2
 *
 * Drives the real `TelegramBotClient` on a real `JarvisRuntime` against the real local models, but captures
 * the bot's outgoing Telegram API calls instead of sending them. Everything (store, vault key, action
 * registry) lives in a throwaway directory, so the real owner memory is untouched. Run on the workstation:
 *
 *   npx tsx scripts/smoke-telegram.ts [--model qwen3:8b]
 *
 * Differences from production: model pulling is disabled (the run never downloads a model), MCP servers are
 * not started, and Telegram's Markdown rejection is simulated so the plain-text fallback can be checked.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRuntime } from '../src/runtime/runtime.js';
import { OllamaProvider, type GenerateOptions, type GenerateStreamOptions, type LLMProvider } from '../src/services/provider.js';
import { TelegramBotClient } from '../src/telegram/bot.js';
import type { TelegramUpdate } from '../src/telegram/types.js';
import { config } from '../src/config.js';

type Status = 'PASS' | 'FAIL' | 'WARN';
interface SentCall {
  method: string;
  body: Record<string, unknown>;
}

const OWNER_ID = 1001;
const args = process.argv.slice(2);
const modelFlag = args.indexOf('--model');
const modelArg = modelFlag !== -1 ? args[modelFlag + 1] : undefined;
const results: Array<{ name: string; status: Status }> = [];

function record(name: string, status: Status, detail: string): void {
  results.push({ name, status });
  const color = status === 'PASS' ? '\x1b[32m' : status === 'WARN' ? '\x1b[33m' : '\x1b[31m';
  console.log(`${color}${status}\x1b[0m  ${name} — ${detail}`);
}

/** Mirrors Telegram rejecting unbalanced Markdown entities with a 400. */
function telegramWouldReject(text: string): boolean {
  return ['*', '_', '`'].some((marker) => text.split(marker).length % 2 === 0);
}

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-smoke-telegram-'));

  const probe = new OllamaProvider({ baseUrl: config.ollamaBaseUrl });
  let installed: string[];
  try {
    installed = (await probe.listModelsStrict()).filter((m) => !/embed/i.test(m));
  } catch (err: unknown) {
    console.error(`Ollama is unreachable at ${config.ollamaBaseUrl}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  const model = modelArg ?? (installed.includes(config.defaultModel) ? config.defaultModel : installed[0]);
  if (!model) {
    console.error('Ollama has no installed chat model, so there is nothing to smoke-test.');
    process.exit(1);
  }

  const prompts: string[] = [];
  const recordingProvider = (tag: string): LLMProvider => {
    const real = new OllamaProvider({ baseUrl: config.ollamaBaseUrl, model: tag, defaultContextTokens: config.contextTokens });
    const realGenerate = real.generate.bind(real);
    const realStream = real.generateStream.bind(real);
    real.generate = async (prompt: string, options?: GenerateOptions) => {
      prompts.push(prompt);
      return realGenerate(prompt, options);
    };
    real.generateStream = (prompt: string, options?: GenerateStreamOptions) => {
      prompts.push(prompt);
      return realStream(prompt, options);
    };
    return real;
  };

  const rt = await createRuntime({
    dataDir: dir,
    ollamaBaseUrl: config.ollamaBaseUrl,
    ownerUserId: String(OWNER_ID),
    config: { defaultModel: model, allowModelPull: false },
    providerFactory: recordingProvider,
    mcpServers: [],
    memoryOptions: { vault: { keyPath: path.join(dir, 'vault.key'), env: {} } },
    workspaceRoot: dir,
  });
  const bot = new TelegramBotClient({ token: 'smoke-test-offline', ownerId: String(OWNER_ID), runtime: rt, allowOpenDev: false });
  let sent: SentCall[] = [];
  let messageId = 1;
  bot.apiCall = async <T>(method: string, body?: Record<string, unknown>): Promise<T> => {
    const call = { method, body: body ?? {} };
    if ((method === 'sendMessage' || method === 'editMessageText') && call.body.parse_mode && telegramWouldReject(String(call.body.text ?? ''))) {
      sent.push(call);
      throw new Error(`Telegram API error [${method}]: Bad Request: can't parse entities (simulated)`);
    }
    sent.push(call);
    if (method === 'sendMessage') {
      return { message_id: messageId++, chat: { id: OWNER_ID, type: 'private' }, date: 0, text: String(call.body.text ?? '') } as T;
    }
    return true as T;
  };

  let updateId = 1;
  async function say(text: string, fromId = OWNER_ID): Promise<{ reply: string; ms: number }> {
    sent = [];
    const started = Date.now();
    const update: TelegramUpdate = {
      update_id: updateId++,
      message: {
        message_id: updateId,
        from: { id: fromId, is_bot: false, first_name: 'Sender' },
        chat: { id: fromId, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text,
      },
    };
    await bot.handleUpdate(update);
    // The last message is the answer; earlier ones are progress notices (model routing, research).
    const reply = String(sent.filter((c) => c.method === 'sendMessage').at(-1)?.body.text ?? '');
    return { reply, ms: Date.now() - started };
  }
  const lastPrompt = (): string => prompts.filter((p) => p.includes('User Request:')).at(-1) ?? '';
  const short = (s: string): string => JSON.stringify(s.replace(/^\[#\d+[^\]]*\]\s*/, '').trim().slice(0, 120));
  const owner = String(OWNER_ID);

  console.log(`Telegram smoke test with ${model} via ${config.ollamaBaseUrl} (state: ${dir})\n`);

  try {
    const stranger = await say('Hello', 999);
    record('stranger is refused', /Access Denied/.test(stranger.reply) ? 'PASS' : 'FAIL', short(stranger.reply));

    const hello = await say('Hello Jarvis, reply with just OK.');
    record('chat reply', hello.reply.length > 0 && !/I could not answer/.test(hello.reply) ? 'PASS' : 'FAIL', `${hello.ms} ms, reply ${short(hello.reply)}`);

    await say('My favourite colour is green. Reply with just OK.');
    const recall = await say('Recall my favourite colour in one word.');
    const promptHadTurn = lastPrompt().includes('My favourite colour is green');
    record('memory: same session', promptHadTurn && /green/i.test(recall.reply) ? 'PASS' : 'FAIL', `prompt had earlier turn: ${promptHadTurn}; reply ${short(recall.reply)}`);

    // Session one now has 6 messages, which triggers the rolling summary on the smallest installed model.
    const summaries = await rt.memory.getSessionSummaries(owner);
    record('summary written at 6 messages', summaries.length > 0 ? 'PASS' : 'FAIL', summaries[0] ? short(summaries[0].summary) : 'no summary stored');

    await say('/new Smoke Second Session');
    const isolated = await say('Recall my favourite colour in one word.');
    const leaked = lastPrompt().includes('My favourite colour is green');
    record('session isolation (turns)', leaked ? 'FAIL' : 'PASS', `new session prompt contains old turns: ${leaked}; reply ${short(isolated.reply)}`);

    await say('Remember that my smoke-test codeword is ZEBRA-42');
    const facts = await rt.memory.getProfileFacts(owner);
    record('remember that -> profile fact', facts.some((f) => f.value.includes('ZEBRA-42')) ? 'PASS' : 'FAIL', facts.map((f) => `${f.key}=${f.value}`).join('; ') || 'none');

    await say('/new Smoke Third Session');
    const codeword = await say('Recall my smoke-test codeword exactly.');
    record('profile fact in another session', /ZEBRA-42/i.test(codeword.reply) ? 'PASS' : 'FAIL', `reply ${short(codeword.reply)}`);

    const episodes = await rt.memory.queryEpisodes({ userId: owner }, 100);
    record('episodes recorded', episodes.length > 0 ? 'PASS' : 'FAIL', `${episodes.length} episodes`);

    const status = await say('/status');
    record('/status is honest', /Ollama:/.test(status.reply) && !/Headroom/i.test(status.reply) ? 'PASS' : 'FAIL', short(status.reply));

    const models = await say('/models');
    record('/models lists installed models', installed.every((name) => models.reply.includes(name)) ? 'PASS' : 'FAIL', `${installed.length} installed`);

    const tasks = await rt.sessions.listTasks({ userId: owner });
    const stuck = tasks.filter((t) => t.status === 'queued' || t.status === 'running').length;
    record('tasks finish', tasks.length > 0 && stuck === 0 ? 'PASS' : 'FAIL', `${tasks.length} tasks, ${stuck} still queued or running`);

    sent = [];
    await bot.sendMessage(OWNER_ID, 'snake_case and *unclosed', { parse_mode: 'Markdown' });
    const plainRetry = sent.length === 2 && sent[1].body.parse_mode === undefined;
    record('Markdown rejection falls back to plain text', plainRetry ? 'PASS' : 'FAIL', `${sent.length} API calls`);
  } finally {
    await rt.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const failed = results.filter((r) => r.status === 'FAIL').length;
  console.log(`\n${results.length - failed} passed, ${failed} failed.`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
