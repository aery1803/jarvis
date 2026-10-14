/**
 * Jarvis Local AI Agent: Live chat smoke test
 * Authority: FEAT-004
 *
 * Exercises the running web server against the real models: real streaming, stop/abort with partial save,
 * Markdown rendering of a real reply, and same-chat memory. Run it on the workstation while `npm run dev`
 * is up:
 *
 *   npx tsx scripts/smoke-chat.ts [--url http://127.0.0.1:3000] [--model qwen3:8b] [--write-memory]
 *
 * It deletes the chat sessions it creates. `--write-memory` also runs the cross-chat checks; those write a
 * "smoke-test codeword" profile fact and a session summary into the shared memory, which are not removed.
 */

import { createSseParser } from '../src/web/public/sse.js';
import { formatMarkdown } from '../src/web/public/markdown.js';

type Status = 'PASS' | 'FAIL' | 'WARN';
interface Result {
  name: string;
  status: Status;
  detail: string;
}

interface StreamResult {
  text: string;
  chunks: number;
  firstChunkMs: number | null;
  totalMs: number;
  headers: Headers;
  done: boolean;
}

const args = process.argv.slice(2);
const argValue = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
};
const baseUrl = (argValue('--url') ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const writeMemory = args.includes('--write-memory');
const results: Result[] = [];
const createdSessions: string[] = [];

// Prompts avoid the server's research trigger words ("what", "how", "show", "?", ...) so every check
// measures the model, not SearXNG.
const LONG_PROMPT = 'Write a 250-word story about a lighthouse keeper and a stray cat. Plain prose, no headings.';

function record(name: string, status: Status, detail: string): void {
  results.push({ name, status, detail });
  const color = status === 'PASS' ? '\x1b[32m' : status === 'WARN' ? '\x1b[33m' : '\x1b[31m';
  console.log(`${color}${status}\x1b[0m  ${name} — ${detail}`);
}

async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, init);
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function createSession(title: string, model: string): Promise<string> {
  const session = await getJson<{ id: string }>('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: `[smoke] ${title}`, model }),
  });
  createdSessions.push(session.id);
  return session.id;
}

async function streamChat(
  sessionId: string,
  prompt: string,
  model: string,
  options: { abortAfterChunks?: number; timeoutMs?: number } = {}
): Promise<StreamResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 240_000);
  const started = Date.now();
  let text = '';
  let chunks = 0;
  let firstChunkMs: number | null = null;
  let done = false;

  const res = await fetch(`${baseUrl}/api/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: controller.signal,
    body: JSON.stringify({ sessionId, prompt, model, useResearch: false }),
  });
  if (!res.ok || !res.body) {
    clearTimeout(timer);
    throw new Error(`stream HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const parser = createSseParser();
  try {
    while (!done) {
      const { value, done: streamDone } = await reader.read();
      const payloads: string[] = streamDone ? parser.end() : parser.push(value);
      for (const payload of payloads) {
        if (payload === '[DONE]') {
          done = true;
          break;
        }
        const data = JSON.parse(payload) as { chunk?: string };
        if (typeof data.chunk === 'string') {
          // The provisioning notice and research banner are not model output.
          if (firstChunkMs === null) firstChunkMs = Date.now() - started;
          text += data.chunk;
          chunks += 1;
        }
      }
      if (options.abortAfterChunks !== undefined && chunks >= options.abortAfterChunks) {
        controller.abort();
        break;
      }
      if (streamDone) break;
    }
  } catch (err: unknown) {
    if (!controller.signal.aborted) throw err;
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => undefined);
  }
  return { text, chunks, firstChunkMs, totalMs: Date.now() - started, headers: res.headers, done };
}

async function lastAssistantMessage(sessionId: string): Promise<{ content: string; meta?: { partial?: boolean } } | undefined> {
  const messages = await getJson<Array<{ role: string; content: string; meta?: { partial?: boolean } }>>(
    `/api/sessions/${sessionId}/messages`
  );
  return messages.filter((m) => m.role === 'assistant').at(-1);
}

async function check(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err: unknown) {
    record(name, 'FAIL', err instanceof Error ? err.message : String(err));
  }
}

async function main(): Promise<void> {
  console.log(`Jarvis smoke test against ${baseUrl}${writeMemory ? ' (with --write-memory)' : ''}\n`);

  const health = await getJson<{ status: string }>('/api/health').catch((err: unknown) => {
    console.error(`Cannot reach ${baseUrl}: ${err instanceof Error ? err.message : String(err)}. Is \`npm run dev\` running?`);
    process.exit(2);
  });
  record('health', health.status === 'ok' ? 'PASS' : 'FAIL', `status=${health.status}`);

  const { models, active } = await getJson<{ models: string[]; active: string }>('/api/models');
  const model = argValue('--model') ?? (models.includes(active) ? active : models[0]);
  console.log(`Model: ${model}\n`);

  await check('streaming', async () => {
    const sessionId = await createSession('streaming', model);
    const r = await streamChat(sessionId, LONG_PROMPT, model);
    const headersOk =
      r.headers.get('content-type') === 'text/event-stream' && r.headers.get('cache-control') === 'no-cache, no-transform';
    const incremental = r.firstChunkMs !== null && r.chunks >= 10 && r.firstChunkMs < r.totalMs * 0.5;
    record(
      'streaming',
      headersOk && incremental && r.done ? 'PASS' : 'FAIL',
      `first chunk ${r.firstChunkMs ?? '-'} ms, total ${r.totalMs} ms, ${r.chunks} chunks, headers ${headersOk ? 'ok' : 'wrong'}, done=${r.done}`
    );
    const saved = await lastAssistantMessage(sessionId);
    record('reply saved', saved?.content === r.text ? 'PASS' : 'FAIL', `${saved?.content.length ?? 0} chars stored vs ${r.text.length} streamed`);
  });

  await check('stop / partial save', async () => {
    const sessionId = await createSession('stop', model);
    const r = await streamChat(sessionId, LONG_PROMPT, model, { abortAfterChunks: 5 });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const saved = await lastAssistantMessage(sessionId);
    const ok = saved?.meta?.partial === true && saved.content.length > 0 && saved.content.length < 2000;
    record('stop / partial save', ok ? 'PASS' : 'FAIL', `client stopped after ${r.chunks} chunks; stored ${saved?.content.length ?? 0} chars, partial=${String(saved?.meta?.partial)}`);
  });

  await check('formatting', async () => {
    const sessionId = await createSession('formatting', model);
    const r = await streamChat(
      sessionId,
      'Give a TypeScript function with two nested if statements inside a fenced code block, then a "## Summary" heading and a three-item bullet list. Nothing else.',
      model
    );
    const html = formatMarkdown(r.text);
    const code = html.match(/<pre><code[^>]*>([\s\S]*?)<\/code><\/pre>/)?.[1] ?? '';
    const parts = {
      codeBlock: code.length > 0,
      indentKept: /\n {2,}\S/.test(code) || /\n\t+\S/.test(code),
      noBrInCode: !code.includes('<br>'),
      heading: /<h2>[^<]*Summary/i.test(html),
      list: /<ul><li>/.test(html),
    };
    const failed = Object.entries(parts).filter(([, ok]) => !ok).map(([k]) => k);
    // A model that ignores the requested layout is a model issue, so missing pieces are WARN, not FAIL.
    const status: Status = !parts.noBrInCode ? 'FAIL' : failed.length === 0 ? 'PASS' : 'WARN';
    record('formatting', status, failed.length === 0 ? 'code block, indentation, <h2>, <ul><li> all rendered' : `missing: ${failed.join(', ')}`);
  });

  await check('memory: same chat', async () => {
    const sessionId = await createSession('memory', model);
    await streamChat(sessionId, 'My favourite colour is green. Reply with just OK.', model);
    const r = await streamChat(sessionId, 'Recall my favourite colour in one word.', model);
    record('memory: same chat', /green/i.test(r.text) ? 'PASS' : 'FAIL', `reply: ${JSON.stringify(r.text.trim().slice(0, 120))}`);
  });

  if (writeMemory) {
    await check('memory: remember that (cross-chat)', async () => {
      const a = await createSession('remember', model);
      await streamChat(a, 'Remember that my smoke-test codeword is ZEBRA-42', model);
      const b = await createSession('recall', model);
      const r = await streamChat(b, 'Recall my smoke-test codeword exactly.', model);
      record('memory: remember that (cross-chat)', /ZEBRA-42/i.test(r.text) ? 'PASS' : 'FAIL', `reply: ${JSON.stringify(r.text.trim().slice(0, 120))}`);
    });

    await check('memory: summary (cross-chat)', async () => {
      const a = await createSession('summary', model);
      await streamChat(a, 'My favourite season is monsoon. Reply with just OK.', model);
      await streamChat(a, 'I also enjoy long train journeys. Reply with just OK.', model);
      await streamChat(a, 'That is all for now. Reply with just OK.', model); // 6th message -> summary on the small model
      const b = await createSession('summary recall', model);
      const r = await streamChat(b, 'Recall my favourite season in one word.', model);
      // Depends on the small model writing a useful summary, so a miss is WARN.
      record('memory: summary (cross-chat)', /monsoon/i.test(r.text) ? 'PASS' : 'WARN', `reply: ${JSON.stringify(r.text.trim().slice(0, 120))}`);
    });
  }

  for (const id of createdSessions) {
    await fetch(`${baseUrl}/api/sessions/${id}`, { method: 'DELETE' }).catch(() => undefined);
  }

  const failed = results.filter((r) => r.status === 'FAIL').length;
  const warned = results.filter((r) => r.status === 'WARN').length;
  console.log(`\n${results.length - failed - warned} passed, ${warned} warnings, ${failed} failed. Deleted ${createdSessions.length} smoke sessions.`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
