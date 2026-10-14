/**
 * Execution sandbox for generated skills: static analysis plus a `node:vm` context that runs inside a
 * `node:worker_threads` worker, so a runaway loop, microtask spin or memory blow-up can be killed and capped.
 */

import { Worker } from 'node:worker_threads';

const DEFAULT_TIMEOUT_MS = 1_000;
const DEFAULT_MAX_OUTPUT_CHARS = 64 * 1024;
const DEFAULT_MEMORY_MB = 64;
const WORKER_GRACE_MS = 750;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

interface ForbiddenRule {
  pattern: RegExp;
  label: string;
}

const FORBIDDEN_RULES: ForbiddenRule[] = [
  { pattern: /\beval\b/, label: 'eval' },
  { pattern: /\bFunction\b/, label: 'Function constructor' },
  { pattern: /\.\s*constructor\b|\[\s*['"`]\s*constructor/, label: 'constructor access (sandbox escape)' },
  { pattern: /__proto__|__defineGetter__|__defineSetter__|__lookupGetter__/, label: 'prototype internals' },
  { pattern: /\b(?:Reflect|Proxy)\b/, label: 'Reflect/Proxy' },
  { pattern: /\b(?:globalThis|global|window)\b/, label: 'global object access' },
  { pattern: /\bprocess\b/, label: 'process' },
  { pattern: /\brequire\b/, label: 'require' },
  { pattern: /\bimport\b/, label: 'import (static or dynamic)' },
  { pattern: /\bchild_process\b/, label: 'child_process' },
  { pattern: /['"`](?:node:)?(?:fs|fs\/promises|net|http|https|http2|dgram|dns|tls|os|vm|worker_threads|cluster|inspector|repl|readline|v8|perf_hooks|zlib)['"`]/, label: 'node builtin module' },
  { pattern: /\b(?:XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b/, label: 'network API' },
  { pattern: /\b(?:WebAssembly|SharedArrayBuffer|Atomics)\b/, label: 'WebAssembly/shared memory' },
  { pattern: /\b(?:setTimeout|setInterval|setImmediate|queueMicrotask)\b/, label: 'timers/microtask scheduling' },
  { pattern: /\b(?:ArrayBuffer|DataView|(?:Big)?(?:Int|Uint)(?:8|16|32|64)(?:Clamped)?Array|Float(?:32|64)Array)\b/, label: 'binary buffers (outside the memory cap)' },
  { pattern: /\b(?:Deno|Bun)\b/, label: 'alternative runtime globals' },
  { pattern: /\brm\s+-rf\b|\bformat\s+c:|\bdel\s+\/[fsq]\b|\bpowershell\b|\bcmd\.exe\b/i, label: 'destructive shell command text' },
  { pattern: /\bprocess\.exit\s*\(/, label: 'process.exit' },
];

export interface AnalysisOptions {
  /** Hosts a literal-URL `fetch(...)` may target. Empty by default: no network. The runtime sandbox has no `fetch` either way. */
  allowedFetchHosts?: string[];
}

export interface AnalysisResult {
  forbidden: string[];
}

/**
 * Static analysis, defence in depth in front of the vm sandbox. Scans the raw source (comments are not stripped, because a `//`
 * inside a string literal would otherwise hide code after it).
 */
export function analyzeSkillCode(code: string, options: AnalysisOptions = {}): AnalysisResult {
  const forbidden: string[] = [];
  for (const rule of FORBIDDEN_RULES) {
    if (rule.pattern.test(code)) forbidden.push(`Forbidden construct detected: ${rule.label}`);
  }

  const allowedHosts = new Set((options.allowedFetchHosts ?? []).map((h) => h.toLowerCase()));
  const fetchCalls = code.match(/\bfetch\b/g)?.length ?? 0;
  if (fetchCalls > 0) {
    const literalCalls = Array.from(code.matchAll(/\bfetch\s*\(\s*['"`](https?:\/\/[^'"`\s/]+)/g));
    const allLiteralAndAllowed = literalCalls.length === fetchCalls && literalCalls.every((m) => allowedHosts.has(hostOf(m[1])));
    if (!allLiteralAndAllowed) forbidden.push('Forbidden construct detected: fetch to a non-allowed or non-literal host');
  }
  return { forbidden };
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** Picks the function the sandbox should call: `run`, then `main`, then the first declared function or function-valued const. */
export function detectEntryPoint(code: string): string | undefined {
  const declared = (name: string): boolean =>
    new RegExp(`\\bfunction\\s*\\*?\\s*${name}\\s*\\(|\\b(?:const|let|var)\\s+${name}\\s*=`).test(code);
  if (declared('run')) return 'run';
  if (declared('main')) return 'main';
  const fn = code.match(/\b(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/);
  if (fn) return fn[1];
  const arrow = code.match(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/);
  return arrow ? arrow[1] : undefined;
}

export interface SandboxRunOptions {
  entryPoint?: string;
  /** JSON-serialisable input passed to the entry function. Omit to only compile and load the code. */
  input?: unknown;
  timeoutMs?: number;
  maxOutputChars?: number;
  memoryLimitMb?: number;
}

export interface SandboxRunResult {
  ok: boolean;
  /** True when the code compiled, ran its top level and exposed a callable entry point. */
  loaded: boolean;
  output?: unknown;
  error?: string;
  logs: string[];
  durationMs: number;
}

/**
 * `resourceLimits.maxOldGenerationSizeMb` bounds only the V8 heap; `ArrayBuffer` backing stores live outside it, so
 * 30 x `new Uint8Array(256 MiB)` would pass a 64 MiB limit. Removing every constructor that can allocate one (and
 * `WebAssembly.Memory`) from the context is what keeps the cap honest. Plain arrays and strings still hit the heap limit.
 */
const BINARY_GLOBALS = [
  'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Atomics', 'WebAssembly',
  'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array',
  'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
];

// Runs inside the worker as CommonJS (`eval: true`). Only strings cross into the vm context, so no host function
// or object is reachable from skill code; `codeGeneration.strings: false` additionally disables in-context `eval`/`Function`.
const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');
const finish = (message) => parentPort.postMessage(message);
(function main() {
try {
  const { code, entry, inputJson, timeoutMs, maxOutputChars } = workerData;
  const ctx = vm.createContext(Object.create(null), {
    name: 'jarvis-skill',
    codeGeneration: { strings: false, wasm: false },
    microtaskMode: 'afterEvaluate',
  });
  const run = (source) => vm.runInContext(source, ctx, { timeout: timeoutMs, displayErrors: false });
  run('(function (names) { for (var i = 0; i < names.length; i++) { try { delete this[names[i]]; } catch (e) {} } }).call(this, ' + JSON.stringify(workerData.binaryGlobals) + ');');
  run(
    'var module = { exports: {} }; var exports = module.exports; var __logs = [];' +
    'var console = { log: function () { var parts = []; for (var i = 0; i < arguments.length; i++) { try { parts.push(String(arguments[i])); } catch (e) { parts.push("[unprintable]"); } }' +
    'if (__logs.length < 50) __logs.push(parts.join(" ").slice(0, 500)); } };' +
    'console.info = console.warn = console.error = console.debug = console.log;'
  );
  const readLogs = () => { try { return JSON.parse(run('JSON.stringify(__logs)')); } catch { return []; } };

  try {
    new vm.Script(code, { filename: 'skill.js' }).runInContext(ctx, { timeout: timeoutMs, displayErrors: false });
  } catch (err) {
    finish({ ok: false, loaded: false, error: String((err && err.message) || err), logs: readLogs() });
    return;
  }

  const resolver = entry
    ? 'var __fn = (typeof ' + entry + ' === "function") ? ' + entry + ' : (module.exports && typeof module.exports.' + entry + ' === "function") ? module.exports.' + entry + ' : (typeof module.exports === "function" ? module.exports : undefined);'
    : 'var __fn = typeof module.exports === "function" ? module.exports : undefined;';
  run(resolver);
  if (run('typeof __fn') !== 'function') {
    finish({ ok: false, loaded: false, error: 'No callable entry point was found' + (entry ? ' (looked for ' + entry + ')' : ''), logs: readLogs() });
    return;
  }

  if (inputJson === undefined) {
    finish({ ok: true, loaded: true, logs: readLogs() });
    return;
  }

  run('var __input = ' + JSON.stringify(inputJson) + '; var __state = { done: false, out: undefined, err: undefined };');
  run(
    '(function () { try { var r = __fn(JSON.parse(__input));' +
    'Promise.resolve(r).then(function (v) { try { __state.out = JSON.stringify(v === undefined ? null : v); } catch (e) { __state.err = "result is not JSON-serialisable"; } __state.done = true; },' +
    'function (e) { __state.err = String((e && e.message) || e); __state.done = true; }); }' +
    'catch (e) { __state.err = String((e && e.message) || e); __state.done = true; } })();'
  );

  const logs = readLogs();
  if (run('__state.done') !== true) {
    finish({ ok: false, loaded: true, error: 'Skill did not settle (pending promise)', logs });
    return;
  }
  const err = run('__state.err');
  if (typeof err === 'string') {
    finish({ ok: false, loaded: true, error: err, logs });
    return;
  }
  const out = run('__state.out');
  if (typeof out === 'string' && out.length > maxOutputChars) {
    finish({ ok: false, loaded: true, error: 'Output exceeds ' + maxOutputChars + ' characters', logs });
    return;
  }
  finish({ ok: true, loaded: true, outputJson: out, logs });
} catch (err) {
  finish({ ok: false, loaded: false, error: String((err && err.message) || err), logs: [] });
}
})();
`;

interface WorkerMessage {
  ok: boolean;
  loaded: boolean;
  error?: string;
  outputJson?: string;
  logs: string[];
}

/** Compiles and (when `input` is given) calls the skill's entry point in an isolated, time- and memory-limited sandbox. Never throws. */
export function runInSandbox(code: string, options: SandboxRunOptions = {}): Promise<SandboxRunResult> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const entry = options.entryPoint ?? detectEntryPoint(code);
  const fail = (error: string, loaded = false): SandboxRunResult => ({ ok: false, loaded, error, logs: [], durationMs: Date.now() - started });

  if (entry !== undefined && !IDENTIFIER.test(entry)) {
    return Promise.resolve(fail(`Invalid entry point name '${entry}'`));
  }
  let inputJson: string | undefined;
  if (options.input !== undefined) {
    try {
      inputJson = JSON.stringify(options.input);
    } catch {
      return Promise.resolve(fail('Sample input is not JSON-serialisable'));
    }
    if (inputJson === undefined) return Promise.resolve(fail('Sample input is not JSON-serialisable'));
  }

  return new Promise<SandboxRunResult>((resolve) => {
    let settled = false;
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { code, entry, inputJson, timeoutMs, binaryGlobals: BINARY_GLOBALS, maxOutputChars: options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS },
      resourceLimits: { maxOldGenerationSizeMb: options.memoryLimitMb ?? DEFAULT_MEMORY_MB, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 },
      stdout: false,
      stderr: false,
    });
    const finish = (result: SandboxRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(wall);
      void worker.terminate();
      resolve(result);
    };
    const wall = setTimeout(() => finish(fail(`Skill exceeded the ${timeoutMs}ms wall-clock limit`, true)), timeoutMs + WORKER_GRACE_MS);

    worker.once('message', (msg: WorkerMessage) => {
      let output: unknown;
      if (msg.ok && msg.outputJson !== undefined) {
        try {
          output = JSON.parse(msg.outputJson);
        } catch {
          finish({ ok: false, loaded: true, error: 'Skill output was not valid JSON', logs: msg.logs, durationMs: Date.now() - started });
          return;
        }
      }
      finish({ ok: msg.ok, loaded: msg.loaded, output, error: msg.error, logs: msg.logs ?? [], durationMs: Date.now() - started });
    });
    worker.once('error', (err: Error) => finish(fail(/memory|heap/i.test(err.message) ? 'Skill exceeded its memory limit' : err.message, true)));
    worker.once('exit', (exitCode) => finish(fail(`Sandbox worker exited unexpectedly (code ${exitCode})`)));
  });
}
