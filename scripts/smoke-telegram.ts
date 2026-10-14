/**
 * Jarvis Local AI Agent: Telegram bot smoke test (no Telegram network, no token)
 * Authority: FEAT-004, Phase 2
 *
 * Drives the real `TelegramBotClient` message handling against the real local models, but captures the
 * bot's outgoing Telegram API calls instead of sending them. Memory goes to a throwaway database, so the
 * real owner memory is untouched. Run on the workstation:
 *
 *   npx tsx scripts/smoke-telegram.ts [--model qwen2.5:7b]
 *
 * Differences from production: model auto-pull is disabled (the run never downloads a model), and
 * Telegram's Markdown rejection is simulated so the plain-text fallback can be checked.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DocumentStore } from '../src/storage/collection.js';
import { SessionManager } from '../src/sessions/manager.js';
import { MemoryManager } from '../src/memory/manager.js';
import { OllamaProvider, type GenerateOptions } from '../src/services/provider.js';
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
  const dbPath = path.join(os.tmpdir(), `jarvis-smoke-telegram-${Date.now()}.db`);
  const store = new DocumentStore(dbPath);
  const sessions = new SessionManager(store);
  const memory = new MemoryManager(store);

  const probe = new OllamaProvider({ baseUrl: config.ollamaBaseUrl });
  const installed = (await probe.listModels()).filter((m) => !/embed/i.test(m));
  const model = modelArg ?? installed.find((m) => m === 'qwen2.5:7b') ?? installed[0];
  const provider = new OllamaProvider({ baseUrl: config.ollamaBaseUrl, model });

  const prompts: string[] = [];
  const realGenerate = provider.generate.bind(provider);
  provider.generate = async (prompt: string, options?: GenerateOptions) => {
    prompts.push(prompt);
    return realGenerate(prompt, options);
  };
  provider.pullModel = async (name: string) => {
    console.log(`      (auto-pull of ${name} skipped by smoke test)`);
    return false;
  };

  const bot = new TelegramBotClient({ token: 'smoke-test-offline', ownerId: String(OWNER_ID), sessionManager: sessions, memoryManager: memory, llmProvider: provider });
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
  async function say(text: string): Promise<{ reply: string; ms: number }> {
    sent = [];
    const started = Date.now();
    const update: TelegramUpdate = {
      update_id: updateId++,
      message: {
        message_id: updateId,
        from: { id: OWNER_ID, is_bot: false, first_name: 'Owner' },
        chat: { id: OWNER_ID, type: 'private' },
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

  console.log(`Telegram smoke test with ${model} via ${config.ollamaBaseUrl} (memory: ${dbPath})\n`);

  try {
    const hello = await say('Hello Jarvis, reply with just OK.');
    record('chat reply', hello.reply.length > 0 && !hello.reply.includes('Inference failed') ? 'PASS' : 'FAIL', `${hello.ms} ms, reply ${short(hello.reply)}`);

    await say('My favourite colour is green. Reply with just OK.');
    const recall = await say('Recall my favourite colour in one word.');
    const promptHadTurn = lastPrompt().includes('My favourite colour is green');
    record('memory: same session', promptHadTurn && /green/i.test(recall.reply) ? 'PASS' : 'FAIL', `prompt had earlier turn: ${promptHadTurn}; reply ${short(recall.reply)}`);

    // Session one now has 6 messages, which triggers the rolling summary on the smallest installed model.
    const summaries = await memory.getSessionSummaries(String(OWNER_ID));
    record('summary written at 6 messages', summaries.length > 0 ? 'PASS' : 'FAIL', summaries[0] ? short(summaries[0].summary) : 'no summary stored');

    await say('/new Smoke Second Session');
    const isolated = await say('Recall my favourite colour in one word.');
    const leaked = lastPrompt().includes('My favourite colour is green');
    record('session isolation (turns)', leaked ? 'FAIL' : 'PASS', `new session prompt contains old turns: ${leaked}; reply ${short(isolated.reply)}`);

    await say('Remember that my smoke-test codeword is ZEBRA-42');
    const facts = await memory.getProfileFacts(String(OWNER_ID));
    record('remember that → profile fact', facts.some((f) => f.value.includes('ZEBRA-42')) ? 'PASS' : 'FAIL', facts.map((f) => `${f.key}=${f.value}`).join('; ') || 'none');

    await say('/new Smoke Third Session');
    const codeword = await say('Recall my smoke-test codeword exactly.');
    record('profile fact in another session', /ZEBRA-42/i.test(codeword.reply) ? 'PASS' : 'FAIL', `reply ${short(codeword.reply)}`);

    const episodes = await memory.queryEpisodes({ userId: String(OWNER_ID) }, 100);
    record('episodes recorded', episodes.length > 0 ? 'PASS' : 'FAIL', `${episodes.length} episodes`);

    sent = [];
    await bot.sendMessage(OWNER_ID, 'snake_case and *unclosed', { parse_mode: 'Markdown' });
    const plainRetry = sent.length === 2 && sent[1].body.parse_mode === undefined;
    record('Markdown rejection falls back to plain text', plainRetry ? 'PASS' : 'FAIL', `${sent.length} API calls`);
  } finally {
    store.close();
    fs.rmSync(dbPath, { force: true });
  }

  const failed = results.filter((r) => r.status === 'FAIL').length;
  console.log(`\n${results.length - failed} passed, ${failed} failed.`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
